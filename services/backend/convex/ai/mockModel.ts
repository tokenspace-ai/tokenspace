/**
 * Test-mode mock model for the agent handler.
 *
 * When the `TOKENSPACE_MOCK_LLM` environment variable is set to "true",
 * the agent handler uses a MockLanguageModelV3 instead of a real LLM provider.
 *
 * Mock behavior is controlled by the chat's `modelId` field:
 *
 * - `mock:text:<message>` — returns a text response with the given message
 * - `mock:slowtext:<delayMs>:<message>` — returns text with per-chunk delay
 * - `mock:echo` — echoes back the last user message
 * - `mock:replay:<recordingName>` — replays a multi-turn recording passed in by the caller
 * - `mock:error` — simulates a model error
 * - `mock:flaky:<failures>:<error>:<message>` — throws `<error>` for N calls, then returns `<message>`
 * - `mock:partialflaky:<failures>:<partialText>:<error>:<message>` — emits partial output + error for N calls, then returns `<message>`
 * - Any other value — returns a default "Mock response" text
 *
 * This module is dynamically imported only when needed,
 * so it has minimal impact on production code execution.
 */
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import {
  extractPromptUserInfo,
  parseReplayModelId,
  type ReplayConversationRecording,
  type ReplayPlaybackSettings,
  type StreamPart,
} from "./replayUtils";

type FinishReasonUnified = "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";

interface ReplayRuntimeState {
  turnIndex: number;
  streamIndex: number;
  currentTurnSignature: string | null;
  lastCompletedTurnSignature: string | null;
}

export interface ReplayRuntimeStateSnapshot {
  turnIndex: number;
  streamIndex: number;
  currentTurnSignature?: string;
  lastCompletedTurnSignature?: string;
}

// ============================================================================
// Chunk builders (inlined to avoid cross-package dependency in Convex bundle)
// ============================================================================

function finishChunk(unified: FinishReasonUnified = "stop"): StreamPart {
  return {
    type: "finish",
    finishReason: { unified, raw: undefined },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 20, text: 20, reasoning: undefined },
    },
  };
}

function textChunks(text: string): StreamPart[] {
  const id = "text-1";
  const words = text.split(" ");
  const chunks: StreamPart[] = [{ type: "text-start", id }];
  for (let i = 0; i < words.length; i++) {
    const delta = i === 0 ? words[i]! : ` ${words[i]}`;
    chunks.push({ type: "text-delta", id, delta });
  }
  chunks.push({ type: "text-end", id });
  chunks.push(finishChunk("stop"));
  return chunks;
}

function parseSlowTextPayload(value: string): { delayMs: number; text: string } | null {
  const separatorIndex = value.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    return null;
  }

  const delayRaw = value.slice(0, separatorIndex);
  const text = value.slice(separatorIndex + 1);
  const delayMs = Number.parseInt(delayRaw, 10);
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    return null;
  }

  return { delayMs, text };
}

function errorChunks(): StreamPart[] {
  return [{ type: "error", error: { message: "Mock model error" } }];
}

