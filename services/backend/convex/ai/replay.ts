import {
  type ActionCtx,
  createAsyncTool,
  defineInternalAgentApi,
  type MessageReceivedCallbackArgs,
  type StreamHandlerArgs,
  streamHandlerAction,
} from "@tokenspace/convex-durable-agents";
import { v } from "convex/values";
import { z } from "zod";
import { components, internal } from "../_generated/api";
import { internalMutation, internalQuery } from "../_generated/server";
import { getDefaultWorkspaceModels, resolveWorkspaceModelSelection } from "../workspaceMetadata";
import { INSTRUCTIONS } from "./agent";
import type { ReplayRuntimeStateSnapshot } from "./mockModel";
import { vReplayPlaybackSettings, vReplayState, vReplayToolOutcome } from "./replaySchema";
import {
  countReplayStreams,
  encodeReplayModelId,
  getReplayModelId,
  getReplayModelProvider,
  normalizeReplayConversation,
  normalizeReplayPlaybackSettings,
  normalizeReplayToolOutcomes,
  parseReplayModelId,
  type ReplayConversationRecording,
  type ReplayPlaybackSettings,
} from "./replayUtils";

const readFileTool = createAsyncTool({
  description:
    "Read a file from the filesystem. Use this to read API definitions (*.d.ts), documentation, and memory files.",
  args: z.object({
    path: z.string().describe("Relative path to the file within the filesystem"),
    startLine: z
      .number()
      .optional()
      .describe("Starting line number (1-indexed). If omitted, reads from the beginning."),
    lineCount: z.number().optional().describe("Number of lines to read. If omitted, reads to the end."),
  }),
  callback: internal.ai.tools.replayToolCall,
});

const writeFileTool = createAsyncTool({
  description:
    "Write a file to the filesystem memory directory. Use this to save notes, state, and artifacts that should persist across conversation turns.",
  args: z.object({
    path: z.string().describe("Relative path within memory/ for the file"),
    content: z.string().describe("Content to write to the file"),
    append: z.boolean().optional().describe("If true, append to existing file instead of overwriting"),
  }),
  callback: internal.ai.tools.replayToolCall,
});

const bashTool = createAsyncTool({
  description: `Execute bash commands in a virtual shell environment.
The filesystem is mounted at /sandbox and has read-only base files with writes captured in a session-scoped overlay.
Supports common bash commands like ls, cat, grep, find, echo, etc.
For full details about this tool, read the SKILL.md file in the /sandbox/system/skills/bash skill directory.`,
  args: z.object({
    description: z.string().optional().describe("Short description of what you are trying to do. 1 sentence max."),
    command: z.string().describe("The bash command to execute"),
    cwd: z
      .string()
      .optional()
      .describe("Working directory relative to /sandbox (e.g., 'docs' for /sandbox/docs). Defaults to root."),
    timeoutMs: z
      .number()
      .optional()
      .describe("Optional timeout in milliseconds for this command. If omitted, a default timeout is used."),
  }),
  callback: internal.ai.tools.replayToolCall,
});

const runCodeTool = createAsyncTool({
  description: `Execute TypeScript code in the runtime environment.
Nothing can be imported - no Node.js or Bun APIs or external modules are available, no require() function is available.
Only APIs defined in /sandbox/builtins.d.ts and capabilities are available as globals.
Capability APIs are namespace globals by capability name (e.g. \`splunk.searchSplunk({...})\`).
builtins.d.ts provides APIs to interact with the session, filesystem, and run bash commands from TypeScript.
Use console.log() to output results.`,
  args: z.object({
    description: z.string().optional().describe("Short description of the code to execute. 1 sentence max."),
    code: z
      .string()
      .describe(
        "TypeScript code to execute. Capability APIs are namespace globals (e.g. splunk.searchSplunk({...})); no imports needed.",
      ),
    timeoutMs: z
      .number()
      .optional()
      .describe("Optional timeout in milliseconds for this execution. If omitted, a default timeout is used."),
  }),
  callback: internal.ai.tools.replayToolCall,
});

