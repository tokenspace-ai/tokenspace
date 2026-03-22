import { describe, expect, it } from "bun:test";
import streamingFixture from "../../../../packages/durable-agents/src/react/__fixtures__/07-text-streaming-more-seq6.json";
import {
  applyStreamingUpdates,
  isThreadRunningStatus,
  type StreamingUpdates,
  splitConversationSteps,
  type TuiMessage,
} from "./chat-tui-helpers.js";

describe("chat TUI helpers", () => {
  it("treats the last assistant message as live while the thread is running", () => {
    const { staticSteps, liveSteps } = splitConversationSteps(
      [
        {
          id: "m1",
          role: "user",
          parts: [{ type: "text", text: "Inspect the repo" }],
        },
        {
          id: "m2",
          role: "assistant",
          parts: [
            { type: "reasoning", text: "Looking through the files", state: "done" },
            { type: "tool-readFile", toolName: "readFile", input: { path: "README.md" }, state: "output-available" },
            { type: "text", text: "Found it.", state: "streaming" },
          ],
        },
      ] as TuiMessage[],
      "streaming",
    );

    expect(staticSteps).toEqual([{ id: "m1:0", kind: "user", text: "Inspect the repo" }]);
    expect(liveSteps).toEqual([
      { id: "m2:0", kind: "reasoning", text: "Looking through the files" },
      { id: "m2:1", kind: "tool", text: "Read README.md" },
      { id: "m2:2", kind: "assistant", text: "Found it." },
    ]);
  });

  it("renders all steps as static when waiting for approval", () => {
    const { staticSteps, liveSteps } = splitConversationSteps(
      [
        {
          id: "m1",
          role: "assistant",
          parts: [
            { type: "tool-requestApproval", toolName: "requestApproval", input: { reason: "Need confirmation" } },
          ],
        },
      ] as TuiMessage[],
      "waiting_for_approval",
    );

    expect(staticSteps).toEqual([{ id: "m1:0", kind: "tool", text: "Need confirmation" }]);
    expect(liveSteps).toEqual([]);
  });

  it("merges streamed assistant text updates without reordering earlier messages", async () => {
    const nextMessages = await applyStreamingUpdates(
      streamingFixture.messages as TuiMessage[],
      streamingFixture.streamingUpdates as StreamingUpdates,
    );

    expect(nextMessages[0]?.id).toBe(streamingFixture.messages[0]?.id);
    expect(nextMessages).toHaveLength(2);

    const assistantText = nextMessages[1]?.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("");

    expect(assistantText).toContain("perfect for outdoor plans.");
    expect(isThreadRunningStatus("streaming")).toBe(true);
    expect(isThreadRunningStatus("completed")).toBe(false);
  });
});
