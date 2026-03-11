/**
 * Integration tests for the AI chat loop using MockLanguageModelV3.
 *
 * Tests the full durable agent pipeline — thread creation, message sending,
 * streaming, message persistence, and status transitions — without hitting
 * any real LLM API. The mock model behavior is controlled via the `modelId`
 * field on the chat:
 *
 * - `mock:text:<message>` — returns the specified text response
 * - `mock:slowtext:<delayMs>:<message>` — returns text with delayed streaming chunks
 * - `mock:echo` — echoes back the last user message
 * - `mock:error` — simulates a model error
 * - `mock:flaky:<failures>:<error>:<message>` — throws `<error>` for N calls, then returns `<message>`
 * - `mock:partialflaky:<failures>:<partialText>:<error>:<message>` — streams partial output then errors for N calls, then returns `<message>`
 *
 * These tests require TOKENSPACE_MOCK_LLM=true on the backend.
 * Replay fixtures are seeded from packages/test-integration/fixtures/replay-recordings.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { getSharedContext, getSharedHarness, waitForSetup } from "./setup";
import { enqueueAndWaitForRevision, getFunctionName, internal, type TestContext } from "./test-utils";

type DurableThreadStatus = "streaming" | "awaiting_tool_results" | "completed" | "failed" | "stopped";
type ChatStatus = DurableThreadStatus | "waiting_for_approval";

interface TestChat {
  chatId: string;
  threadId: string;
  sessionId: string;
}

interface TestChatStatus {
  chatId: string;
  threadId: string;
  status: ChatStatus | undefined;
  messageCount: number | undefined;
  modelId: string | undefined;
}

interface MessageDoc {
  id: string;
  role: string;
  parts: Array<{ type: string; text?: string; toolName?: string; [key: string]: unknown }>;
}

interface ToolCallDoc {
  toolCallId: string;
  toolName: string;
  args: unknown;
  result?: unknown;
  error?: string;
  executionAttempt?: number;
  executionMaxAttempts?: number;
  executionLastError?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encodeModelSegment(value: string): string {
  return encodeURIComponent(value);
}

async function getChatStatus(chatId: string): Promise<TestChatStatus | null> {
  const backend = getSharedHarness().getBackend();
  return (await backend.runFunction(getFunctionName(internal.ai.chat.getTestChatStatus), {
    chatId,
  })) as TestChatStatus | null;
}

/**
 * Poll for a chat to reach one of the expected statuses.
 */
async function waitForChatStatus(
  chatId: string,
  expectedStatuses: ChatStatus[],
  timeoutMs = 15000,
): Promise<{ status: TestChatStatus; history: ChatStatus[] }> {
  const startTime = Date.now();
  const history: ChatStatus[] = [];

  while (Date.now() - startTime < timeoutMs) {
    const status = await getChatStatus(chatId);
    if (status?.status && history[history.length - 1] !== status.status) {
      history.push(status.status);
    }

    if (status?.status && expectedStatuses.includes(status.status)) {
      return { status, history };
    }

    await sleep(100);
  }

  const finalStatus = await getChatStatus(chatId);

  throw new Error(
    `Chat ${chatId} did not reach expected status [${expectedStatuses.join(", ")}] within ${timeoutMs}ms. ` +
      `Current status: ${finalStatus?.status ?? "unknown"}, seen: [${history.join(", ")}]`,
  );
}

async function waitForStatusSequence(chatId: string, sequence: ChatStatus[], timeoutMs = 15000): Promise<ChatStatus[]> {
  const startTime = Date.now();
  const history: ChatStatus[] = [];
  let sequenceIndex = 0;

  while (Date.now() - startTime < timeoutMs) {
    const status = await getChatStatus(chatId);
    if (status?.status && history[history.length - 1] !== status.status) {
      history.push(status.status);
    }

    if (status?.status === sequence[sequenceIndex]) {
      sequenceIndex += 1;
      if (sequenceIndex === sequence.length) {
        return history;
      }
    }

    await sleep(100);
  }

  throw new Error(
    `Chat ${chatId} did not reach status sequence [${sequence.join(" -> ")}] within ${timeoutMs}ms. ` +
      `Seen: [${history.join(", ")}]`,
  );
}