const requestApprovalTool = createAsyncTool({
  description: `Request human approval for an action that requires it.
Call this when code execution fails with an APPROVAL_REQUIRED error.
The user will be prompted to approve or deny the action in the chat interface.`,
  args: z.object({
    action: z.string().describe("The action identifier (e.g., 'domain:actionName') from the error details"),
    data: z.any().optional().describe("Arbitrary key-value pairs for matching against pre-approvals"),
    info: z.any().optional().describe("Optional context information for the approval request"),
    description: z.string().optional().describe("Optional description of the action to be performed"),
    reason: z.string().describe("Explain to the user why this action is needed and what it will do"),
  }),
  callback: internal.ai.tools.replayToolCall,
});

const subAgentTool = createAsyncTool({
  description: `Spawn a sub-agent to work on a subtask. The sub-agent shares your filesystem
and can make changes that you'll be able to see. Use this for:
- Breaking complex tasks into parallel subtasks
- Delegating focused work to keep context clean`,
  args: z.object({
    prompt: z.string().optional().describe("Instructions for the sub-agent. Be specific about what to accomplish."),
    contextMode: z
      .enum(["none", "summary", "full"])
      .optional()
      .describe(
        "How much parent context to pass: 'none' (default), 'summary' (condensed history), 'full' (complete messages)",
      ),
    threadId: z.string().optional().describe("Existing sub-agent thread ID."),
    threadIds: z.array(z.string()).optional().describe("Existing sub-agent thread IDs."),
    waitForResult: z
      .boolean()
      .optional()
      .describe("If true (default), wait for completion. If false, spawn and continue immediately."),
    profile: z
      .enum(["default", "web_search"])
      .optional()
      .describe("Sub-agent profile. Use 'web_search' for a web-search-only specialist."),
    storeTranscript: z.boolean().optional().describe("Store transcript for this sub-agent interaction."),
  }),
  callback: internal.ai.tools.replayToolCall,
});

const replayTools = {
  readFile: readFileTool,
  writeFile: writeFileTool,
  bash: bashTool,
  runCode: runCodeTool,
  requestApproval: requestApprovalTool,
  subAgent: subAgentTool,
};

export type ReplayStateSnapshot = {
  turnIndex: number;
  streamIndex: number;
  toolOutcomeIndex?: number;
  currentTurnSignature?: string;
  lastCompletedTurnSignature?: string;
};

function compareReplayPosition(
  a: Pick<ReplayStateSnapshot, "turnIndex" | "streamIndex">,
  b: Pick<ReplayStateSnapshot, "turnIndex" | "streamIndex">,
): number {
  if (a.turnIndex !== b.turnIndex) {
    return a.turnIndex - b.turnIndex;
  }
  return a.streamIndex - b.streamIndex;
}

export function mergeReplayState(
  current: ReplayStateSnapshot | undefined,
  incoming: ReplayStateSnapshot,
): ReplayStateSnapshot {
  const currentState: ReplayStateSnapshot = {
    turnIndex: Math.max(0, Math.floor(current?.turnIndex ?? 0)),
    streamIndex: Math.max(0, Math.floor(current?.streamIndex ?? 0)),
    toolOutcomeIndex: current?.toolOutcomeIndex,
    currentTurnSignature: current?.currentTurnSignature,
    lastCompletedTurnSignature: current?.lastCompletedTurnSignature,
  };
  const incomingState: ReplayStateSnapshot = {
    turnIndex: Math.max(0, Math.floor(incoming.turnIndex)),
    streamIndex: Math.max(0, Math.floor(incoming.streamIndex)),
    toolOutcomeIndex: incoming.toolOutcomeIndex,
    currentTurnSignature: incoming.currentTurnSignature,
    lastCompletedTurnSignature: incoming.lastCompletedTurnSignature,
  };

  const useIncoming = compareReplayPosition(incomingState, currentState) >= 0;
  const selected = useIncoming ? incomingState : currentState;
  const currentTool = currentState.toolOutcomeIndex;
  const incomingTool = incomingState.toolOutcomeIndex;
  const mergedToolOutcomeIndex =
    typeof currentTool === "number" || typeof incomingTool === "number"
      ? Math.max(currentTool ?? 0, incomingTool ?? 0)
      : undefined;

  return {
    turnIndex: selected.turnIndex,
    streamIndex: selected.streamIndex,
    ...(mergedToolOutcomeIndex !== undefined ? { toolOutcomeIndex: mergedToolOutcomeIndex } : {}),
    currentTurnSignature:
      selected.currentTurnSignature ?? currentState.currentTurnSignature ?? incomingState.currentTurnSignature,
    lastCompletedTurnSignature:
      selected.lastCompletedTurnSignature ??
      currentState.lastCompletedTurnSignature ??
      incomingState.lastCompletedTurnSignature,
  };
}

