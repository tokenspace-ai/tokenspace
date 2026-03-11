import { v } from "convex/values";

export const vReplayState = v.object({
  turnIndex: v.number(),
  streamIndex: v.number(),
  toolOutcomeIndex: v.optional(v.number()),
  currentTurnSignature: v.optional(v.string()),
  lastCompletedTurnSignature: v.optional(v.string()),
});

export const vReplayPlaybackSettings = v.object({
  initialDelayMs: v.optional(v.number()),
  chunkDelayMs: v.optional(v.number()),
});

export const vReplayToolOutcome = v.object({
  toolCallId: v.string(),
  toolName: v.string(),
  args: v.optional(v.any()),
  status: v.union(v.literal("result"), v.literal("error")),
  result: v.optional(v.any()),
  error: v.optional(v.string()),
});
