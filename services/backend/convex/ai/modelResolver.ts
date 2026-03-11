import type { ActionCtx } from "@tokenspace/convex-durable-agents";
import { gateway, wrapLanguageModel } from "ai";
import { internal } from "../_generated/api";
import { createTestMockModel } from "./mockModel";
import { createRecorderMiddleware, isRecordingEnabled } from "./recorder";
import { parseReplayModelId } from "./replayUtils";

type ResolveLanguageModelArgs = {
  threadId: string;
  chatMeta: {
    rootThreadId?: string;
  } | null;
  modelId: string;
  retryAttempt?: number;
};

async function maybeWrapWithRecorder(ctx: ActionCtx, args: ResolveLanguageModelArgs, selectedModel: any): Promise<any> {
  if (!isRecordingEnabled()) {
    return selectedModel;
  }
  if (parseReplayModelId(args.modelId) !== null) {
    return selectedModel;
  }

  const recordingId = args.chatMeta?.rootThreadId ?? args.threadId;
  return wrapLanguageModel({
    model: selectedModel,
    middleware: createRecorderMiddleware({
      recordingId,
      onStreamCaptured: async (capture) => {
        await ctx.runMutation(internal.ai.replay.appendLlmRecordingStream, {
          recordingId: capture.recordingId,
          sourceThreadId: args.threadId,
          modelId: capture.modelId,
          provider: capture.provider,
          userMessageCount: capture.userMessageCount,
          userMessageText: capture.userMessageText,
          chunks: capture.chunks,
          recordedAt: capture.recordedAt,
        });
      },
    }),
  });
}

export async function resolveLanguageModelForAgent(
  ctx: ActionCtx,
  args: ResolveLanguageModelArgs,
): Promise<{ selectedModel: any; usingMockModel: boolean }> {
  const usingMockModel = process.env.TOKENSPACE_MOCK_LLM === "true";
  const baseModel = usingMockModel
    ? createTestMockModel({ modelId: args.modelId, retryAttempt: args.retryAttempt })
    : gateway(args.modelId);
  const selectedModel = await maybeWrapWithRecorder(ctx, args, baseModel);
  return { selectedModel, usingMockModel };
}