const DEFAULT_MODEL = "anthropic/claude-opus-4.6";

export const replayAgentHandler = streamHandlerAction(
  components.durable_agents,
  async (ctx: ActionCtx, threadId: string): Promise<StreamHandlerArgs> => {
    const threadMeta: any = await ctx.runQuery(internal.ai.chat.getChatMeta, { threadId });
    const selectedModelId = threadMeta?.modelId ?? DEFAULT_MODEL;
    let model = selectedModelId;
    if (threadMeta?.revisionId && selectedModelId) {
      const revision = await ctx.runQuery(internal.revisions.getRevision, {
        revisionId: threadMeta.revisionId,
      });
      const modelConfig = resolveWorkspaceModelSelection(
        revision?.models ?? getDefaultWorkspaceModels(),
        selectedModelId,
      );
      if (modelConfig) {
        model = modelConfig.modelId;
      }
    }
    const replayModeEnabled = process.env.TOKENSPACE_REPLAY_LLM === "true";
    const replayId = parseReplayModelId(model);

    if (replayId === null) {
      throw new Error(`Replay handler requires a replay model, received "${model}".`);
    }
    if (!replayModeEnabled) {
      throw new Error("Replay model selected but replay mode is disabled. Set TOKENSPACE_REPLAY_LLM=true.");
    }

    const replayData = await ctx.runQuery(internal.ai.replay.getReplayRecordingById, {
      recordingId: replayId,
    });
    let pendingReplayState: ReplayRuntimeStateSnapshot | null = null;
    const { createTestMockModel } = await import("./mockModel");
    const selectedModel: any = createTestMockModel({
      modelId: model,
      replayRecording: replayData?.recording ?? null,
      replayPlaybackSettings: replayData?.playbackSettings,
      initialReplayState: threadMeta?.replayState,
      onReplayStateChange: async (replayState) => {
        pendingReplayState = replayState;
      },
    });

    return {
      model: selectedModel,
      system: INSTRUCTIONS,
      tools: replayTools,
      saveStreamDeltas: threadMeta?.parentThreadId == null,
      onMessageComplete: async (callbackCtx: ActionCtx, callbackArgs: MessageReceivedCallbackArgs) => {
        await callbackCtx.runMutation(internal.ai.chat.recordUsage, callbackArgs);
        if (pendingReplayState) {
          await callbackCtx.runMutation(internal.ai.replay.updateReplayState, {
            threadId,
            replayState: pendingReplayState,
          });
          pendingReplayState = null;
        }
      },
    };
  },
);

const replayInternalAgentApi = defineInternalAgentApi(
  components.durable_agents,
  internal.ai.replay.replayAgentHandler,
  {
    onStatusChange: internal.ai.chat.onStatusChange,
  },
);

export const createReplayDurableThread = replayInternalAgentApi.createThread;

function coerceReplayRecording(input: unknown): ReplayConversationRecording {
  const normalized = normalizeReplayConversation(input);
  if (!normalized) {
    throw new Error("Invalid replay recording payload");
  }
  return normalized;
}

function coerceReplayPlaybackSettings(input: unknown): ReplayPlaybackSettings | undefined {
  return normalizeReplayPlaybackSettings(input);
}

