export const REPLAY_MODEL_PREFIX = "mock:replay:";

type FinishReasonUnified = "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";

export type StreamPart = { type: string; [key: string]: unknown };

export interface ReplayStreamRecording {
  chunks: StreamPart[];
}

export interface ReplayTurnRecording {
  userMessageCount: number;
  userMessageText?: string;
  streams: ReplayStreamRecording[];
}

export interface ReplayConversationRecording {
  version: 2;
  metadata?: {
    modelId?: string;
    provider?: string;
    timestamp?: string;
    [key: string]: unknown;
  };
  turns: ReplayTurnRecording[];
}

export interface ReplayPlaybackSettings {
  initialDelayMs?: number;
  chunkDelayMs?: number;
}

export interface ReplayToolOutcome {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  status: "result" | "error";
  result?: unknown;
  error?: string;
}

export interface ReplayModelConfig {
  replayId: string;
  modelId: string;
  name: string;
  turnCount: number;
  streamCount: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asPositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}

function asFiniteNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return fallback;
}

function normalizeFinishChunk(chunk: Record<string, unknown>): StreamPart {
  const finishReasonInput = asRecord(chunk.finishReason);
  const usageInput = asRecord(chunk.usage);
  const inputTokensInput = asRecord(usageInput?.inputTokens);
  const outputTokensInput = asRecord(usageInput?.outputTokens);

  const unifiedRaw = finishReasonInput?.unified;
  const unified: FinishReasonUnified =
    unifiedRaw === "stop" ||
    unifiedRaw === "length" ||
    unifiedRaw === "content-filter" ||
    unifiedRaw === "tool-calls" ||
    unifiedRaw === "error" ||
    unifiedRaw === "other"
      ? unifiedRaw
      : "stop";

  return {
    type: "finish",
    finishReason: {
      unified,
      raw: typeof finishReasonInput?.raw === "string" ? finishReasonInput.raw : undefined,
    },
    usage: {
      inputTokens: {
        total: asFiniteNumber(inputTokensInput?.total, 10),
        noCache: asFiniteNumber(inputTokensInput?.noCache, asFiniteNumber(inputTokensInput?.total, 10)),
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: {
        total: asFiniteNumber(outputTokensInput?.total, 20),
        text: asFiniteNumber(outputTokensInput?.text, asFiniteNumber(outputTokensInput?.total, 20)),
        reasoning: undefined,
      },
    },
  };
}

function normalizeChunk(chunk: unknown): StreamPart | null {
  const record = asRecord(chunk);
  if (!record || typeof record.type !== "string") {
    return null;
  }
  if (record.type === "finish") {
    return normalizeFinishChunk(record);
  }
  return record as StreamPart;
}

function normalizeChunks(value: unknown): StreamPart[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const chunks: StreamPart[] = [];
  for (const chunk of value) {
    const normalized = normalizeChunk(chunk);
    if (normalized) {
      chunks.push(normalized);
    }
  }
  return chunks.length > 0 ? chunks : null;
}

export function normalizeReplayConversation(input: unknown): ReplayConversationRecording | null {
  if (Array.isArray(input)) {
    const streams: ReplayStreamRecording[] = [];
    for (const item of input) {
      const record = asRecord(item);
      if (!record) continue;
      const chunks = normalizeChunks(record.chunks);
      if (!chunks) continue;
      streams.push({ chunks });
    }
    if (streams.length === 0) return null;
    return {
      version: 2,
      turns: [{ userMessageCount: 1, streams }],
    };
  }

  const record = asRecord(input);
  if (!record) {
    return null;
  }

  if (Array.isArray(record.turns)) {
    const turns: ReplayTurnRecording[] = [];

    for (let turnIndex = 0; turnIndex < record.turns.length; turnIndex++) {
      const turnInput = asRecord(record.turns[turnIndex]);
      if (!turnInput) continue;

      const streamsInput = Array.isArray(turnInput.streams) ? turnInput.streams : [];
      const streams: ReplayStreamRecording[] = [];
      for (const streamInput of streamsInput) {
        const streamRecord = asRecord(streamInput);
        if (!streamRecord) continue;
        const chunks = normalizeChunks(streamRecord.chunks);
        if (!chunks) continue;
        streams.push({ chunks });
      }

      if (streams.length === 0) continue;

      turns.push({
        userMessageCount: asPositiveInt(turnInput.userMessageCount, turnIndex + 1),
        userMessageText: typeof turnInput.userMessageText === "string" ? turnInput.userMessageText : undefined,
        streams,
      });
    }

    if (turns.length === 0) return null;

    return {
      version: 2,
      metadata: asRecord(record.metadata) ?? undefined,
      turns,
    };
  }

  const chunks = normalizeChunks(record.chunks);
  if (!chunks) {
    return null;
  }

  return {
    version: 2,
    metadata: asRecord(record.metadata) ?? undefined,
    turns: [{ userMessageCount: 1, streams: [{ chunks }] }],
  };
}

export function countReplayStreams(recording: ReplayConversationRecording): number {
  return recording.turns.reduce((sum, turn) => sum + turn.streams.length, 0);
}

export function encodeReplayModelId(replayId: string): string {
  return `${REPLAY_MODEL_PREFIX}${encodeURIComponent(replayId)}`;
}

export function decodeReplayId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseReplayModelId(modelId: string): string | null {
  if (!modelId.startsWith(REPLAY_MODEL_PREFIX)) {
    return null;
  }
  return decodeReplayId(modelId.slice(REPLAY_MODEL_PREFIX.length).trim());
}

export function normalizeReplayPlaybackSettings(input: unknown): ReplayPlaybackSettings | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const initialDelayMs =
    typeof record.initialDelayMs === "number" && Number.isFinite(record.initialDelayMs) && record.initialDelayMs >= 0
      ? Math.floor(record.initialDelayMs)
      : undefined;
  const chunkDelayMs =
    typeof record.chunkDelayMs === "number" && Number.isFinite(record.chunkDelayMs) && record.chunkDelayMs >= 0
      ? Math.floor(record.chunkDelayMs)
      : undefined;
  if (initialDelayMs === undefined && chunkDelayMs === undefined) {
    return undefined;
  }
  return {
    ...(initialDelayMs !== undefined ? { initialDelayMs } : {}),
    ...(chunkDelayMs !== undefined ? { chunkDelayMs } : {}),
  };
}

