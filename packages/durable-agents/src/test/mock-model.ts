/**
 * Mock model helpers for testing the durable agents chat loop.
 *
 * Wraps the AI SDK's `MockLanguageModelV3` and `simulateReadableStream` with
 * convenience builders tailored to the V3 stream chunk format.
 *
 * @example Simple text response
 * ```ts
 * const model = createMockStreamModel(createTextResponseChunks("Hello, world!"));
 * ```
 *
 * @example Tool call followed by text
 * ```ts
 * const model = createMockStreamModel(
 *   createToolCallChunks("readFile", "call-1", { path: "/foo.ts" }),
 *   // After tool result is fed back, the model streams text:
 *   createTextResponseChunks("Here is the file content."),
 * );
 * ```
 */
import type {
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";

// ============================================================================
// Types
// ============================================================================

export type StreamChunk = LanguageModelV3StreamPart;

export interface MockStreamModelOptions {
  /** Provider name reported by the mock (default: "mock") */
  provider?: string;
  /** Model ID reported by the mock (default: "mock-model") */
  modelId?: string;
  /** Delay in ms before the first chunk (default: null = no delay) */
  initialDelayInMs?: number | null;
  /** Delay in ms between chunks (default: null = no delay) */
  chunkDelayInMs?: number | null;
}

// ============================================================================
// Usage helpers
// ============================================================================

/**
 * Build a `LanguageModelV3Usage` object with sensible defaults.
 */
export function createUsage(inputTotal = 10, outputTotal = 20): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: inputTotal,
      noCache: inputTotal,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: outputTotal,
      text: outputTotal,
      reasoning: undefined,
    },
  };
}

/**
 * Build a `LanguageModelV3FinishReason`.
 */
export function createFinishReason(
  unified: LanguageModelV3FinishReason["unified"] = "stop",
): LanguageModelV3FinishReason {
  return { unified, raw: undefined };
}

// ============================================================================
// Chunk builders
// ============================================================================

/**
 * Generate the standard stream chunk sequence for a simple text response.
 *
 * Produces: `text-start` → N × `text-delta` → `text-end` → `finish`
 */
export function createTextResponseChunks(
  text: string,
  options?: {
    textId?: string;
    usage?: LanguageModelV3Usage;
    finishReason?: LanguageModelV3FinishReason;
  },
): StreamChunk[] {
  const id = options?.textId ?? "text-1";
  const words = text.split(" ");
  const chunks: StreamChunk[] = [{ type: "text-start", id }];
  for (let i = 0; i < words.length; i++) {
    const delta = i === 0 ? words[i]! : ` ${words[i]}`;
    chunks.push({ type: "text-delta", id, delta });
  }
  chunks.push({ type: "text-end", id });
  chunks.push({
    type: "finish",
    finishReason: options?.finishReason ?? createFinishReason("stop"),
    usage: options?.usage ?? createUsage(),
  });
  return chunks;
}

/**
 * Generate the stream chunk sequence for a tool call.
 *
 * Produces: `tool-input-start` → `tool-input-delta` (JSON args) → `tool-input-end` → `finish`
 */
export function createToolCallChunks(
  toolName: string,
  toolCallId: string,
  args: Record<string, unknown>,
  options?: {
    usage?: LanguageModelV3Usage;
    finishReason?: LanguageModelV3FinishReason;
  },
): StreamChunk[] {
  const argsJson = JSON.stringify(args);
  return [
    { type: "tool-input-start", id: toolCallId, toolName },
    { type: "tool-input-delta", id: toolCallId, delta: argsJson },
    { type: "tool-input-end", id: toolCallId },
    {
      type: "finish",
      finishReason: options?.finishReason ?? createFinishReason("tool-calls"),
      usage: options?.usage ?? createUsage(),
    },
  ];
}

/**
 * Generate stream chunks that combine a text preamble with a tool call.
 *
 * Produces: text chunks → tool-input chunks → `finish(tool-calls)`
 */
export function createTextAndToolCallChunks(
  text: string,
  toolName: string,
  toolCallId: string,
  args: Record<string, unknown>,
  options?: {
    textId?: string;
    usage?: LanguageModelV3Usage;
  },
): StreamChunk[] {
  const textId = options?.textId ?? "text-1";
  const words = text.split(" ");
  const chunks: StreamChunk[] = [{ type: "text-start", id: textId }];
  for (let i = 0; i < words.length; i++) {
    const delta = i === 0 ? words[i]! : ` ${words[i]}`;
    chunks.push({ type: "text-delta", id: textId, delta });
  }
  chunks.push({ type: "text-end", id: textId });

  const argsJson = JSON.stringify(args);
  chunks.push({ type: "tool-input-start", id: toolCallId, toolName });
  chunks.push({ type: "tool-input-delta", id: toolCallId, delta: argsJson });
  chunks.push({ type: "tool-input-end", id: toolCallId });
  chunks.push({
    type: "finish",
    finishReason: createFinishReason("tool-calls"),
    usage: options?.usage ?? createUsage(),
  });
  return chunks;
}

// ============================================================================
// Mock model factory
// ============================================================================

/**
 * Create a `MockLanguageModelV3` that streams the given chunk sequences.
 *
 * Each call to `doStream` returns the next sequence in order. The last
 * sequence is repeated if `doStream` is called more times than sequences
 * provided (via the AI SDK's `mockValues` behavior on arrays).
 *
 * @param sequences - One or more arrays of `StreamChunk`s. Each array
 *   represents one `doStream` invocation.
 * @param options - Optional provider/model naming and delay config.
 */
export function createMockStreamModel(
  sequences: StreamChunk[][],
  options?: MockStreamModelOptions,
): MockLanguageModelV3 {
  const { provider = "mock", modelId = "mock-model", initialDelayInMs = null, chunkDelayInMs = null } = options ?? {};

  let callIndex = 0;

  return new MockLanguageModelV3({
    provider,
    modelId,
    doStream: async (): Promise<LanguageModelV3StreamResult> => {
      const idx = Math.min(callIndex, sequences.length - 1);
      callIndex++;
      const chunks = sequences[idx]!;

      return {
        stream: simulateReadableStream({
          chunks,
          initialDelayInMs,
          chunkDelayInMs,
        }),
      };
    },
  });
}

/**
 * Convenience: create a mock model for a single text response.
 */
export function createTextResponseModel(text: string, options?: MockStreamModelOptions): MockLanguageModelV3 {
  return createMockStreamModel([createTextResponseChunks(text)], options);
}

/**
 * Convenience: create a mock model that first issues a tool call,
 * then (on the second `doStream` invocation) returns text.
 */
export function createToolThenTextModel(
  toolName: string,
  toolCallId: string,
  toolArgs: Record<string, unknown>,
  responseText: string,
  options?: MockStreamModelOptions,
): MockLanguageModelV3 {
  return createMockStreamModel(
    [createToolCallChunks(toolName, toolCallId, toolArgs), createTextResponseChunks(responseText)],
    options,
  );
}

// Re-export underlying SDK helpers for advanced usage
export { MockLanguageModelV3, simulateReadableStream };
