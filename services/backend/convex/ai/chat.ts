import { defineAgentApi, type MessageDoc } from "@tokenspace/convex-durable-agents";
import { gateway, generateText, Output } from "ai";
import { createFunctionHandle, paginationOptsValidator, type UserIdentity } from "convex/server";
import { type Infer, v } from "convex/values";
import z from "zod";
import { components, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  type ActionCtx,
  action,
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from "../_generated/server";
import { requireAuthenticatedUser, requireWorkspaceMember } from "../authz";
import { getDefaultWorkspaceModels, getWorkspaceModelId, resolveWorkspaceModelSelection } from "../workspaceMetadata";
import { summarizerModel } from "./agent";
import { createProviderOptions } from "./provider";
import { maybeRecordToolOutcome } from "./recorder";
import type { vReplayState } from "./replaySchema";
import { parseReplayModelId } from "./replayUtils";

// Validator for model ID
const vModelId = v.optional(v.string());
const vThreadStatus = v.union(
  v.literal("streaming"),
  v.literal("awaiting_tool_results"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("stopped"),
);
const vChatStatus = v.union(vThreadStatus, v.literal("waiting_for_approval"));
type ThreadStatus = Infer<typeof vThreadStatus>;
type ChatStatus = Infer<typeof vChatStatus>;

function normalizeThreadStatus(status: string | undefined): ThreadStatus | null {
  switch (status) {
    case "streaming":
    case "awaiting_tool_results":
    case "completed":
    case "failed":
    case "stopped":
      return status;
    default:
      return null;
  }
}

async function resolveChatStatusFromThread(
  ctx: MutationCtx,
  args: { threadId: string; threadStatusHint?: string },
): Promise<ChatStatus | null> {
  const hintedStatus = normalizeThreadStatus(args.threadStatusHint);
  const threadStatus =
    hintedStatus ??
    (
      await ctx.runQuery(components.durable_agents.threads.get, {
        threadId: args.threadId,
      })
    )?.status;

  if (!threadStatus) return null;
  if (threadStatus !== "awaiting_tool_results") return threadStatus;

  const pendingToolCalls = await ctx.runQuery(components.durable_agents.tool_calls.listPending, {
    threadId: args.threadId,
  });
  const onlyWaitingForApproval =
    pendingToolCalls.length > 0 && pendingToolCalls.every((toolCall) => toolCall.toolName === "requestApproval");

  return onlyWaitingForApproval ? "waiting_for_approval" : threadStatus;
}

async function syncChatStatus(
  ctx: MutationCtx,
  args: { threadId: string; threadStatusHint?: string },
): Promise<ChatStatus | null> {
  const chat = await ctx.db
    .query("chats")
    .withIndex("by_thread_id", (q) => q.eq("threadId", args.threadId))
    .first();
  if (!chat) return null;

  const nextStatus = await resolveChatStatusFromThread(ctx, args);
  if (!nextStatus) return null;

  if (chat.status !== nextStatus) {
    await ctx.db.patch(chat._id, {
      status: nextStatus,
      updatedAt: Date.now(),
    });
  }

  return nextStatus;
}

export const syncChatStatusFromThread = internalMutation({
  args: {
    threadId: v.string(),
    threadStatus: v.optional(v.string()),
  },
  returns: v.union(vChatStatus, v.null()),
  handler: async (ctx, args) => {
    return await syncChatStatus(ctx, {
      threadId: args.threadId,
      threadStatusHint: args.threadStatus,
    });
  },
});

// ============================================================================
// Status Change Callback
// ============================================================================

export const onStatusChange = internalMutation({
  args: {
    threadId: v.string(),
    status: v.string(),
    previousStatus: v.string(),
  },
  handler: async (ctx, args) => {
    await syncChatStatus(ctx, {
      threadId: args.threadId,
      threadStatusHint: args.status,
    });
  },
});

export const addToolResult = internalMutation({
  args: {
    threadId: v.string(),
    toolCallId: v.string(),
    result: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.runMutation(components.durable_agents.tool_calls.addToolResult, {
      threadId: args.threadId,
      toolCallId: args.toolCallId,
      result: args.result,
    });
    await maybeRecordToolOutcome(ctx, {
      type: "result",
      threadId: args.threadId,
      toolCallId: args.toolCallId,
      result: args.result,
    });
    await syncChatStatus(ctx, { threadId: args.threadId });
    return null;
  },
});

export const addToolError = internalMutation({
  args: {
    threadId: v.string(),
    toolCallId: v.string(),
    error: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.runMutation(components.durable_agents.tool_calls.addToolError, {
      threadId: args.threadId,
      toolCallId: args.toolCallId,
      error: args.error,
    });
    await maybeRecordToolOutcome(ctx, {
      type: "error",
      threadId: args.threadId,
      toolCallId: args.toolCallId,
      error: args.error,
    });
    await syncChatStatus(ctx, { threadId: args.threadId });
    return null;
  },
});

const agentApi = defineAgentApi(components.durable_agents, internal.ai.agent.chatAgentHandler, {
  authorizationCallback: async (ctx, threadId) => {
    await checkChatThreadAccess(ctx as QueryCtx | MutationCtx | ActionCtx, threadId);
  },
});
export const getThread = agentApi.getThread;
export const resumeThread = agentApi.resumeThread;
export const listMessages = agentApi.listMessages;
export const sendMessage = agentApi.sendMessage;
export const streamUpdates = agentApi.streamUpdates;

// ============================================================================
// Thread Management
// ============================================================================

async function createChatBase(
  ctx: MutationCtx,
  args: { revisionId: Id<"revisions">; modelId?: Infer<typeof vModelId> | null; userId?: string },
): Promise<{ chatId: Id<"chats">; threadId: string; sessionId: Id<"sessions">; userId: string }> {
  let userId = args.userId;
  if (!userId) {
    const user = await ctx.auth.getUserIdentity();
    if (user == null) throw new Error("User not authenticated");
    userId = user.subject;
  }

  const revision = await ctx.db.get(args.revisionId);
  if (!revision) {
    throw new Error("Revision not found");
  }

  const models = revision.models ?? getDefaultWorkspaceModels();

  // Determine selected model entry ID: use explicit selection, otherwise workspace default.
  let selectedModelId = args.modelId?.trim() || undefined;
  if (!selectedModelId) {
    const defaultModel = models.find((m) => m.isDefault);
    if (defaultModel) {
      selectedModelId = getWorkspaceModelId(defaultModel);
    }
  }

  // Resolve selected entry to runtime provider model ID.
  const selectedModelConfig = selectedModelId ? resolveWorkspaceModelSelection(models, selectedModelId) : null;
  const runtimeModelId = selectedModelConfig?.modelId ?? selectedModelId;

  const replayId = runtimeModelId ? parseReplayModelId(runtimeModelId) : null;
  const useReplayHandlerThread = replayId !== null && process.env.TOKENSPACE_REPLAY_LLM === "true";

  // Create the thread using durable-agents API (now a mutation in 0.1.5)
  const threadId = useReplayHandlerThread
    ? await ctx.runMutation(internal.ai.replay.createReplayDurableThread, {})
    : await ctx.runMutation(internal.ai.thread.createThread, {});

  // Create a session for this thread (for filesystem overlay sharing with sub-agents)
  const sessionId = await ctx.runMutation(internal.sessions.createSession, {
    userId,
    revisionId: args.revisionId,
  });

  const now = Date.now();

  // Create chat entry for the durable-agents thread.
  // This must be created BEFORE sendMessage so the handler factory can look up the modelId.
  const chatId = await ctx.db.insert("chats", {
    threadId,
    sessionId,
    userId,
    workspaceId: revision.workspaceId,
    revisionId: args.revisionId,
    status: "completed",
    messageCount: 0,
    modelId: selectedModelId ?? undefined,
    createdAt: now,
    updatedAt: now,
  });

  await ctx.db.patch(sessionId, {
    chatId,
    updatedAt: now,
    status: "active",
  });

  const dynamicSystemPrompt = await ctx.runQuery(internal.ai.agent.generateDynamicSystemPrompt, {
    revision: args.revisionId,
  });

  if (dynamicSystemPrompt) {
    await ctx.runMutation(internal.ai.thread.addMessage, {
      threadId,
      msg: {
        role: "system",
        parts: [{ type: "text", text: dynamicSystemPrompt }],
      },
    });
  }

  return {
    chatId,
    threadId,
    sessionId,
    userId,
  };
}

/**
 * Create a new chat thread with an initial message and start streaming
 * Threads are scoped to a workspace with optional branch and working state context
 */
export const createChatWithMessage = mutation({
  args: {
    prompt: v.string(),
    modelId: vModelId,
    // workspaceId: v.id("workspaces"),
    // branchId: v.optional(v.id("branches")),
    // workingStateHash: v.optional(v.string()),
    revisionId: v.id("revisions"),
  },
  returns: v.object({ chatId: v.id("chats") }),
  handler: async (ctx, args): Promise<{ chatId: Id<"chats"> }> => {
    const revision = await ctx.db.get(args.revisionId);
    if (!revision) {
      throw new Error("Revision not found");
    }
    await requireWorkspaceMember(ctx, revision.workspaceId);

    const { chatId, threadId, userId } = await createChatBase(ctx, {
      revisionId: args.revisionId,
      modelId: args.modelId ?? undefined,
    });

    await ctx.runMutation(internal.ai.chat.updateChatMeta, {
      threadId,
      incrementMessageCount: true,
    });

    // Send the initial message - this triggers the agent (handler factory reads modelId from chat meta)
    await ctx.runMutation(internal.ai.thread.sendMessage, {
      threadId,
      prompt: args.prompt,
    });

    await ctx.scheduler.runAfter(0, internal.ai.chat.generateChatSummary, {
      threadId,
      userId,
    });

    return { chatId };
  },
});

/**
 * Create a new chat thread without sending a message.
 */
export const createChat = mutation({
  args: {
    modelId: vModelId,
    revisionId: v.id("revisions"),
  },
  returns: v.object({ chatId: v.id("chats"), threadId: v.string(), sessionId: v.id("sessions") }),
  handler: async (ctx, args): Promise<{ chatId: Id<"chats">; threadId: string; sessionId: Id<"sessions"> }> => {
    const revision = await ctx.db.get(args.revisionId);
    if (!revision) {
      throw new Error("Revision not found");
    }
    await requireWorkspaceMember(ctx, revision.workspaceId);

    const { chatId, threadId, sessionId } = await createChatBase(ctx, {
      revisionId: args.revisionId,
      modelId: args.modelId ?? undefined,
    });
    return { chatId, threadId, sessionId };
  },
});

type ChatMeta = {
  _id: Id<"chats">;
  threadId: string;
  sessionId: Id<"sessions">;
  userId: string;
  workspaceId: Id<"workspaces">;
  revisionId: Id<"revisions">;
  title?: string;
  summary?: string;
  createdAt: number;
  messageCount?: number;
  lastUserMessageAt?: number;
  updatedAt: number;
  errorMessage?: string | null;
  status?: ChatStatus;
  modelId?: Infer<typeof vModelId> | null;
  lastProviderMetadata?: unknown;
  replayState?: Infer<typeof vReplayState>;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
  };
};

export const updateChatMeta = internalMutation({
  args: {
    threadId: v.string(),
    title: v.optional(v.string()),
    summary: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    modelId: v.optional(vModelId),
    incrementMessageCount: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<ChatMeta> => {
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_thread_id", (q) => q.eq("threadId", args.threadId))
      .first();
    if (!chat) {
      throw new Error(`Chat not found for thread: ${args.threadId}`);
    }

    const now = Date.now();
    const updates: Record<string, any> = { updatedAt: now };
    if (args.title !== undefined) updates.title = args.title;
    if (args.summary !== undefined) updates.summary = args.summary;
    if (args.errorMessage !== undefined) updates.errorMessage = args.errorMessage;
    if (args.modelId !== undefined) {
      updates.modelId = args.modelId;
      updates.replayState = undefined;
    }
    if (args.incrementMessageCount) {
      updates.messageCount = (chat.messageCount ?? 0) + 1;
      updates.lastUserMessageAt = now;
    }

    await ctx.db.patch(chat._id, updates);
    await ctx.db.patch(chat.sessionId, { updatedAt: now });

    return {
      _id: chat._id,
      threadId: chat.threadId,
      sessionId: chat.sessionId,
      userId: chat.userId,
      workspaceId: chat.workspaceId,
      revisionId: chat.revisionId,
      createdAt: chat.createdAt,
      updatedAt: now,
      title: args.title ?? chat.title,
      summary: args.summary ?? chat.summary,
      messageCount: args.incrementMessageCount ? (chat.messageCount ?? 0) + 1 : chat.messageCount,
      lastUserMessageAt: args.incrementMessageCount ? now : chat.lastUserMessageAt,
      errorMessage: args.errorMessage ?? chat.errorMessage,
      status: chat.status,
      modelId: args.modelId ?? chat.modelId,
      replayState: args.modelId !== undefined ? undefined : chat.replayState,
      usage: chat.usage,
    };
  },
});

export const getChatMeta = internalQuery({
  args: {
    threadId: v.string(),
  },
  handler: async (ctx, args) => {
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_thread_id", (q) => q.eq("threadId", args.threadId))
      .first();
    if (!chat) return null;

    return {
      _id: chat._id,
      threadId: chat.threadId,
      sessionId: chat.sessionId,
      userId: chat.userId,
      workspaceId: chat.workspaceId,
      revisionId: chat.revisionId,
      modelId: chat.modelId,
      title: chat.title,
      summary: chat.summary,
      messageCount: chat.messageCount,
      lastUserMessageAt: chat.lastUserMessageAt,
      errorMessage: chat.errorMessage,
      status: chat.status,
      usage: chat.usage,
      replayState: chat.replayState,
    };
  },
});

export const getChatById = internalQuery({
  args: {
    chatId: v.id("chats"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.chatId);
  },
});

export const updateChatSummary = internalMutation({
  args: {
    threadId: v.string(),
    title: v.string(),
    summary: v.string(),
  },
  handler: async (ctx, args) => {
    const meta = await ctx.runQuery(internal.ai.chat.getChatMeta, { threadId: args.threadId });
    if (!meta) {
      console.warn(`Cannot update summary for non-existent chat: ${args.threadId}`);
      return;
    }

    const now = Date.now();
    await ctx.db.patch(meta._id, {
      title: args.title,
      summary: args.summary,
      updatedAt: now,
    });
    await ctx.db.patch(meta.sessionId, { updatedAt: now });
  },
});

export const updateChatUsage = internalMutation({
  args: {
    threadId: v.string(),
    usage: v.object({
      inputTokens: v.number(),
      outputTokens: v.number(),
      totalTokens: v.number(),
      reasoningTokens: v.optional(v.number()),
      cachedInputTokens: v.optional(v.number()),
      cacheWriteInputTokens: v.optional(v.number()),
    }),
  },
  handler: async (ctx, args) => {
    const meta = await ctx.runQuery(internal.ai.chat.getChatMeta, { threadId: args.threadId });
    if (!meta) {
      console.warn(`Cannot update usage for non-existent chat: ${args.threadId}`);
      return;
    }
    const now = Date.now();
    await ctx.db.patch(meta._id, { usage: args.usage, updatedAt: now });
    await ctx.db.patch(meta.sessionId, { updatedAt: now });
  },
});

export const insertUsageRecord = internalMutation({
  args: {
    userId: v.optional(v.string()),
    threadId: v.optional(v.string()),
    chatId: v.optional(v.id("chats")),
    sessionId: v.optional(v.id("sessions")),
    model: v.string(),
    provider: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    totalTokens: v.number(),
    reasoningTokens: v.optional(v.number()),
    cachedInputTokens: v.optional(v.number()),
    cacheWriteInputTokens: v.optional(v.number()),
    providerMetadata: v.optional(v.any()),
    marketCost: v.optional(v.number()),
    cost: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("usageRecords", {
      userId: args.userId,
      threadId: args.threadId,
      chatId: args.chatId,
      sessionId: args.sessionId,
      model: args.model,
      provider: args.provider,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      totalTokens: args.totalTokens,
      reasoningTokens: args.reasoningTokens,
      cachedInputTokens: args.cachedInputTokens,
      cacheWriteInputTokens: args.cacheWriteInputTokens,
      providerMetadata: args.providerMetadata,
      marketCost: args.marketCost,
      cost: args.cost,
    });
  },
});

export const recordUsage = internalMutation({
  args: {
    threadId: v.string(),
    streamId: v.string(),
    providerMetadata: v.optional(v.any()),
    message: v.any(),
    usage: v.object({
      inputTokens: v.number(),
      outputTokens: v.number(),
      totalTokens: v.number(),
      reasoningTokens: v.optional(v.number()),
      cachedInputTokens: v.optional(v.number()),
      cacheWriteInputTokens: v.optional(v.number()),
    }),
    userId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const meta = await ctx.runQuery(internal.ai.chat.getChatMeta, { threadId: args.threadId });
    const threadContext = await ctx.runQuery(internal.ai.thread.getThreadContext, {
      threadId: args.threadId,
    });
    const now = Date.now();
    if (meta) {
      await ctx.db.patch(meta._id, {
        usage: args.usage,
        updatedAt: now,
        ...(args.providerMetadata !== undefined ? { lastProviderMetadata: args.providerMetadata } : {}),
      });
    }

    const model: string | undefined =
      args.providerMetadata?.gateway?.routing?.resolvedProviderApiModelId ??
      args.providerMetadata?.gateway?.routing?.originalModelId;
    const provider = args.providerMetadata?.gateway?.routing?.resolvedProvider;

    await ctx.runMutation(internal.ai.chat.insertUsageRecord, {
      userId: args.userId,
      threadId: args.threadId,
      chatId: meta?._id,
      sessionId: threadContext?.sessionId,
      model: model ?? "n/a",
      provider: provider ?? "n/a",
      providerMetadata: args.providerMetadata,
      marketCost: tryParseNumber(args.providerMetadata?.gateway?.marketCost),
      cost: tryParseNumber(args.providerMetadata?.gateway?.cost),
      ...args.usage,
    });
  },
});

function tryParseNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number.parseFloat(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

async function checkChatThreadAccess(ctx: QueryCtx | MutationCtx | ActionCtx, _threadId: string) {
  const user = await requireAuthenticatedUser(ctx);
  const chat = await ctx.runQuery(internal.ai.chat.getChatMeta, { threadId: _threadId });
  if (!chat) {
    throw new Error("Chat not found");
  }
  if (chat.userId !== user.subject) {
    throw new Error("Unauthorized");
  }
  return true;
}

async function checkChatAccess(
  ctx: QueryCtx | MutationCtx | ActionCtx,
  chatId: Id<"chats">,
): Promise<{ user: UserIdentity; chat: any } | never> {
  const user = await ctx.auth.getUserIdentity();
  if (user == null) throw new Error("User not authenticated");

  const chat = await ctx.runQuery(internal.ai.chat.getChatById, { chatId });
  if (!chat) {
    throw new Error("Chat not found");
  }
  if (chat.userId !== user.subject) {
    throw new Error("You are not authorized to access this chat");
  }

  return { user, chat };
}

async function requestStopForActiveJobsInThread(
  ctx: MutationCtx,
  args: { threadId: string; reason: string },
): Promise<void> {
  const now = Date.now();

  const pendingJobs = await ctx.db
    .query("jobs")
    .withIndex("by_status_thread", (q) => q.eq("status", "pending").eq("threadId", args.threadId))
    .collect();
  const runningJobs = await ctx.db
    .query("jobs")
    .withIndex("by_status_thread", (q) => q.eq("status", "running").eq("threadId", args.threadId))
    .collect();

  const activeJobs = [...pendingJobs, ...runningJobs];
  for (const job of activeJobs) {
    if (job.stopRequestedAt) continue;
    await ctx.db.patch(job._id, {
      stopRequestedAt: now,
      stopReason: args.reason,
    });
  }
}

// ============================================================================
// Message Operations
// ============================================================================

export const stopThread = mutation({
  args: {
    threadId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await checkChatThreadAccess(ctx, args.threadId);

    const thread = await ctx.runQuery(components.durable_agents.threads.get, {
      threadId: args.threadId,
    });
    if (!thread) {
      throw new Error(`Thread not found: ${args.threadId}`);
    }

    const isRunning = thread.status === "streaming" || thread.status === "awaiting_tool_results";
    if (!isRunning) {
      return null;
    }

    // Set the stop signal so any in-flight agent/tool completion paths short-circuit.
    await ctx.runMutation(components.durable_agents.threads.setStopSignal, {
      threadId: args.threadId,
      stopSignal: true,
    });

    // Mark all active executor jobs tied to this thread for cancellation.
    await requestStopForActiveJobsInThread(ctx, {
      threadId: args.threadId,
      reason: "Stopped by user",
    });

    // Force a stop transition immediately so streaming is interrupted now.
    await ctx.runMutation(components.durable_agents.agent.continueStream, {
      threadId: args.threadId,
    });

    await syncChatStatus(ctx, {
      threadId: args.threadId,
      threadStatusHint: "stopped",
    });
    return null;
  },
});

/**
 * Send a message to an existing chat
 */
export const sendChatMessage = mutation({
  args: {
    chatId: v.id("chats"),
    prompt: v.string(),
  },
  handler: async (ctx, args) => {
    const { user, chat } = await checkChatAccess(ctx, args.chatId);

    // Update message count (handler factory will read modelId from chat meta)
    await ctx.runMutation(internal.ai.chat.updateChatMeta, {
      threadId: chat.threadId,
      incrementMessageCount: true,
    });

    // Send message via durable-agents (model resolved dynamically in handler factory)
    await ctx.runMutation(internal.ai.thread.sendMessage, {
      threadId: chat.threadId,
      prompt: args.prompt,
    });

    await ctx.scheduler.runAfter(0, internal.ai.chat.generateChatSummary, {
      threadId: chat.threadId,
      userId: user.subject,
    });

    return null;
  },
});

/**
 * Retry a chat that is in error state
 */
export const retryChat = mutation({
  args: {
    chatId: v.id("chats"),
  },
  handler: async (ctx, args) => {
    const { chat } = await checkChatAccess(ctx, args.chatId);

    const thread = await ctx.runQuery(internal.ai.thread.getThread, {
      threadId: chat.threadId,
    });

    if (thread?.status !== "failed" && thread?.status !== "stopped") {
      throw new Error("Thread is not in a retryable state");
    }

    // Resume the thread
    await ctx.runMutation(internal.ai.thread.resumeThread, { threadId: chat.threadId });
  },
});

// ============================================================================
// Chat Summary Generation
// ============================================================================

export const regenerateChatSummary = action({
  args: {
    chatId: v.id("chats"),
  },
  handler: async (ctx, args) => {
    const { user, chat } = await checkChatAccess(ctx, args.chatId);
    await ctx.runAction(internal.ai.chat.generateChatSummary, {
      threadId: chat.threadId,
      userId: user.subject,
    });
  },
});

export const generateChatSummary = internalAction({
  args: {
    threadId: v.string(),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    // Get messages from durable-agents using internal API (no auth required)
    const messages: MessageDoc[] = await ctx.runQuery(internal.ai.thread.listMessages, {
      threadId: args.threadId,
    });

    if (!messages || messages.length === 0) return;

    // Convert to model messages format
    const history = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.parts
          .filter((part: any) => part?.type === "text")
          .map((part: any) => part.text || "")
          .join("\n"),
      }))
      .filter((h) => h.content !== "");
    console.log(history);

    const result = await generateText({
      messages: [
        ...history,
        {
          role: "user",
          content:
            "Summarize this thread from the point of view of the user. " +
            "The information is displayed in the list of previous chats " +
            "and the goal is to help the user identify what the conversation was about. " +
            'Do NOT describe what the user did (eg. "User requested..."), ' +
            "instead describe what the conversation as a whole is about.",
        },
      ],
      output: Output.object({
        schema: z.object({
          title: z.string().describe("A short title that describes this thread (2-5 words max)"),
          summary: z.string().describe("A short summary of the thread (one sentence)"),
        }),
      }),
      model: gateway(summarizerModel),
      providerOptions: createProviderOptions({
        modelId: summarizerModel,
        userId: args.userId,
        tags: ["thread-summary"],
      }),
    });

    await ctx.runMutation(internal.ai.chat.updateChatSummary, {
      threadId: args.threadId,
      title: result.output.title,
      summary: result.output.summary,
    });
  },
});