export function normalizeReplayToolOutcomes(input: unknown): ReplayToolOutcome[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const outcomes: ReplayToolOutcome[] = [];
  for (const value of input) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.toolCallId !== "string" || typeof record.toolName !== "string") {
      continue;
    }
    if (record.status !== "result" && record.status !== "error") {
      continue;
    }
    outcomes.push({
      toolCallId: record.toolCallId,
      toolName: record.toolName,
      args: record.args,
      status: record.status,
      result: record.result,
      error: typeof record.error === "string" ? record.error : undefined,
    });
  }
  return outcomes;
}

export function getReplayModelProvider(recording: ReplayConversationRecording): string | undefined {
  return typeof recording.metadata?.provider === "string" ? recording.metadata.provider : undefined;
}

export function getReplayModelId(recording: ReplayConversationRecording): string | undefined {
  return typeof recording.metadata?.modelId === "string" ? recording.metadata.modelId : undefined;
}

function extractTextFromUserMessage(message: unknown): string | undefined {
  const msg = asRecord(message);
  if (!msg || msg.role !== "user") return undefined;

  const content = msg.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  const textParts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      textParts.push(part);
      continue;
    }
    const partRecord = asRecord(part);
    if (!partRecord || partRecord.type !== "text" || typeof partRecord.text !== "string") {
      continue;
    }
    textParts.push(partRecord.text);
  }

  if (textParts.length === 0) {
    return undefined;
  }
  return textParts.join("");
}

export function extractPromptUserInfo(prompt: unknown): { userMessageCount: number; lastUserMessageText?: string } {
  if (!Array.isArray(prompt)) {
    return { userMessageCount: 0 };
  }

  let userMessageCount = 0;
  let lastUserMessageText: string | undefined;

  for (const message of prompt) {
    const userText = extractTextFromUserMessage(message);
    if (userText === undefined) {
      continue;
    }
    userMessageCount += 1;
    lastUserMessageText = userText;
  }

  return { userMessageCount, lastUserMessageText };
}
