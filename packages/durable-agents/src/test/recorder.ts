/**
 * LLM Response Recorder Middleware & Replay.
 *
 * - `createRecorderMiddleware` is an AI SDK V3 language model middleware that
 *   tees the `doStream` response, captures all chunks, and writes them to a
 *   pluggable storage backend.
 *
 * - `createReplayModel` takes a recording and produces a `MockLanguageModelV3`
 *   that replays the captured chunks deterministically.
 *
 * Use `wrapLanguageModel` from `ai` to apply the middleware to any model:
 *
 * @example Recording
 * ```ts
 * import { wrapLanguageModel } from "ai";
 * import { createRecorderMiddleware } from "@tokenspace/convex-durable-agents/test";
 *
 * const recorder = createRecorderMiddleware({
 *   storage: { write: async (recording) => { ... } },
 * });
 * const model = wrapLanguageModel({ model: realModel, middleware: recorder });
 * ```
 *
 * @example Replay
 * ```ts
 * import { createReplayModel } from "@tokenspace/convex-durable-agents/test";
 *
 * const model = createReplayModel(recording);
 * const result = streamText({ model, prompt: "Hello" });
 * ```
 */
import type {
  LanguageModelV3Middleware,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";

// ============================================================================
// Types
// ============================================================================

export interface LLMRecordingMetadata {
  /** Model ID from the provider */
  modelId?: string;
  /** Provider name */
  provider?: string;
  /** ISO timestamp of when the recording was captured */
  timestamp: string;
  /** Number of chunks in the recording */
  chunkCount: number;
  /** Hash or summary of the input messages for correlation */
  inputSummary?: string;
}

export interface LLMRecording {
  /** Recording format version */
  version: 1;
  /** Metadata about the recording */
  metadata: LLMRecordingMetadata;
  /** The captured stream chunks in order */
  chunks: LanguageModelV3StreamPart[];
}

/**
 * Pluggable storage backend for recordings.
 * Implement `write` to persist recordings wherever you want (Convex table,
 * session filesystem, local file, etc.).
 */
export interface RecorderStorage {
  write(recording: LLMRecording): Promise<void> | void;
}

export interface RecorderMiddlewareOptions {
  /** Where to write the recording */
  storage: RecorderStorage;
  /** Optional: summarize input for the metadata (default: message count) */
  summarizeInput?: (params: { messages?: unknown[]; prompt?: unknown }) => string;
}

// ============================================================================
// Recorder Middleware
// ============================================================================

/**
 * Create an AI SDK V3 middleware that records all `doStream` responses.
 *
 * The middleware tees the response stream: the original consumer sees the
 * stream unmodified, while a second reader collects all chunks. On stream
 * completion, the collected chunks are written to the provided storage.
 */
export function createRecorderMiddleware(options: RecorderMiddlewareOptions): LanguageModelV3Middleware {
  const { storage, summarizeInput } = options;

  return {
    specificationVersion: "v3",

    wrapStream: async ({ doStream, params, model }) => {
      const result = await doStream();
      const capturedChunks: LanguageModelV3StreamPart[] = [];

      // Tee the stream: one branch for the consumer, one for recording
      const [consumerStream, recorderStream] = result.stream.tee();

      // Collect chunks in the background
      const recordingPromise = (async () => {
        const reader = recorderStream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            capturedChunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }

        // Build and persist the recording
        const inputSummary = summarizeInput
          ? summarizeInput({
              messages: params.prompt as unknown[],
              prompt: params.prompt,
            })
          : `${Array.isArray(params.prompt) ? params.prompt.length : 1} messages`;

        const recording: LLMRecording = {
          version: 1,
          metadata: {
            modelId: model.modelId,
            provider: model.provider,
            timestamp: new Date().toISOString(),
            chunkCount: capturedChunks.length,
            inputSummary,
          },
          chunks: capturedChunks,
        };

        await storage.write(recording);
      })();

      // Ensure recording errors don't crash the main stream
      recordingPromise.catch((err) => {
        console.error("[LLM Recorder] Failed to write recording:", err);
      });

      return {
        ...result,
        stream: consumerStream,
      } satisfies LanguageModelV3StreamResult;
    },
  };
}

// ============================================================================
// Replay Model
// ============================================================================

export interface ReplayModelOptions {
  /** Provider name reported by the replay model (default: "replay") */
  provider?: string;
  /** Model ID reported by the replay model (default from recording or "replay-model") */
  modelId?: string;
  /** Delay in ms before the first chunk (default: null = no delay) */
  initialDelayInMs?: number | null;
  /** Delay in ms between chunks (default: null = no delay) */
  chunkDelayInMs?: number | null;
}

/**
 * Create a `MockLanguageModelV3` that replays a previously recorded LLM response.
 *
 * The model will stream the exact same chunks that were captured during recording,
 * enabling fully deterministic test execution.
 *
 * For multi-turn replay, pass an array of recordings. Each `doStream` call
 * consumes the next recording in order (last one repeats).
 */
export function createReplayModel(
  recordings: LLMRecording | LLMRecording[],
  options?: ReplayModelOptions,
): MockLanguageModelV3 {
  const recordingList = Array.isArray(recordings) ? recordings : [recordings];
  const {
    provider = "replay",
    modelId = recordingList[0]?.metadata.modelId ?? "replay-model",
    initialDelayInMs = null,
    chunkDelayInMs = null,
  } = options ?? {};

  let callIndex = 0;

  return new MockLanguageModelV3({
    provider,
    modelId,
    doStream: async (): Promise<LanguageModelV3StreamResult> => {
      const idx = Math.min(callIndex, recordingList.length - 1);
      callIndex++;
      const recording = recordingList[idx]!;

      return {
        stream: simulateReadableStream({
          chunks: recording.chunks,
          initialDelayInMs,
          chunkDelayInMs,
        }),
      };
    },
  });
}