async function waitForChatCompletion(
  chatId: string,
  expectedStatuses: ChatStatus[] = ["completed", "failed", "stopped"],
  timeoutMs = 15000,
): Promise<TestChatStatus> {
  const { status } = await waitForChatStatus(chatId, expectedStatuses, timeoutMs);
  return status;
}

/**
 * Get messages for a thread.
 */
async function getMessages(threadId: string): Promise<MessageDoc[]> {
  const backend = getSharedHarness().getBackend();
  return (await backend.runFunction(getFunctionName(internal.ai.thread.listMessages), {
    threadId,
  })) as MessageDoc[];
}

async function waitForAssistantText(threadId: string, expectedText: string, timeoutMs = 15000): Promise<MessageDoc[]> {
  const startTime = Date.now();
  let lastAssistantText = "";

  while (Date.now() - startTime < timeoutMs) {
    const messages = await getMessages(threadId);
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    const fullAssistantText = assistantMessages
      .map((m) =>
        m.parts
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join(""),
      )
      .join("\n");
    lastAssistantText = fullAssistantText;

    if (fullAssistantText.includes(expectedText)) {
      return messages;
    }

    await sleep(100);
  }

  throw new Error(
    `Assistant text "${expectedText}" was not found within ${timeoutMs}ms for thread ${threadId}. ` +
      `Last assistant text: ${JSON.stringify(lastAssistantText)}`,
  );
}

async function setThreadStatus(threadId: string, status: DurableThreadStatus): Promise<void> {
  const backend = getSharedHarness().getBackend();
  await backend.runFunction(getFunctionName(internal.ai.chat.setTestThreadStatus), {
    threadId,
    status,
  });
}

async function createPendingToolCall(threadId: string, toolName: string): Promise<string> {
  const backend = getSharedHarness().getBackend();
  const toolCallId = `tool-${crypto.randomUUID()}`;
  await backend.runFunction(getFunctionName(internal.ai.chat.createTestPendingToolCall), {
    threadId,
    toolCallId,
    toolName,
    toolArgs: {},
  });
  return toolCallId;
}

async function getToolCall(threadId: string, toolCallId: string): Promise<ToolCallDoc | null> {
  const backend = getSharedHarness().getBackend();
  return (await backend.runFunction(getFunctionName(internal.ai.chat.getTestToolCall), {
    threadId,
    toolCallId,
  })) as ToolCallDoc | null;
}

async function waitForToolCallTerminal(threadId: string, toolCallId: string, timeoutMs = 15000): Promise<ToolCallDoc> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const toolCall = await getToolCall(threadId, toolCallId);
    if (toolCall && (toolCall.result !== undefined || toolCall.error !== undefined)) {
      return toolCall;
    }
    await sleep(100);
  }

  throw new Error(`Tool call ${toolCallId} did not complete within ${timeoutMs}ms`);
}