// ============================================================================
// Chat Queries
// ============================================================================

export type ChatUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
};

/**
 * Get comprehensive debug information for a chat
 * Includes session, thread state, raw messages, tool calls, sub-agents, and approvals
 */
export const getChatDebugInfo = query({
  args: { chatId: v.id("chats") },
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) throw new Error("User not authenticated");

    const chat = await ctx.db.get(args.chatId);
    if (!chat) return null;
    if (chat.userId !== user.subject) throw new Error("You are not authorized to access this chat");

    const session = await ctx.db.get(chat.sessionId);
    if (!session) return null;

    // Get durable-agents thread state
    const thread = await ctx.runQuery(components.durable_agents.threads.get, {
      threadId: chat.threadId,
    });

    // Get raw messages from durable-agents
    const messages = await ctx.runQuery(components.durable_agents.messages.list, {
      threadId: chat.threadId,
    });

    // Get all tool calls from durable-agents
    const toolCalls = await ctx.runQuery(components.durable_agents.tool_calls.list, {
      threadId: chat.threadId,
    });

    // Get sub-agents (children of this thread)
    const childSubAgents = await ctx.db
      .query("subAgents")
      .withIndex("by_parent", (q) => q.eq("parentThreadId", chat.threadId))
      .collect();

    // Get parent sub-agent info (if this is a sub-thread)
    const parentSubAgent = await ctx.db
      .query("subAgents")
      .withIndex("by_child", (q) => q.eq("threadId", chat.threadId))
      .first();

    // Get approval requests for this session
    const approvalRequests = await ctx.db
      .query("approvalRequests")
      .withIndex("by_session", (q) => q.eq("sessionId", chat.sessionId))
      .collect();

    // Get granted approvals for this session
    const approvals = await ctx.db
      .query("approvals")
      .withIndex("by_session", (q) => q.eq("sessionId", chat.sessionId))
      .collect();

    return {
      // Chat record
      chat: {
        _id: chat._id,
        threadId: chat.threadId,
        sessionId: chat.sessionId,
        userId: chat.userId,
        workspaceId: chat.workspaceId,
        revisionId: chat.revisionId,
        status: chat.status,
        title: chat.title,
        summary: chat.summary,
        messageCount: chat.messageCount,
        lastUserMessageAt: chat.lastUserMessageAt,
        errorMessage: chat.errorMessage,
        modelId: chat.modelId,
        lastProviderMetadata: chat.lastProviderMetadata,
        usage: chat.usage,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
      },
      // Session data
      session: {
        _id: session._id,
        userId: session.userId,
        revisionId: session.revisionId,
        chatId: session.chatId,
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
      // Durable-agents thread state
      thread: thread
        ? {
            _id: thread._id,
            _creationTime: thread._creationTime,
            status: thread.status,
            stopSignal: thread.stopSignal,
            streamId: thread.streamId,
          }
        : null,
      // Raw messages
      messages: messages.map((m) => ({
        _id: m._id,
        _creationTime: m._creationTime,
        id: m.id,
        role: m.role,
        parts: m.parts,
        metadata: m.metadata,
        threadId: m.threadId,
      })),
      // Tool calls
      toolCalls: toolCalls.map((tc) => ({
        _id: tc._id,
        _creationTime: tc._creationTime,
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.args,
        result: tc.result,
        error: tc.error,
      })),
      // Sub-agent relationships
      subAgents: {
        parent: parentSubAgent
          ? {
              _id: parentSubAgent._id,
              parentThreadId: parentSubAgent.parentThreadId,
              toolCallId: parentSubAgent.toolCallId,
              depth: parentSubAgent.depth,
              status: parentSubAgent.status,
              waitForResult: parentSubAgent.waitForResult,
              result: parentSubAgent.result,
              error: parentSubAgent.error,
              createdAt: parentSubAgent.createdAt,
              completedAt: parentSubAgent.completedAt,
            }
          : null,
        children: childSubAgents.map((sa) => ({
          _id: sa._id,
          threadId: sa.threadId,
          toolCallId: sa.toolCallId,
          depth: sa.depth,
          status: sa.status,
          waitForResult: sa.waitForResult,
          result: sa.result,
          error: sa.error,
          createdAt: sa.createdAt,
          completedAt: sa.completedAt,
        })),
      },
      // Approval requests
      approvalRequests: approvalRequests.map((ar) => ({
        _id: ar._id,
        toolCallId: ar.toolCallId,
        action: ar.action,
        description: ar.description,
        reason: ar.reason,
        status: ar.status,
        data: ar.data,
        info: ar.info,
        createdAt: ar.createdAt,
        resolvedAt: ar.resolvedAt,
        resolvedBy: ar.resolvedBy,
        resolverComment: ar.resolverComment,
      })),
      // Granted approvals
      approvals: approvals.map((a) => ({
        _id: a._id,
        action: a.action,
        data: a.data,
        grantedBy: a.grantedBy,
        grantedAt: a.grantedAt,
        expiresAt: a.expiresAt,
      })),
    };
  },
});