export const updateReplayState = internalMutation({
  args: {
    threadId: v.string(),
    replayState: vReplayState,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_thread_id", (q) => q.eq("threadId", args.threadId))
      .first();
    if (!chat) {
      throw new Error(`Chat not found for thread: ${args.threadId}`);
    }

    await ctx.db.patch(chat._id, {
      replayState: mergeReplayState(chat.replayState, args.replayState),
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const appendLlmRecordingStream = internalMutation({
  args: {
    recordingId: v.string(),
    sourceThreadId: v.optional(v.string()),
    modelId: v.optional(v.string()),
    provider: v.optional(v.string()),
    userMessageCount: v.number(),
    userMessageText: v.optional(v.string()),
    chunks: v.array(v.any()),
    recordedAt: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.chunks.length === 0) {
      return null;
    }

    const now = Date.now();
    const nowIso = args.recordedAt ?? new Date(now).toISOString();
    const existing = await ctx.db
      .query("llmRecordings")
      .withIndex("by_recording_id", (q) => q.eq("recordingId", args.recordingId))
      .first();

    const existingRecording = existing ? normalizeReplayConversation(existing.recording) : null;
    const recording: ReplayConversationRecording = existingRecording ?? {
      version: 2,
      metadata: {
        recordingId: args.recordingId,
        timestamp: nowIso,
      },
      turns: [],
    };

    const metadata: Record<string, unknown> = { ...(recording.metadata ?? {}) };
    if (typeof metadata.timestamp !== "string") {
      metadata.timestamp = nowIso;
    }
    if (typeof metadata.createdAt !== "string") {
      metadata.createdAt = nowIso;
    }
    metadata.updatedAt = nowIso;
    if (args.modelId && typeof metadata.modelId !== "string") {
      metadata.modelId = args.modelId;
    }
    if (args.provider && typeof metadata.provider !== "string") {
      metadata.provider = args.provider;
    }

    const lastTurn = recording.turns[recording.turns.length - 1];
    if (!lastTurn || lastTurn.userMessageCount !== args.userMessageCount) {
      recording.turns.push({
        userMessageCount: Math.max(0, Math.floor(args.userMessageCount)),
        userMessageText: args.userMessageText,
        streams: [],
      });
    } else if (!lastTurn.userMessageText && args.userMessageText) {
      lastTurn.userMessageText = args.userMessageText;
    }

    recording.turns[recording.turns.length - 1]!.streams.push({ chunks: args.chunks });
    recording.metadata = metadata;

    const turnCount = recording.turns.length;
    const streamCount = countReplayStreams(recording);
    const modelId = args.modelId ?? getReplayModelId(recording);
    const provider = args.provider ?? getReplayModelProvider(recording);

    if (existing) {
      await ctx.db.patch(existing._id, {
        displayName: existing.displayName,
        showInReplayModelPicker: existing.showInReplayModelPicker ?? false,
        playbackSettings: coerceReplayPlaybackSettings(existing.playbackSettings),
        toolOutcomes: normalizeReplayToolOutcomes(existing.toolOutcomes),
        sourceThreadId: args.sourceThreadId ?? existing.sourceThreadId,
        modelId: modelId ?? existing.modelId,
        provider: provider ?? existing.provider,
        recording,
        turnCount,
        streamCount,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("llmRecordings", {
        recordingId: args.recordingId,
        displayName: undefined,
        showInReplayModelPicker: false,
        playbackSettings: undefined,
        toolOutcomes: [],
        sourceThreadId: args.sourceThreadId,
        modelId,
        provider,
        recording,
        turnCount,
        streamCount,
        createdAt: now,
        updatedAt: now,
      });
    }

    return null;
  },
});

export const consumeReplayToolOutcome = internalMutation({
  args: {
    threadId: v.string(),
    toolCallId: v.string(),
    toolName: v.string(),
    toolArgs: v.optional(v.any()),
  },
  returns: v.union(
    v.object({
      status: v.literal("result"),
      result: v.any(),
    }),
    v.object({
      status: v.literal("error"),
      error: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const threadContext = await ctx.runQuery(internal.ai.thread.getThreadContext, {
      threadId: args.threadId,
    });
    if (!threadContext) {
      throw new Error(`Thread not found: ${args.threadId}`);
    }

    const rootChat = await ctx.runQuery(internal.ai.chat.getChatById, {
      chatId: threadContext.rootChatId,
    });
    if (!rootChat) {
      throw new Error(`Root chat not found for thread: ${args.threadId}`);
    }

    const selectedModelId = rootChat.modelId ?? "";
    let modelId = selectedModelId;
    if (rootChat.revisionId && selectedModelId) {
      const revision = await ctx.runQuery(internal.revisions.getRevision, {
        revisionId: rootChat.revisionId,
      });
      const modelConfig = resolveWorkspaceModelSelection(
        revision?.models ?? getDefaultWorkspaceModels(),
        selectedModelId,
      );
      if (modelConfig) {
        modelId = modelConfig.modelId;
      }
    }
    const replayId = parseReplayModelId(modelId);
    if (!replayId) {
      throw new Error("Replay tool outcome requested for non-replay chat");
    }

    const entry = await ctx.db
      .query("llmRecordings")
      .withIndex("by_recording_id", (q) => q.eq("recordingId", replayId))
      .first();
    if (!entry) {
      throw new Error(`Replay recording not found: ${replayId}`);
    }

    const outcomes = normalizeReplayToolOutcomes(entry.toolOutcomes);
    const nextIndex = Math.max(0, Math.floor(rootChat.replayState?.toolOutcomeIndex ?? 0));
    const nextOutcome = outcomes[nextIndex];
    if (!nextOutcome) {
      throw new Error(`Replay recording "${replayId}" is missing tool outcome #${nextIndex + 1} for ${args.toolName}.`);
    }
    if (nextOutcome.toolName !== args.toolName) {
      throw new Error(
        `Replay tool mismatch: expected "${nextOutcome.toolName}" but got "${args.toolName}" at index ${nextIndex + 1}.`,
      );
    }
    if (nextOutcome.toolCallId !== args.toolCallId) {
      throw new Error(
        `Replay tool call mismatch: expected "${nextOutcome.toolCallId}" but got "${args.toolCallId}" at index ${nextIndex + 1}.`,
      );
    }

    const currentReplayState = rootChat.replayState;
    await ctx.db.patch(rootChat._id, {
      replayState: mergeReplayState(currentReplayState, {
        turnIndex: Math.max(0, Math.floor(currentReplayState?.turnIndex ?? 0)),
        streamIndex: Math.max(0, Math.floor(currentReplayState?.streamIndex ?? 0)),
        toolOutcomeIndex: nextIndex + 1,
        currentTurnSignature: currentReplayState?.currentTurnSignature,
        lastCompletedTurnSignature: currentReplayState?.lastCompletedTurnSignature,
      }),
      updatedAt: Date.now(),
    });

    if (nextOutcome.status === "error") {
      return {
        status: "error" as const,
        error: nextOutcome.error ?? "Replay tool error",
      };
    }
    return {
      status: "result" as const,
      result: nextOutcome.result,
    };
  },
});

export const getReplayRecordingById = internalQuery({
  args: {
    recordingId: v.string(),
  },
  returns: v.union(
    v.object({
      recording: v.any(),
      playbackSettings: v.optional(vReplayPlaybackSettings),
      toolOutcomes: v.array(vReplayToolOutcome),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const entry = await ctx.db
      .query("llmRecordings")
      .withIndex("by_recording_id", (q) => q.eq("recordingId", args.recordingId))
      .first();
    if (!entry) {
      return null;
    }
    const recording = normalizeReplayConversation(entry.recording);
    if (!recording) {
      return null;
    }
    return {
      recording,
      playbackSettings: coerceReplayPlaybackSettings(entry.playbackSettings),
      toolOutcomes: normalizeReplayToolOutcomes(entry.toolOutcomes),
    };
  },
});

export const listReplayModelConfigs = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      recordingId: v.string(),
      modelId: v.string(),
      name: v.string(),
      turnCount: v.number(),
      streamCount: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const entries = await ctx.db.query("llmRecordings").withIndex("by_updated_at").order("desc").collect();
    const models = entries
      .map((entry) => {
        if (entry.showInReplayModelPicker !== true) {
          return null;
        }
        const recording = normalizeReplayConversation(entry.recording);
        if (!recording) {
          return null;
        }
        const displayName = entry.displayName?.trim() || entry.recordingId;
        return {
          recordingId: entry.recordingId,
          modelId: encodeReplayModelId(entry.recordingId),
          name: `Replay: ${displayName}`,
          turnCount: recording.turns.length,
          streamCount: countReplayStreams(recording),
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    models.sort((a, b) => a.recordingId.localeCompare(b.recordingId));
    return models;
  },
});

export const listReplayRecordingsForExport = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      recordingId: v.string(),
      displayName: v.optional(v.string()),
      showInReplayModelPicker: v.boolean(),
      playbackSettings: v.optional(vReplayPlaybackSettings),
      toolOutcomes: v.array(vReplayToolOutcome),
      recording: v.any(),
    }),
  ),
  handler: async (ctx) => {
    const entries = await ctx.db.query("llmRecordings").collect();
    const recordings = entries
      .map((entry) => {
        const recording = normalizeReplayConversation(entry.recording);
        if (!recording) {
          return null;
        }
        return {
          recordingId: entry.recordingId,
          displayName: entry.displayName,
          showInReplayModelPicker: entry.showInReplayModelPicker === true,
          playbackSettings: coerceReplayPlaybackSettings(entry.playbackSettings),
          toolOutcomes: normalizeReplayToolOutcomes(entry.toolOutcomes),
          recording,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    recordings.sort((a, b) => a.recordingId.localeCompare(b.recordingId));
    return recordings;
  },
});

export const upsertReplayRecordingFixture = internalMutation({
  args: {
    recordingId: v.string(),
    recording: v.any(),
    sourceThreadId: v.optional(v.string()),
    displayName: v.optional(v.string()),
    showInReplayModelPicker: v.optional(v.boolean()),
    playbackSettings: v.optional(vReplayPlaybackSettings),
    toolOutcomes: v.optional(v.array(vReplayToolOutcome)),
  },
  returns: v.object({
    recordingId: v.string(),
    turnCount: v.number(),
    streamCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const recording = coerceReplayRecording(args.recording);
    const playbackSettings = coerceReplayPlaybackSettings(args.playbackSettings);
    const toolOutcomes = normalizeReplayToolOutcomes(args.toolOutcomes);
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    const metadata: Record<string, unknown> = { ...(recording.metadata ?? {}) };
    if (typeof metadata.timestamp !== "string") {
      metadata.timestamp = nowIso;
    }
    recording.metadata = metadata;

    const turnCount = recording.turns.length;
    const streamCount = countReplayStreams(recording);
    const modelId = getReplayModelId(recording);
    const provider = getReplayModelProvider(recording);

    const existing = await ctx.db
      .query("llmRecordings")
      .withIndex("by_recording_id", (q) => q.eq("recordingId", args.recordingId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        displayName: args.displayName ?? existing.displayName,
        showInReplayModelPicker: args.showInReplayModelPicker ?? existing.showInReplayModelPicker ?? false,
        playbackSettings: playbackSettings ?? coerceReplayPlaybackSettings(existing.playbackSettings),
        toolOutcomes: toolOutcomes.length > 0 ? toolOutcomes : normalizeReplayToolOutcomes(existing.toolOutcomes),
        sourceThreadId: args.sourceThreadId ?? existing.sourceThreadId,
        modelId: modelId ?? existing.modelId,
        provider: provider ?? existing.provider,
        recording,
        turnCount,
        streamCount,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("llmRecordings", {
        recordingId: args.recordingId,
        displayName: args.displayName,
        showInReplayModelPicker: args.showInReplayModelPicker ?? false,
        playbackSettings,
        toolOutcomes,
        sourceThreadId: args.sourceThreadId,
        modelId,
        provider,
        recording,
        turnCount,
        streamCount,
        createdAt: now,
        updatedAt: now,
      });
    }

    return {
      recordingId: args.recordingId,
      turnCount,
      streamCount,
    };
  },
});

export const appendLlmRecordingToolOutcome = internalMutation({
  args: {
    recordingId: v.string(),
    sourceThreadId: v.optional(v.string()),
    toolCallId: v.string(),
    toolName: v.string(),
    args: v.optional(v.any()),
    status: v.union(v.literal("result"), v.literal("error")),
    result: v.optional(v.any()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    let existing = await ctx.db
      .query("llmRecordings")
      .withIndex("by_recording_id", (q) => q.eq("recordingId", args.recordingId))
      .first();
    if (!existing) {
      const now = Date.now();
      const docId = await ctx.db.insert("llmRecordings", {
        recordingId: args.recordingId,
        displayName: undefined,
        showInReplayModelPicker: false,
        playbackSettings: undefined,
        toolOutcomes: [],
        sourceThreadId: args.sourceThreadId,
        modelId: undefined,
        provider: undefined,
        recording: {},
        turnCount: 0,
        streamCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      existing = await ctx.db.get(docId);
      if (!existing) {
        return null;
      }
    }

    const toolOutcomes = normalizeReplayToolOutcomes(existing.toolOutcomes);
    const alreadyRecorded = toolOutcomes.some((outcome) => outcome.toolCallId === args.toolCallId);
    if (!alreadyRecorded) {
      toolOutcomes.push({
        toolCallId: args.toolCallId,
        toolName: args.toolName,
        args: args.args,
        status: args.status,
        result: args.result,
        error: args.error,
      });
    }

    await ctx.db.patch(existing._id, {
      sourceThreadId: args.sourceThreadId ?? existing.sourceThreadId,
      toolOutcomes,
      updatedAt: Date.now(),
    });
    return null;
  },
});
