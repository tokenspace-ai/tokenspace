/**
 * Test utilities for @tokenspace/convex-durable-agents.
 *
 * Import from "@tokenspace/convex-durable-agents/test" to use mock models,
 * chunk builders, the LLM recorder middleware, and replay helpers.
 */

// Mock model helpers
export {
  createFinishReason,
  createMockStreamModel,
  createTextAndToolCallChunks,
  createTextResponseChunks,
  createTextResponseModel,
  createToolCallChunks,
  createToolThenTextModel,
  createUsage,
  MockLanguageModelV3,
  type MockStreamModelOptions,
  type StreamChunk,
  simulateReadableStream,
} from "./mock-model.js";

// Recorder middleware (record & replay)
export {
  createRecorderMiddleware,
  createReplayModel,
  type LLMRecording,
  type LLMRecordingMetadata,
  type RecorderStorage,
} from "./recorder.js";