/**
 * Get a single tool call by toolCallId for a chat
 */
export const getToolCall = query({
  args: {
    chatId: v.id("chats"),
    toolCallId: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) throw new Error("User not authenticated");

    const chat = await ctx.db.get(args.chatId);
    if (!chat) return null;
    if (chat.userId !== user.subject) throw new Error("You are not authorized to access this chat");

    // Get the tool call from durable-agents
    const toolCall = await ctx.runQuery(components.durable_agents.tool_calls.getByToolCallId, {
      threadId: chat.threadId,
      toolCallId: args.toolCallId,
    });

    if (!toolCall) return null;

    return {
      _id: toolCall._id,
      _creationTime: toolCall._creationTime,
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      args: toolCall.args,
      result: toolCall.result,
      error: toolCall.error,
    };
  },
});

/**
 * Get chat metadata
 */
export const getChatDetails = query({
  args: { chatId: v.id("chats") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    id: Id<"chats">;
    threadId: string;
    sessionId: Id<"sessions">;
    title: string;
    summary: string | undefined;
    status: ChatStatus | undefined;
    userId: string | undefined;
    createdAt: number | undefined;
    errorMessage: string | undefined;
    usage: ChatUsage | undefined;
    modelId: string | undefined;
    messageCount: number | undefined;
    lastUserMessageAt: number | undefined;
    isStarred: boolean;
  } | null> => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) throw new Error("User not authenticated");

    const chat = await ctx.db.get(args.chatId);
    if (!chat) return null;
    if (chat.userId !== user.subject) {
      throw new Error("You are not authorized to access this chat");
    }

    const starred = await ctx.db
      .query("starredChats")
      .withIndex("by_user_chat", (q) => q.eq("userId", user.subject).eq("chatId", args.chatId))
      .first();

    return {
      id: chat._id,
      threadId: chat.threadId,
      sessionId: chat.sessionId,
      title: chat.title ?? "",
      summary: chat.summary,
      status: chat.status,
      userId: chat.userId,
      createdAt: chat.createdAt,
      errorMessage: chat.errorMessage ?? undefined,
      usage: chat.usage,
      modelId: chat.modelId ?? undefined,
      messageCount: chat.messageCount ?? 0,
      lastUserMessageAt: chat.lastUserMessageAt,
      isStarred: !!starred,
    };
  },
});