function partialErrorChunks(text: string, errorMessage: string): StreamPart[] {
  const id = "text-1";
  return [
    { type: "text-start", id },
    { type: "text-delta", id, delta: text },
    { type: "error", error: { message: errorMessage } },
  ];
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseFlakyPayload(value: string): { failures: number; errorMessage: string; text: string } | null {
  const parts = value.split(":");
  if (parts.length < 3) {
    return null;
  }
  const failures = Number.parseInt(parts[0]!, 10);
  if (!Number.isFinite(failures) || failures < 0) {
    return null;
  }
  const errorMessage = decodeSegment(parts[1]!);
  const text = decodeSegment(parts.slice(2).join(":"));
  return { failures, errorMessage, text };
}

function parsePartialFlakyPayload(
  value: string,
): { failures: number; partialText: string; errorMessage: string; text: string } | null {
  const parts = value.split(":");
  if (parts.length < 4) {
    return null;
  }
  const failures = Number.parseInt(parts[0]!, 10);
  if (!Number.isFinite(failures) || failures < 0) {
    return null;
  }
  const partialText = decodeSegment(parts[1]!);
  const errorMessage = decodeSegment(parts[2]!);
  const text = decodeSegment(parts.slice(3).join(":"));
  return { failures, partialText, errorMessage, text };
}

function createDefaultReplayRuntimeState(): ReplayRuntimeState {
  return {
    turnIndex: 0,
    streamIndex: 0,
    currentTurnSignature: null,
    lastCompletedTurnSignature: null,
  };
}

function toReplayRuntimeState(snapshot: ReplayRuntimeStateSnapshot | null | undefined): ReplayRuntimeState {
  if (!snapshot) {
    return createDefaultReplayRuntimeState();
  }
  return {
    turnIndex: Math.max(0, Math.floor(snapshot.turnIndex)),
    streamIndex: Math.max(0, Math.floor(snapshot.streamIndex)),
    currentTurnSignature: snapshot.currentTurnSignature ?? null,
    lastCompletedTurnSignature: snapshot.lastCompletedTurnSignature ?? null,
  };
}

function toReplayRuntimeSnapshot(state: ReplayRuntimeState): ReplayRuntimeStateSnapshot {
  return {
    turnIndex: state.turnIndex,
    streamIndex: state.streamIndex,
    ...(state.currentTurnSignature !== null ? { currentTurnSignature: state.currentTurnSignature } : {}),
    ...(state.lastCompletedTurnSignature !== null
      ? { lastCompletedTurnSignature: state.lastCompletedTurnSignature }
      : {}),
  };
}

function createReplayState(recording: ReplayConversationRecording, runtimeState: ReplayRuntimeState) {
  return {
    nextChunks(prompt: unknown): StreamPart[] {
      const turn = recording.turns[runtimeState.turnIndex];
      if (!turn) {
        return textChunks("[Mock replay completed]");
      }

      const promptInfo = extractPromptUserInfo(prompt);
      if (runtimeState.streamIndex === 0) {
        const signature = `${promptInfo.userMessageCount}|${promptInfo.lastUserMessageText ?? ""}`;
        if (runtimeState.turnIndex > 0 && signature === runtimeState.lastCompletedTurnSignature) {
          throw new Error(
            `[Mock Replay] Waiting for the next user message before replay turn ${runtimeState.turnIndex + 1}.`,
          );
        }
        runtimeState.currentTurnSignature = signature;
      }

      const stream = turn.streams[runtimeState.streamIndex];
      if (!stream) {
        throw new Error(
          `[Mock Replay] Missing recorded stream ${runtimeState.streamIndex + 1} for turn ${runtimeState.turnIndex + 1}.`,
        );
      }

      runtimeState.streamIndex += 1;
      if (runtimeState.streamIndex >= turn.streams.length) {
        runtimeState.streamIndex = 0;
        runtimeState.turnIndex += 1;
        runtimeState.lastCompletedTurnSignature = runtimeState.currentTurnSignature;
      }

      return stream.chunks;
    },
  };
}

// ============================================================================
// Mock model factory
// ============================================================================

export interface MockScenarioContext {
  /** The modelId from chat metadata */
  modelId: string;
  /** Optional durable retry attempt count for this invocation (0-based) */
  retryAttempt?: number;
  /** Optional replay recording payload for replay mode */
  replayRecording?: ReplayConversationRecording | null;
  /** Optional playback settings for replay mode */
  replayPlaybackSettings?: ReplayPlaybackSettings;
  /** Optional persisted replay state loaded from chat metadata */
  initialReplayState?: ReplayRuntimeStateSnapshot | null;
  /** Optional callback to persist replay progress after each stream */
  onReplayStateChange?: (state: ReplayRuntimeStateSnapshot) => Promise<void> | void;
}

/**
 * Parse the modelId to determine mock behavior.
 */
function parseScenario(
  modelId: string,
):
  | { type: "text"; text: string; chunkDelayInMs: number | null }
  | { type: "replay"; replayId: string }
  | { type: "flaky"; failures: number; errorMessage: string; text: string }
  | { type: "partial-flaky"; failures: number; partialText: string; errorMessage: string; text: string }
  | { type: "echo" }
  | { type: "error" }
  | { type: "default" } {
  if (modelId.startsWith("mock:text:")) {
    return { type: "text", text: modelId.slice("mock:text:".length), chunkDelayInMs: null };
  }
  if (modelId.startsWith("mock:slowtext:")) {
    const parsed = parseSlowTextPayload(modelId.slice("mock:slowtext:".length));
    if (parsed) {
      return { type: "text", text: parsed.text, chunkDelayInMs: parsed.delayMs };
    }
  }
  if (modelId.startsWith("mock:flaky:")) {
    const parsed = parseFlakyPayload(modelId.slice("mock:flaky:".length));
    if (parsed) {
      return { type: "flaky", ...parsed };
    }
  }
  if (modelId.startsWith("mock:partialflaky:")) {
    const parsed = parsePartialFlakyPayload(modelId.slice("mock:partialflaky:".length));
    if (parsed) {
      return { type: "partial-flaky", ...parsed };
    }
  }

  const replayId = parseReplayModelId(modelId);
  if (replayId !== null) {
    return { type: "replay", replayId };
  }

  if (modelId === "mock:echo") {
    return { type: "echo" };
  }
  if (modelId === "mock:error") {
    return { type: "error" };
  }
  return { type: "default" };
}

/**
 * Create a MockLanguageModelV3 based on the scenario context.
 */
export function createTestMockModel(context: MockScenarioContext): MockLanguageModelV3 {
  const scenario = parseScenario(context.modelId);
  const replayRuntimeState = toReplayRuntimeState(context.initialReplayState);
  const retryAttempt = Math.max(0, Math.floor(context.retryAttempt ?? 0));
  const replayState =
    scenario.type === "replay" && context.replayRecording
      ? createReplayState(context.replayRecording, replayRuntimeState)
      : null;

  return new MockLanguageModelV3({
    provider: "mock",
    modelId: context.modelId,
    doStream: async (options) => {
      let chunks: StreamPart[];
      let initialDelayInMs: number | null = null;
      let chunkDelayInMs: number | null = null;
      let replaySnapshotToPersist: ReplayRuntimeStateSnapshot | null = null;

      switch (scenario.type) {
        case "text":
          chunks = textChunks(scenario.text);
          chunkDelayInMs = scenario.chunkDelayInMs;
          break;

        case "replay":
          if (replayState) {
            chunks = replayState.nextChunks(options.prompt);
            initialDelayInMs = context.replayPlaybackSettings?.initialDelayMs ?? null;
            chunkDelayInMs = context.replayPlaybackSettings?.chunkDelayMs ?? null;
            replaySnapshotToPersist = toReplayRuntimeSnapshot(replayRuntimeState);
          } else {
            chunks = textChunks(`[Mock replay recording not found: ${scenario.replayId}]`);
          }
          break;

        case "echo": {
          const { lastUserMessageText } = extractPromptUserInfo(options.prompt);
          const lastUserText = lastUserMessageText ?? "No user message found";
          chunks = textChunks(`Echo: ${lastUserText}`);
          break;
        }

        case "error":
          chunks = errorChunks();
          break;

        case "flaky":
          if (retryAttempt < scenario.failures) {
            const error = new Error(scenario.errorMessage) as Error & { code?: string };
            if (/econn|connection reset|network|timed out|socket|upstream|fetch failed/i.test(scenario.errorMessage)) {
              error.code = "ECONNRESET";
            }
            throw error;
          }
          chunks = textChunks(scenario.text);
          break;

        case "partial-flaky":
          if (retryAttempt < scenario.failures) {
            chunks = partialErrorChunks(scenario.partialText, scenario.errorMessage);
            break;
          }
          chunks = textChunks(scenario.text);
          break;

        default:
          chunks = textChunks("Mock response");
          break;
      }

      const simulatedStream = simulateReadableStream({
        chunks: chunks as any[],
        initialDelayInMs,
        chunkDelayInMs,
      });

      if (!context.onReplayStateChange || replaySnapshotToPersist === null) {
        return { stream: simulatedStream as any };
      }

      const snapshot = replaySnapshotToPersist;
      let persisted = false;
      const persistReplayState = async () => {
        if (persisted) {
          return;
        }
        persisted = true;
        await context.onReplayStateChange?.(snapshot);
      };

      const reader = simulatedStream.getReader();
      const wrappedStream = new ReadableStream({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            try {
              await persistReplayState();
            } catch (error) {
              console.warn("Failed to persist replay state after stream consumption", error);
            }
            controller.close();
            return;
          }
          controller.enqueue(value);
        },
        async cancel(reason) {
          await reader.cancel(reason);
        },
      });

      return { stream: wrappedStream as any };
    },
  });
}

/**
 * Check if mock LLM mode is enabled.
 */
export function isMockLLMEnabled(): boolean {
  return process.env.TOKENSPACE_MOCK_LLM === "true";
}
