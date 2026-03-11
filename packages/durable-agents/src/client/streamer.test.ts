import { describe, expect, it } from "bun:test";
import type { UIMessageChunk } from "ai";
import { joinAdjacentDeltas } from "./streamer";

describe("joinAdjacentDeltas", () => {
  it("returns empty array for empty input", () => {
    expect(joinAdjacentDeltas([])).toEqual([]);
  });

  it("joins adjacent text-delta chunks with the same id", () => {
    const chunks: Array<UIMessageChunk> = [
      { type: "text-delta", id: "a", delta: "Hello" },
      { type: "text-delta", id: "a", delta: " world" },
      { type: "text-delta", id: "a", delta: "!" },
    ];
    expect(joinAdjacentDeltas(chunks)).toEqual([{ type: "text-delta", id: "a", delta: "Hello world!" }]);
  });

  it("joins adjacent reasoning-delta chunks with the same id", () => {
    const chunks: Array<UIMessageChunk> = [
      { type: "reasoning-delta", id: "r1", delta: "Let me " },
      { type: "reasoning-delta", id: "r1", delta: "think" },
    ];
    expect(joinAdjacentDeltas(chunks)).toEqual([{ type: "reasoning-delta", id: "r1", delta: "Let me think" }]);
  });

  it("does not join text-delta chunks with different ids", () => {
    const chunks: Array<UIMessageChunk> = [
      { type: "text-delta", id: "a", delta: "Hello" },
      { type: "text-delta", id: "b", delta: " world" },
    ];
    expect(joinAdjacentDeltas(chunks)).toEqual([
      { type: "text-delta", id: "a", delta: "Hello" },
      { type: "text-delta", id: "b", delta: " world" },
    ]);
  });

  it("does not join text-delta and reasoning-delta even with same id", () => {
    const chunks: Array<UIMessageChunk> = [
      { type: "text-delta", id: "a", delta: "Hello" },
      { type: "reasoning-delta", id: "a", delta: "think" },
    ];
    expect(joinAdjacentDeltas(chunks)).toEqual([
      { type: "text-delta", id: "a", delta: "Hello" },
      { type: "reasoning-delta", id: "a", delta: "think" },
    ]);
  });

  it("does not join non-adjacent same-type chunks", () => {
    const chunks: Array<UIMessageChunk> = [
      { type: "text-delta", id: "a", delta: "Hello" },
      { type: "text-start", id: "b" },
      { type: "text-delta", id: "a", delta: " world" },
    ];
    expect(joinAdjacentDeltas(chunks)).toEqual([
      { type: "text-delta", id: "a", delta: "Hello" },
      { type: "text-start", id: "b" },
      { type: "text-delta", id: "a", delta: " world" },
    ]);
  });

  it("passes through non-delta chunk types unchanged", () => {
    const chunks: Array<UIMessageChunk> = [
      { type: "text-start", id: "a" },
      { type: "text-end", id: "a" },
      { type: "start" },
      { type: "finish" },
    ];
    expect(joinAdjacentDeltas(chunks)).toEqual(chunks);
  });

  it("handles mixed delta and non-delta chunks", () => {
    const chunks: Array<UIMessageChunk> = [
      { type: "text-start", id: "a" },
      { type: "text-delta", id: "a", delta: "Hello" },
      { type: "text-delta", id: "a", delta: " world" },
      { type: "text-end", id: "a" },
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", delta: "Step " },
      { type: "reasoning-delta", id: "r1", delta: "1" },
    ];
    expect(joinAdjacentDeltas(chunks)).toEqual([
      { type: "text-start", id: "a" },
      { type: "text-delta", id: "a", delta: "Hello world" },
      { type: "text-end", id: "a" },
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", delta: "Step 1" },
    ]);
  });

  it("handles a single chunk", () => {
    const chunks: Array<UIMessageChunk> = [{ type: "text-delta", id: "a", delta: "Hello" }];
    expect(joinAdjacentDeltas(chunks)).toEqual([{ type: "text-delta", id: "a", delta: "Hello" }]);
  });
});