/**
 * Update the selected model for a chat
 */
export const updateChatModel = mutation({
  args: {
    chatId: v.id("chats"),
    modelId: v.string(),
  },
  handler: async (ctx, args) => {
    const { chat } = await checkChatAccess(ctx, args.chatId);

    const now = Date.now();
    await ctx.db.patch(chat._id, { modelId: args.modelId, replayState: undefined, updatedAt: now });
    await ctx.db.patch(chat.sessionId, { updatedAt: now });
  },
});

/**
 * Update chat metadata (e.g., title)
 */
export const updateChat = mutation({
  args: {
    chatId: v.id("chats"),
    title: v.optional(v.string()),
    summary: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { chat } = await checkChatAccess(ctx, args.chatId);

    const updates: Record<string, any> = { updatedAt: Date.now() };
    if (args.title !== undefined) updates.title = args.title;
    if (args.summary !== undefined) updates.summary = args.summary;
    await ctx.db.patch(chat._id, updates);
    await ctx.db.patch(chat.sessionId, { updatedAt: Date.now() });

    return { chatId: args.chatId, title: args.title, summary: args.summary };
  },
});

/**
 * Delete a chat and all its messages
 */
export const deleteChat = mutation({
  args: { chatId: v.id("chats") },
  handler: async (ctx, args) => {
    const { chat } = await checkChatAccess(ctx, args.chatId);

    await ctx.runMutation(internal.sessions.deleteSession, {
      sessionId: chat.sessionId as Id<"sessions">,
    });
    await ctx.db.delete(chat._id);

    // Delete the durable-agents thread (handles message cleanup)
    await ctx.runMutation(internal.ai.thread.deleteThread, { threadId: chat.threadId });
  },
});