describe("Chat with Mock LLM", () => {
  let context: TestContext;

  beforeAll(async () => {
    await waitForSetup();
    context = getSharedContext();
  });

  describe("simple text response", () => {
    it("creates a chat, sends a message, and gets a mock text response", async () => {
      const backend = getSharedHarness().getBackend();

      // Create a test chat with a specific mock model that returns fixed text
      const chat = (await backend.runFunction(getFunctionName(internal.ai.chat.createTestChat), {
        revisionId: context.revisionId,
        modelId: "mock:text:Hello from the mock model!",
      })) as TestChat;

      expect(chat.chatId).toBeDefined();
      expect(chat.threadId).toBeDefined();

      // Send a message to trigger the agent loop
      await backend.runFunction(getFunctionName(internal.ai.chat.sendTestMessage), {
        threadId: chat.threadId,
        prompt: "Hi there!",
      });

      // Wait for the chat to complete
      const status = await waitForChatCompletion(chat.chatId);
      expect(status.status).toBe("completed");
      expect(status.messageCount).toBe(1);

      // Verify the messages
      const messages = await getMessages(chat.threadId);

      // Should have at least 2 messages: user + assistant
      const userMessages = messages.filter((m) => m.role === "user");
      const assistantMessages = messages.filter((m) => m.role === "assistant");

      expect(userMessages.length).toBeGreaterThanOrEqual(1);
      expect(assistantMessages.length).toBeGreaterThanOrEqual(1);

      // The assistant message should contain the mock text
      const lastAssistant = assistantMessages[assistantMessages.length - 1]!;
      const textParts = lastAssistant.parts.filter((p) => p.type === "text");
      const fullText = textParts.map((p) => p.text).join("");
      expect(fullText).toContain("Hello from the mock model!");
    }, 20000);
  });

  describe("echo mode", () => {
    it("echoes back the user message", async () => {
      const backend = getSharedHarness().getBackend();

      const chat = (await backend.runFunction(getFunctionName(internal.ai.chat.createTestChat), {
        revisionId: context.revisionId,
        modelId: "mock:echo",
      })) as TestChat;

      await backend.runFunction(getFunctionName(internal.ai.chat.sendTestMessage), {
        threadId: chat.threadId,
        prompt: "Can you repeat this?",
      });

      const status = await waitForChatCompletion(chat.chatId);
      expect(status.status).toBe("completed");

      const messages = await getMessages(chat.threadId);
      const assistantMessages = messages.filter((m) => m.role === "assistant");
      expect(assistantMessages.length).toBeGreaterThanOrEqual(1);

      const lastAssistant = assistantMessages[assistantMessages.length - 1]!;
      const textParts = lastAssistant.parts.filter((p) => p.type === "text");
      const fullText = textParts.map((p) => p.text).join("");
      // Echo mode prepends "Echo: " to the user message
      expect(fullText).toContain("Echo: Can you repeat this?");
    }, 20000);
  });

  describe("replay mode", () => {
    it("replays multi-turn recordings and waits for the next user turn", async () => {
      const backend = getSharedHarness().getBackend();

      const chat = (await backend.runFunction(getFunctionName(internal.ai.chat.createTestChat), {
        revisionId: context.revisionId,
        modelId: "mock:replay:multi-turn-tool",
      })) as TestChat;

      await backend.runFunction(getFunctionName(internal.ai.chat.sendTestMessage), {
        threadId: chat.threadId,
        prompt: "first user prompt",
      });

      const firstTurnMessages = await waitForAssistantText(chat.threadId, "First replay response.", 20000);
      const firstAssistantText = firstTurnMessages
        .filter((m) => m.role === "assistant")
        .map((m) =>
          m.parts
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join(""),
        )
        .join("\n");
      expect(firstAssistantText).toContain("First replay response.");
      expect(firstAssistantText).not.toContain("Second replay response.");
      await waitForChatCompletion(chat.chatId, ["completed"], 20000);

      await backend.runFunction(getFunctionName(internal.ai.chat.sendTestMessage), {
        threadId: chat.threadId,
        prompt: "second user prompt",
      });

      const secondTurnMessages = await waitForAssistantText(chat.threadId, "Second replay response.", 20000);
      const assistantMessages = secondTurnMessages.filter((m) => m.role === "assistant");
      const lastAssistant = assistantMessages[assistantMessages.length - 1]!;
      const lastAssistantText = lastAssistant.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("");
      expect(lastAssistantText).toContain("Second replay response.");
    }, 30000);

    it("replays recorded tool outcomes instead of executing real tools", async () => {
      const backend = getSharedHarness().getBackend();

      const chat = (await backend.runFunction(getFunctionName(internal.ai.chat.createTestChat), {
        revisionId: context.revisionId,
        modelId: "mock:replay:tool-replay-basic",
      })) as TestChat;

      await backend.runFunction(getFunctionName(internal.ai.chat.sendTestMessage), {
        threadId: chat.threadId,
        prompt: "run the tool",
      });

      await waitForAssistantText(chat.threadId, "Done after tool replay.", 20000);
      const status = await waitForChatCompletion(chat.chatId, ["completed"], 20000);
      expect(status.status).toBe("completed");

      const toolCall = await getToolCall(chat.threadId, "call_1");
      expect(toolCall).not.toBeNull();
      expect(toolCall?.toolName).toBe("readFile");
      expect(toolCall?.result).toBe("REPLAYED_README_CONTENT");
      expect(toolCall?.error).toBeUndefined();
    }, 30000);
  });

  describe("error handling", () => {
    it("transitions to failed status when the model errors", async () => {
      const backend = getSharedHarness().getBackend();

      const chat = (await backend.runFunction(getFunctionName(internal.ai.chat.createTestChat), {
        revisionId: context.revisionId,
        modelId: "mock:error",
      })) as TestChat;

      await backend.runFunction(getFunctionName(internal.ai.chat.sendTestMessage), {
        threadId: chat.threadId,
        prompt: "This should fail",
      });

      // Wait for the chat to fail
      const status = await waitForChatCompletion(chat.chatId, ["failed"]);
      expect(status.status).toBe("failed");
    }, 20000);

    it("retries and recovers from retryable pre-stream model errors", async () => {
      const backend = getSharedHarness().getBackend();
      const modelId = `mock:flaky:1:${encodeModelSegment("connection reset by peer")}:${encodeModelSegment(
        "Recovered after retry",
      )}`;

      const chat = (await backend.runFunction(getFunctionName(internal.ai.chat.createTestChat), {
        revisionId: context.revisionId,
        modelId,
      })) as TestChat;

      await backend.runFunction(getFunctionName(internal.ai.chat.sendTestMessage), {
        threadId: chat.threadId,
        prompt: "Please recover",
      });

      const status = await waitForChatCompletion(chat.chatId, ["completed"], 20000);
      expect(status.status).toBe("completed");

      const messages = await waitForAssistantText(chat.threadId, "Recovered after retry", 20000);
      const assistantMessages = messages.filter((m) => m.role === "assistant");
      expect(assistantMessages.length).toBeGreaterThan(0);
    }, 30000);

    it("does not retry non-retryable context overflow errors", async () => {
      const backend = getSharedHarness().getBackend();
      const modelId = `mock:flaky:1:${encodeModelSegment("maximum context length is 8192 tokens")}:${encodeModelSegment(
        "Should not be emitted",
      )}`;

      const chat = (await backend.runFunction(getFunctionName(internal.ai.chat.createTestChat), {
        revisionId: context.revisionId,
        modelId,
      })) as TestChat;

      await backend.runFunction(getFunctionName(internal.ai.chat.sendTestMessage), {
        threadId: chat.threadId,
        prompt: "Trigger context error",
      });

      const status = await waitForChatCompletion(chat.chatId, ["failed"], 20000);
      expect(status.status).toBe("failed");

      const messages = await getMessages(chat.threadId);
      const assistantText = messages
        .filter((m) => m.role === "assistant")
        .map((m) =>
          m.parts
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join(""),
        )
        .join("\n");
      expect(assistantText).not.toContain("Should not be emitted");
    }, 30000);

    it("does not retry once partial stream output has been emitted", async () => {
      const backend = getSharedHarness().getBackend();
      const modelId = `mock:partialflaky:1:${encodeModelSegment("Partial output")}:${encodeModelSegment(
        "connection terminated by peer",
      )}:${encodeModelSegment("Should not be emitted")}`;

      const chat = (await backend.runFunction(getFunctionName(internal.ai.chat.createTestChat), {
        revisionId: context.revisionId,
        modelId,
      })) as TestChat;

      await backend.runFunction(getFunctionName(internal.ai.chat.sendTestMessage), {
        threadId: chat.threadId,
        prompt: "Trigger partial stream failure",
      });

      const status = await waitForChatCompletion(chat.chatId, ["failed"], 20000);
      expect(status.status).toBe("failed");

      const messages = await getMessages(chat.threadId);
      const assistantText = messages
        .filter((m) => m.role === "assistant")
        .map((m) =>
          m.parts
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join(""),
        )
        .join("\n");
      expect(assistantText).not.toContain("Should not be emitted");
    }, 30000);
  });

  describe("sync tool retry handling", () => {
    it("retries sync tools and succeeds when retry is enabled", async () => {
      const backend = getSharedHarness().getBackend();
      const chat = (await backend.runFunction(getFunctionName(internal.ai.chat.createTestChat), {
        revisionId: context.revisionId,
        modelId: "mock:text:unused",
      })) as TestChat;
      const toolCallId = `tool-${crypto.randomUUID()}`;

      await backend.runFunction("ai/chat:scheduleTestSyncToolCall", {
        threadId: chat.threadId,
        toolCallId,
        toolName: "testSyncRetryTool",
        toolArgs: {
          threadId: chat.threadId,
          toolCallId,
          failUntilAttempt: 1,
          errorMessage: "connection reset by peer",
          result: { ok: true, recovered: true },
        },
        retry: {
          enabled: true,
          maxAttempts: 3,
          backoff: { strategy: "fixed", delayMs: 0, jitter: false },
        },
      });

      const toolCall = await waitForToolCallTerminal(chat.threadId, toolCallId, 20000);
      expect(toolCall.error).toBeUndefined();
      expect(toolCall.result).toEqual({ ok: true, recovered: true });
      expect(toolCall.executionAttempt).toBe(2);
      expect(toolCall.executionMaxAttempts).toBe(3);
    }, 30000);

    it("does not retry sync tools when retry is not enabled", async () => {
      const backend = getSharedHarness().getBackend();
      const chat = (await backend.runFunction(getFunctionName(internal.ai.chat.createTestChat), {
        revisionId: context.revisionId,
        modelId: "mock:text:unused",
      })) as TestChat;
      const toolCallId = `tool-${crypto.randomUUID()}`;

      await backend.runFunction("ai/chat:scheduleTestSyncToolCall", {
        threadId: chat.threadId,
        toolCallId,
        toolName: "testSyncNoRetryTool",
        toolArgs: {
          threadId: chat.threadId,
          toolCallId,
          failUntilAttempt: 1,
          errorMessage: "connection reset by peer",
        },
      });

      const toolCall = await waitForToolCallTerminal(chat.threadId, toolCallId, 20000);
      expect(toolCall.result).toBeUndefined();
      expect(toolCall.error).toContain("connection reset by peer");
      expect(toolCall.executionAttempt).toBe(1);
    }, 30000);

    it("uses shouldRetryError to retry non-transient sync tool errors", async () => {
      const backend = getSharedHarness().getBackend();
      const chat = (await backend.runFunction(getFunctionName(internal.ai.chat.createTestChat), {
        revisionId: context.revisionId,
        modelId: "mock:text:unused",
      })) as TestChat;
      const toolCallId = `tool-${crypto.randomUUID()}`;

      await backend.runFunction("ai/chat:scheduleTestSyncToolCall", {
        threadId: chat.threadId,
        toolCallId,
        toolName: "testSyncCustomClassifierTool",
        toolArgs: {
          threadId: chat.threadId,
          toolCallId,
          failUntilAttempt: 1,
          errorMessage: "validation failed retry-me",
          result: { ok: true, viaClassifier: true },
        },
        retry: {
          enabled: true,
          maxAttempts: 3,
          backoff: { strategy: "fixed", delayMs: 0, jitter: false },
        },
        useRetryClassifier: true,
      });

      const toolCall = await waitForToolCallTerminal(chat.threadId, toolCallId, 20000);
      expect(toolCall.error).toBeUndefined();
      expect(toolCall.result).toEqual({ ok: true, viaClassifier: true });
      expect(toolCall.executionAttempt).toBe(2);
    }, 30000);
  });

  describe("workspace default model resolution", () => {
    it("uses workspace default model when no modelId is provided", async () => {
      const backend = getSharedHarness().getBackend();
      const userId = "test-user";

      await backend.runFunction(getFunctionName(internal.fs.working.write), {
        workspaceId: context.workspaceId,
        branchId: context.branchId,
        userId,
        path: "src/models.yaml",
        content: "models:\n  - modelId: mock:text:Workspace default model response\n    isDefault: true\n",
      });

      await backend.runFunction(getFunctionName(internal.vcs.createCommitInternal), {
        workspaceId: context.workspaceId,
        branchId: context.branchId,
        userId,
        message: "Configure workspace models",
      });

      const revisionWithModels = await enqueueAndWaitForRevision(backend, {
        workspaceId: context.workspaceId,
        branchId: context.branchId,
        includeWorkingState: false,
      });

      const chat = (await backend.runFunction(getFunctionName(internal.ai.chat.createTestChat), {
        revisionId: revisionWithModels,
        // Intentionally omit modelId to force workspace default resolution.
      })) as TestChat;

      await backend.runFunction(getFunctionName(internal.ai.chat.sendTestMessage), {
        threadId: chat.threadId,
        prompt: "Hello",
      });

      const status = await waitForChatCompletion(chat.chatId);
      expect(status.status).toBe("completed");

      const messages = await getMessages(chat.threadId);
      const assistantMessages = messages.filter((m) => m.role === "assistant");
      expect(assistantMessages.length).toBeGreaterThanOrEqual(1);

      const lastAssistant = assistantMessages[assistantMessages.length - 1]!;
      const textParts = lastAssistant.parts.filter((p) => p.type === "text");
      const fullText = textParts.map((p) => p.text).join("");
      expect(fullText).toContain("Workspace default model response");
    }, 20000);
  });

  describe("thread status transitions", () => {
    it("transitions through streaming to completed", async () => {
      const backend = getSharedHarness().getBackend();

      const chat = (await backend.runFunction(getFunctionName(internal.ai.chat.createTestChat), {
        revisionId: context.revisionId,
        modelId: "mock:slowtext:30:Status test response",
      })) as TestChat;

      // Send message to trigger streaming
      await backend.runFunction(getFunctionName(internal.ai.chat.sendTestMessage), {
        threadId: chat.threadId,
        prompt: "Check status",
      });

      const history = await waitForStatusSequence(chat.chatId, ["streaming", "completed"], 20000);
      expect(history).toContain("streaming");
      expect(history[history.length - 1]).toBe("completed");
    }, 20000);
  });

  describe("status mapping for awaiting tool results", () => {
    it("maps awaiting_tool_results + requestApproval to waiting_for_approval", async () => {
      const backend = getSharedHarness().getBackend();

      const chat = (await backend.runFunction(getFunctionName(internal.ai.chat.createTestChat), {
        revisionId: context.revisionId,
        modelId: "mock:text:unused",
      })) as TestChat;

      await createPendingToolCall(chat.threadId, "requestApproval");
      await setThreadStatus(chat.threadId, "awaiting_tool_results");

      const { status } = await waitForChatStatus(chat.chatId, ["waiting_for_approval"], 10000);
      expect(status.status).toBe("waiting_for_approval");
    }, 20000);

    it("keeps awaiting_tool_results when a non-approval tool call is pending", async () => {
      const backend = getSharedHarness().getBackend();

      const chat = (await backend.runFunction(getFunctionName(internal.ai.chat.createTestChat), {
        revisionId: context.revisionId,
        modelId: "mock:text:unused",
      })) as TestChat;

      await createPendingToolCall(chat.threadId, "bash");
      await setThreadStatus(chat.threadId, "awaiting_tool_results");

      const { status } = await waitForChatStatus(chat.chatId, ["awaiting_tool_results"], 10000);
      expect(status.status).toBe("awaiting_tool_results");
    }, 20000);
  });

  describe("tool outcome sync", () => {
    it("persists addToolResult and keeps awaiting status while other calls are pending", async () => {
      const backend = getSharedHarness().getBackend();

      const chat = (await backend.runFunction(getFunctionName(internal.ai.chat.createTestChat), {
        revisionId: context.revisionId,
        modelId: "mock:text:unused",
      })) as TestChat;

      const completedCallId = await createPendingToolCall(chat.threadId, "bash");
      await createPendingToolCall(chat.threadId, "bash");
      await setThreadStatus(chat.threadId, "awaiting_tool_results");

      await backend.runFunction(getFunctionName(internal.ai.chat.addToolResult), {
        threadId: chat.threadId,
        toolCallId: completedCallId,
        result: { ok: true },
      });

      const toolCall = await getToolCall(chat.threadId, completedCallId);
      expect(toolCall).not.toBeNull();
      expect(toolCall?.result).toEqual({ ok: true });

      const { status } = await waitForChatStatus(chat.chatId, ["awaiting_tool_results"], 10000);
      expect(status.status).toBe("awaiting_tool_results");
    }, 20000);

    it("persists addToolError and keeps awaiting status while other calls are pending", async () => {
      const backend = getSharedHarness().getBackend();

      const chat = (await backend.runFunction(getFunctionName(internal.ai.chat.createTestChat), {
        revisionId: context.revisionId,
        modelId: "mock:text:unused",
      })) as TestChat;

      const failedCallId = await createPendingToolCall(chat.threadId, "bash");
      await createPendingToolCall(chat.threadId, "bash");
      await setThreadStatus(chat.threadId, "awaiting_tool_results");

      await backend.runFunction(getFunctionName(internal.ai.chat.addToolError), {
        threadId: chat.threadId,
        toolCallId: failedCallId,
        error: "Simulated tool failure",
      });

      const toolCall = await getToolCall(chat.threadId, failedCallId);
      expect(toolCall).not.toBeNull();
      expect(toolCall?.error).toBe("Simulated tool failure");

      const { status } = await waitForChatStatus(chat.chatId, ["awaiting_tool_results"], 10000);
      expect(status.status).toBe("awaiting_tool_results");
    }, 20000);
  });
});
