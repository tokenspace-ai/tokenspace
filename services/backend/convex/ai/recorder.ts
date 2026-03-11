import type { LanguageModelMiddleware } from "ai";
import { components, internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import { getDefaultWorkspaceModels, resolveWorkspaceModelSelection } from "../workspaceMetadata";
import { extractPromptUserInfo, parseReplayModelId, type StreamPart } from "./replayUtils";

interface RecorderMiddlewareOptions {
  recordingId: string;
  onStreamCaptured: (capture: {
    recordingId: string;
    modelId?: string;
    provider?: string;
    userMessageCount: number;
    userMessageText?: string;
    chunks: StreamPart[];
    recordedAt: string;
  }) => Promise<void> | void;
}

export type ToolOutcomeCaptureArgs =
  | { type: "result"; threadId: string; toolCallId: string; result: unknown }
  | { type: "error"; threadId: string; toolCallId: string; error: string };

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return value;
}

function toSerializableChunk(chunk: unknown): StreamPart | null {
  if (!chunk || typeof chunk !== "object") {
    return null;
  }
  try {
    const normalized = JSON.parse(JSON.stringify(chunk, jsonReplacer)) as unknown;
    if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
      return null;
    }
    if (typeof (normalized as Record<string, unknown>).type !== "string") {
      return null;
    }
    return normalized as StreamPart;
  } catch {
    return null;
  }
}

/**
 * Check if LLM recording mode is enabled.
 */
export function isRecordingEnabled(): boolean {
  return process.env.TOKENSPACE_RECORD_LLM === "true";
}

export async function maybeRecordToolOutcome(ctx: MutationCtx, args: ToolOutcomeCaptureArgs): Promise<void> {
  if (!isRecordingEnabled()) {
    return;
  }

  const threadContext = await ctx.runQuery(internal.ai.thread.getThreadContext, {
    threadId: args.threadId,
  });
  if (!threadContext) {
    return;
  }

  const selectedModelId =
    threadContext.kind === "subagent"
      ? (threadContext.modelIdOverride ?? threadContext.rootModelId ?? "")
      : (threadContext.modelId ?? "");
  let modelId = selectedModelId;
  if (threadContext.revisionId && selectedModelId) {
    const revision = await ctx.runQuery(internal.revisions.getRevision, {
      revisionId: threadContext.revisionId,
    });
    const modelConfig = resolveWorkspaceModelSelection(
      revision?.models ?? getDefaultWorkspaceModels(),
      selectedModelId,
    );
    if (modelConfig) {
      modelId = modelConfig.modelId;
    }
  }
  if (parseReplayModelId(modelId) !== null) {
    return;
  }

  const recordingId = threadContext.rootThreadId;
  const toolCall = await ctx.runQuery(components.durable_agents.tool_calls.getByToolCallId, {
    threadId: args.threadId,
    toolCallId: args.toolCallId,
  });
  if (!toolCall) {
    return;
  }

  await ctx.runMutation(internal.ai.replay.appendLlmRecordingToolOutcome, {
    recordingId,
    sourceThreadId: args.threadId,
    toolCallId: args.toolCallId,
    toolName: toolCall.toolName,
    args: toolCall.args,
    status: args.type,
    result: args.type === "result" ? args.result : undefined,
    error: args.type === "error" ? args.error : undefined,
  });
}

/**
 * Create an AI SDK V3 middleware that records each doStream response and forwards
 * it to a caller-provided persistence callback.
 */
export function createRecorderMiddleware(options: RecorderMiddlewareOptions): LanguageModelMiddleware {
  return {
    specificationVersion: "v3",
    wrapStream: async ({ doStream, model, params }) => {
      const result = await doStream();
      const [consumerStream, recorderStream] = result.stream.tee();
      const promptInfo = extractPromptUserInfo(params.prompt);

      const recordingPromise = (async () => {
        const chunks: StreamPart[] = [];
        const reader = recorderStream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = toSerializableChunk(value);
            if (chunk) {
              chunks.push(chunk);
            }
          }
        } finally {
          reader.releaseLock();
        }

        if (chunks.length === 0) {
          return;
        }

        await options.onStreamCaptured({
          recordingId: options.recordingId,
          modelId: model.modelId,
          provider: model.provider,
          userMessageCount: promptInfo.userMessageCount,
          userMessageText: promptInfo.lastUserMessageText,
          chunks,
          recordedAt: new Date().toISOString(),
        });
      })();

      recordingPromise.catch((error) => {
        console.error("[LLM Recorder] Failed to persist recording:", error);
      });

      return {
        ...result,
        stream: consumerStream,
      };
    },
  };
}