/**
 * Star a chat for the current user
 */
export const starChat = mutation({
  args: {
    chatId: v.id("chats"),
  },
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();
    if (user == null) throw new Error("User not authenticated");

    // Check if already starred
    const existing = await ctx.db
      .query("starredChats")
      .withIndex("by_user_chat", (q) => q.eq("userId", user.subject).eq("chatId", args.chatId))
      .first();

    if (existing) return; // Already starred

    await ctx.db.insert("starredChats", {
      userId: user.subject,
      chatId: args.chatId,
      createdAt: Date.now(),
    });
  },
});

/**
 * Unstar a chat for the current user
 */
export const unstarChat = mutation({
  args: {
    chatId: v.id("chats"),
  },
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();
    if (user == null) throw new Error("User not authenticated");

    const existing = await ctx.db
      .query("starredChats")
      .withIndex("by_user_chat", (q) => q.eq("userId", user.subject).eq("chatId", args.chatId))
      .first();

    if (existing) {
      await ctx.db.delete(existing._id);
    }
  },
});

/**
 * List chats for the current user in a workspace
 */
export const listChats = query({
  args: {
    workspaceId: v.id("workspaces"),
    paginationOpts: paginationOptsValidator,
  },
  returns: {
    page: v.array(
      v.object({
        id: v.id("chats"),
        title: v.string(),
        summary: v.optional(v.string()),
        userId: v.optional(v.string()),
        status: v.optional(vChatStatus),
        createdAt: v.number(),
        messageCount: v.number(),
        isStarred: v.boolean(),
      }),
    ),
    isDone: v.boolean(),
    continueCursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();
    if (user == null) throw new Error("User not authenticated");

    const result = await ctx.db
      .query("chats")
      .withIndex("by_workspace_user_last_message", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("userId", user.subject),
      )
      .order("desc")
      .paginate(args.paginationOpts);

    // Get all starred chats for this user
    const starredChats = await ctx.db
      .query("starredChats")
      .withIndex("by_user", (q) => q.eq("userId", user.subject))
      .collect();
    const starredChatIds = new Set(starredChats.map((s) => s.chatId));

    return {
      page: result.page.map((chat) => ({
        id: chat._id,
        title: chat.title ?? "",
        summary: chat.summary,
        userId: chat.userId,
        status: chat.status,
        createdAt: chat.createdAt,
        messageCount: chat.messageCount ?? 0,
        isStarred: starredChatIds.has(chat._id),
      })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

/**
 * Get available models for the model picker
 */
export const getAvailableModels = action({
  args: {},
  handler: async (ctx) => {
    await requireAuthenticatedUser(ctx);
    const availableModels = await gateway.getAvailableModels();
    const models: any[] = [...availableModels.models];

    if (process.env.TOKENSPACE_REPLAY_LLM === "true") {
      const replayModels = await ctx.runQuery(internal.ai.replay.listReplayModelConfigs, {});
      if (replayModels.length > 0) {
        models.unshift(
          ...replayModels.map((replay: any) => ({
            id: replay.modelId,
            name: `${replay.name} (${replay.turnCount} turns, ${replay.streamCount} streams)`,
            modelType: "language",
            specification: {
              provider: "synthetic",
            },
          })),
        );
      }
    }

    return models;
  },
});

/**
 * Get usage records for a specific chat, with cumulative sums
 */
export const getChatUsageRecords = query({
  args: { chatId: v.id("chats") },
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) throw new Error("User not authenticated");

    const chat = await ctx.db.get(args.chatId);
    if (!chat) return null;
    if (chat.userId !== user.subject) throw new Error("You are not authorized to access this chat");

    const allRecords = await ctx.db
      .query("usageRecords")
      .withIndex("by_session", (q) => q.eq("sessionId", chat.sessionId))
      .collect();

    // Sort by creation time
    allRecords.sort((a, b) => a._creationTime - b._creationTime);

    // Compute cumulative sums
    const cumulative = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      cost: 0,
      marketCost: 0,
    };

    for (const r of allRecords) {
      cumulative.inputTokens += r.inputTokens;
      cumulative.outputTokens += r.outputTokens;
      cumulative.totalTokens += r.totalTokens;
      cumulative.reasoningTokens += r.reasoningTokens ?? 0;
      cumulative.cachedInputTokens += r.cachedInputTokens ?? 0;
      cumulative.cacheWriteInputTokens += r.cacheWriteInputTokens ?? 0;
      cumulative.cost += r.cost ?? 0;
      cumulative.marketCost += r.marketCost ?? 0;
    }

    return {
      cumulative,
      records: allRecords.map((r) => ({
        _id: r._id,
        _creationTime: r._creationTime,
        model: r.model,
        provider: r.provider,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        totalTokens: r.totalTokens,
        reasoningTokens: r.reasoningTokens,
        cachedInputTokens: r.cachedInputTokens,
        cacheWriteInputTokens: r.cacheWriteInputTokens,
        cost: r.cost,
        marketCost: r.marketCost,
      })),
    };
  },
});

/**
 * Get all usage records (for admin/reporting scripts)
 */
export const getAllUsageRecords = internalQuery({
  args: {
    paginationOpts: paginationOptsValidator,
    afterTimestamp: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const result = await ctx.db.query("usageRecords").order("desc").paginate(args.paginationOpts);

    const filteredPage = args.afterTimestamp
      ? result.page.filter((record) => record._creationTime >= args.afterTimestamp!)
      : result.page;

    const hitTimeLimit = args.afterTimestamp && filteredPage.length < result.page.length;

    return {
      page: filteredPage.map((record) => ({
        ...record,
        createdAt: record._creationTime,
      })),
      isDone: result.isDone || hitTimeLimit,
      continueCursor: result.continueCursor,
    };
  },
});

// ============================================================================
// Internal test helpers (for integration tests that bypass auth)
// ============================================================================

/**
 * Schedule a sync tool call for execution (for integration tests only).
 */
export const scheduleTestSyncToolCall = internalMutation({
  args: {
    threadId: v.string(),
    toolCallId: v.string(),
    toolName: v.string(),
    toolArgs: v.optional(v.any()),
    retry: v.optional(v.any()),
    useRetryClassifier: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const handler = await createFunctionHandle(internal.ai.chat.testSyncToolRetryHandler);
    const shouldRetryError = args.useRetryClassifier
      ? (await createFunctionHandle(internal.ai.chat.testToolRetryClassifier)).toString()
      : undefined;
    const retryRecord = args.retry as Record<string, unknown> | undefined;
    const retry = shouldRetryError
      ? {
          ...(retryRecord ?? {}),
          shouldRetryError,
        }
      : args.retry;

    await ctx.runMutation(components.durable_agents.tool_calls.scheduleToolCall, {
      threadId: args.threadId,
      msgId: `msg-${args.toolCallId}`,
      toolCallId: args.toolCallId,
      toolName: args.toolName,
      args: args.toolArgs ?? {},
      handler: handler.toString(),
      retry,
      saveDelta: false,
    });
    return null;
  },
});

/**
 * Test-only flaky sync tool handler.
 * Fails until executionAttempt exceeds failUntilAttempt.
 */
export const testSyncToolRetryHandler = internalAction({
  args: {
    threadId: v.string(),
    toolCallId: v.string(),
    failUntilAttempt: v.number(),
    errorMessage: v.optional(v.string()),
    result: v.optional(v.any()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const toolCall = await ctx.runQuery(components.durable_agents.tool_calls.getByToolCallId, {
      threadId: args.threadId,
      toolCallId: args.toolCallId,
    });
    if (!toolCall) {
      throw new Error(`Tool call ${args.toolCallId} not found`);
    }

    const attempt = toolCall.executionAttempt ?? 1;
    if (attempt <= args.failUntilAttempt) {
      throw new Error(args.errorMessage ?? "connection reset by peer");
    }

    return args.result ?? { ok: true, attempt };
  },
});

/**
 * Test-only retry classifier for sync tool errors.
 */
export const testToolRetryClassifier = internalAction({
  args: {
    threadId: v.string(),
    toolCallId: v.string(),
    toolName: v.string(),
    args: v.any(),
    error: v.string(),
    attempt: v.number(),
    maxAttempts: v.number(),
  },
  returns: v.union(v.boolean(), v.object({ retryable: v.boolean() })),
  handler: async (_ctx, args) => {
    return { retryable: args.error.toLowerCase().includes("retry-me") };
  },
});

/**
 * Create a pending tool call for a thread (for integration tests only).
 */
export const createTestPendingToolCall = internalMutation({
  args: {
    threadId: v.string(),
    toolCallId: v.string(),
    toolName: v.string(),
    toolArgs: v.optional(v.any()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.runMutation(components.durable_agents.tool_calls.create, {
      threadId: args.threadId,
      msgId: `msg-${args.toolCallId}`,
      toolCallId: args.toolCallId,
      toolName: args.toolName,
      args: args.toolArgs ?? {},
      saveDelta: false,
    });
    return null;
  },
});

/**
 * Set durable thread status and sync chat status (for integration tests only).
 */
export const setTestThreadStatus = internalMutation({
  args: {
    threadId: v.string(),
    status: vThreadStatus,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.runMutation(components.durable_agents.threads.setStatus, {
      threadId: args.threadId,
      status: args.status,
    });
    await syncChatStatus(ctx, {
      threadId: args.threadId,
      threadStatusHint: args.status,
    });
    return null;
  },
});

/**
 * Get a tool call by thread + toolCallId (for integration tests only).
 */
export const getTestToolCall = internalQuery({
  args: {
    threadId: v.string(),
    toolCallId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.runQuery(components.durable_agents.tool_calls.getByToolCallId, {
      threadId: args.threadId,
      toolCallId: args.toolCallId,
    });
  },
});

/**
 * Create a chat thread without authentication (for integration tests only).
 * The TOKENSPACE_MOCK_LLM env var must be set for this to be useful.
 */
export const createTestChat = internalMutation({
  args: {
    revisionId: v.id("revisions"),
    modelId: v.optional(v.string()),
  },
  returns: v.object({
    chatId: v.id("chats"),
    threadId: v.string(),
    sessionId: v.id("sessions"),
  }),
  handler: async (ctx, args): Promise<{ chatId: Id<"chats">; threadId: string; sessionId: Id<"sessions"> }> => {
    const { chatId, threadId, sessionId } = await createChatBase(ctx, {
      revisionId: args.revisionId,
      modelId: args.modelId ?? undefined,
      userId: "test-user",
    });
    return { chatId, threadId, sessionId };
  },
});

/**
 * Send a message to a test chat thread (bypasses auth).
 */
export const sendTestMessage = internalMutation({
  args: {
    threadId: v.string(),
    prompt: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Update chat meta
    await ctx.runMutation(internal.ai.chat.updateChatMeta, {
      threadId: args.threadId,
      incrementMessageCount: true,
    });
    // Send the message which triggers the agent loop
    await ctx.runMutation(internal.ai.thread.sendMessage, {
      threadId: args.threadId,
      prompt: args.prompt,
    });
    return null;
  },
});

/**
 * Get chat status and messages for test assertions.
 */
export const getTestChatStatus = internalQuery({
  args: {
    chatId: v.id("chats"),
  },
  handler: async (ctx, args) => {
    const chat = await ctx.db.get(args.chatId);
    if (!chat) return null;
    return {
      chatId: chat._id,
      threadId: chat.threadId,
      status: chat.status,
      messageCount: chat.messageCount,
      modelId: chat.modelId,
    };
  },
});
