import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Readable } from "node:stream";

let linkedWorkspaceRoot: string | null;
let linkedWorkspaceConfig: { version: 1; workspaceSlug: string } | null;
let workspace: any;
let defaultWorkspaceSlug: string | null;
let defaultBranch: any;
let workingStateHash: string | null;
let revisionId: string | null;
let createdChat: { chatId: string; threadId: string; sessionId: string };
let createChatCalls: Array<{ revisionId: string; modelId?: string }>;
let sendCalls: Array<{ chatId: string; prompt: string }>;
let sendChatError: Error | null;
let listChatsPages: Array<{ chats: any[]; isDone: boolean; continueCursor?: string }>;
let chatSnapshots: Record<
  string,
  {
    index: number;
    snapshots: Array<{
      chat: any;
      thread: any;
      messages: any[];
    }>;
  }
>;
let openedUrls: string[];

const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const logMock = mock((..._args: unknown[]) => {});
const errorMock = mock((..._args: unknown[]) => {});

function makeChatSnapshot(args: {
  chatId: string;
  threadId?: string;
  status?: string;
  workspaceId?: string;
  errorMessage?: string;
  messages?: any[];
}): { chat: any; thread: any; messages: any[] } {
  const threadId = args.threadId ?? `thread-${args.chatId}`;
  return {
    chat: {
      id: args.chatId,
      threadId,
      sessionId: `session-${args.chatId}`,
      workspaceId: args.workspaceId ?? "ws_1",
      title: args.chatId,
      status: args.status ?? "completed",
      createdAt: 1_700_000_000_000,
      messageCount: args.messages?.length ?? 0,
      isStarred: false,
      errorMessage: args.errorMessage,
    },
    thread: {
      _id: threadId,
      _creationTime: 1_700_000_000_000,
      status: args.status === "waiting_for_approval" ? "awaiting_tool_results" : (args.status ?? "completed"),
      stopSignal: false,
      streamFnHandle: "fn",
    },
    messages: args.messages ?? [
      {
        _id: "m1",
        _creationTime: 1_700_000_000_000,
        threadId,
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      },
      {
        _id: "m2",
        _creationTime: 1_700_000_000_100,
        threadId,
        id: "m2",
        role: "assistant",
        parts: [{ type: "text", text: "hi" }],
      },
    ],
  };
}

function stripAnsi(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape sequence matching
  return value.replace(/\x1B\[[0-9;]*m/g, "");
}

function getConsoleText(spy: typeof logMock): string {
  return stripAnsi(
    spy.mock.calls
      .map((call) => call.map((entry) => (typeof entry === "string" ? entry : String(entry))).join(" "))
      .join("\n"),
  );
}

function getSnapshotStateByThreadId(threadId: string) {
  const state = Object.values(chatSnapshots).find((entry) => entry.snapshots[0]?.chat.threadId === threadId);
  if (!state) {
    throw new Error(`Missing chat snapshot for thread ${threadId}`);
  }
  return state;
}

mock.module("../client.js", () => ({
  exitWithError: (message: string): never => {
    throw new Error(`EXIT:${message}`);
  },
  getWorkspaceBySlug: async (_slug: string) => workspace,
  getDefaultBranch: async (_workspaceId: string) => defaultBranch,
  getCurrentWorkingStateHash: async (_workspaceId: string, _branchId: string) => workingStateHash,
  getWorkspaceRevision: async (_workspaceId: string, _branchId: string, _workingStateHash?: string) => revisionId,
  createChat: async (revisionIdArg: string, modelId?: string) => {
    createChatCalls.push({ revisionId: revisionIdArg, modelId });
    return createdChat;
  },
  sendChatMessage: async (chatId: string, prompt: string) => {
    if (sendChatError) {
      throw sendChatError;
    }
    sendCalls.push({ chatId, prompt });
  },
  listChatsForWorkspace: async (_workspaceId: string, _options: { limit?: number; cursor?: string | null }) => {
    const page = listChatsPages.shift();
    if (!page) {
      return { chats: [], isDone: true, continueCursor: undefined };
    }
    return page;
  },
  getChatDetails: async (chatId: string) => {
    const state = chatSnapshots[chatId];
    if (!state) {
      return null;
    }
    const snapshot = state.snapshots[Math.min(state.index, state.snapshots.length - 1)];
    if (!snapshot) {
      throw new Error(`Missing snapshot for chat ${chatId}`);
    }
    state.index += 1;
    return snapshot.chat;
  },
  listChatMessages: async (threadId: string) => {
    const state = getSnapshotStateByThreadId(threadId);
    const index = Math.min(Math.max(0, state.index - 1), state.snapshots.length - 1);
    const snapshot = state.snapshots[index];
    if (!snapshot) {
      throw new Error(`Missing snapshot for thread ${threadId}`);
    }
    return snapshot.messages;
  },
  getChatThread: async (threadId: string) => {
    const state = getSnapshotStateByThreadId(threadId);
    const index = Math.min(Math.max(0, state.index - 1), state.snapshots.length - 1);
    const snapshot = state.snapshots[index];
    if (!snapshot) {
      throw new Error(`Missing snapshot for thread ${threadId}`);
    }
    return snapshot.thread;
  },
}));

mock.module("../auth.js", () => ({
  getDefaultWorkspaceSlug: () => defaultWorkspaceSlug,
}));

mock.module("../browser.js", () => ({
  buildChatUrl: (workspaceSlug: string, chatId: string) =>
    `https://app.example.test/workspace/${workspaceSlug}/chat/${chatId}`,
  openUrl: async (url: string) => {
    openedUrls.push(url);
  },
}));

mock.module("../local-workspace.js", () => ({
  findNearestLinkedWorkspaceRoot: async (_cwd: string) => linkedWorkspaceRoot,
  printWorkspaceResolution: (label: string, dir: string) => {
    console.log(`RESOLVE ${label}: ${dir}`);
  },
  readLinkedWorkspaceConfig: async (_workspaceDir: string) => linkedWorkspaceConfig,
}));

const { buildConversationSteps, getTranscriptEntry, getChat, listChats, sendMessageToChat, startChat } = await import(
  "./chat"
);

beforeEach(() => {
  linkedWorkspaceRoot = "/tmp/demo";
  linkedWorkspaceConfig = {
    version: 1,
    workspaceSlug: "demo-workspace",
  };
  workspace = {
    _id: "ws_1",
    slug: "demo-workspace",
    name: "Demo Workspace",
    role: "workspace_admin",
    createdAt: 1,
    updatedAt: 2,
  };
  defaultBranch = {
    _id: "branch_1",
    workspaceId: "ws_1",
    name: "main",
    commitId: "commit_1",
    isDefault: true,
  };
  workingStateHash = "working_hash";
  defaultWorkspaceSlug = null;
  revisionId = "revision_1";
  createdChat = {
    chatId: "chat_new",
    threadId: "thread-chat_new",
    sessionId: "session-chat_new",
  };
  createChatCalls = [];
  sendCalls = [];
  sendChatError = null;
  listChatsPages = [];
  chatSnapshots = {
    chat_new: {
      index: 0,
      snapshots: [makeChatSnapshot({ chatId: "chat_new" })],
    },
    chat_1: {
      index: 0,
      snapshots: [makeChatSnapshot({ chatId: "chat_1" })],
    },
  };
  openedUrls = [];
  logMock.mockClear();
  errorMock.mockClear();
  console.log = logMock as typeof console.log;
  console.error = errorMock as typeof console.error;
});

afterEach(() => {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
});

describe("chat helpers", () => {
  it("extracts transcript text and markers from mixed message parts", () => {
    const entry = getTranscriptEntry({
      _id: "m1",
      _creationTime: 1,
      threadId: "thread_1",
      id: "m1",
      role: "assistant",
      parts: [
        { type: "text", text: "Result:" },
        { type: "tool-bash", toolName: "bash", state: "output-available" },
      ],
    } as any);

    expect(entry).toEqual({
      id: "m1",
      role: "assistant",
      text: "Result:",
      markers: ["[tool bash output-available]"],
    });
  });

  it("renders conversation steps in message-part order for human output", () => {
    const steps = buildConversationSteps([
      {
        _id: "m1",
        _creationTime: 1,
        threadId: "thread_1",
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: "Inspect the repo" }],
      },
      {
        _id: "m2",
        _creationTime: 2,
        threadId: "thread_1",
        id: "m2",
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "reasoning-start", id: "r1" },
          { type: "reasoning-delta", id: "r1", delta: "Looking " },
          { type: "reasoning-delta", id: "r1", delta: "through the files" },
          { type: "tool-readFile", toolName: "readFile", state: "output-available", input: { path: "README.md" } },
          {
            type: "tool-runCode",
            toolName: "runCode",
            state: "output-available",
            input: { description: "Check the compiled artifact" },
          },
          { type: "text", text: "Found the relevant section." },
        ],
      },
    ] as any);

    expect(steps).toEqual([
      { kind: "user", text: "Inspect the repo" },
      { kind: "reasoning", text: "Looking through the files" },
      { kind: "tool", text: "Read README.md" },
      { kind: "tool", text: "Check the compiled artifact" },
      { kind: "assistant", text: "Found the relevant section." },
    ]);
  });
});

describe("chat start", () => {
  it("rejects follow mode when no initial prompt is provided", async () => {
    await expect(startChat(undefined, { follow: true })).rejects.toThrow(
      "EXIT:`--follow` requires an initial prompt. Provide a prompt argument or `--stdin`.",
    );
  });

  it("fails when no compiled revision exists", async () => {
    revisionId = null;

    await expect(startChat("hello")).rejects.toThrow(
      "EXIT:No compiled revision found for 'demo-workspace'. Run `tokenspace push` first.",
    );
  });

  it("accepts stdin prompts and prints a JSON snapshot", async () => {
    await startChat(undefined, {
      stdin: true,
      json: true,
      model: "mock:model",
      input: Readable.from(["hello from stdin\n"]),
    });

    expect(createChatCalls).toEqual([{ revisionId: "revision_1", modelId: "mock:model" }]);
    expect(sendCalls).toEqual([{ chatId: "chat_new", prompt: "hello from stdin" }]);

    const output = JSON.parse(getConsoleText(logMock));
    expect(output.chat.id).toBe("chat_new");
    expect(output.url).toBe("https://app.example.test/workspace/demo-workspace/chat/chat_new");
    expect(output.messages).toHaveLength(2);
  });

  it("uses the configured default workspace when not in a linked directory", async () => {
    linkedWorkspaceRoot = null;
    defaultWorkspaceSlug = "demo-workspace";

    await startChat("hello", { json: true });

    expect(createChatCalls).toEqual([{ revisionId: "revision_1", modelId: undefined }]);
    const output = JSON.parse(getConsoleText(logMock));
    expect(output.chat.id).toBe("chat_new");
  });
});

describe("chat list", () => {
  it("collects paginated chats up to the requested limit and prints JSON", async () => {
    listChatsPages = [
      {
        chats: [
          {
            id: "chat_1",
            title: "First",
            status: "completed",
            createdAt: 1,
            messageCount: 1,
            isStarred: false,
          },
          {
            id: "chat_2",
            title: "Second",
            status: "streaming",
            createdAt: 2,
            messageCount: 2,
            isStarred: true,
          },
        ],
        isDone: false,
        continueCursor: "cursor_1",
      },
      {
        chats: [
          {
            id: "chat_3",
            title: "Third",
            status: "failed",
            createdAt: 3,
            messageCount: 3,
            isStarred: false,
          },
          {
            id: "chat_4",
            title: "Fourth",
            status: "completed",
            createdAt: 4,
            messageCount: 4,
            isStarred: false,
          },
        ],
        isDone: true,
      },
    ];

    await listChats({ limit: 3, json: true });

    const output = JSON.parse(getConsoleText(logMock));
    expect(output.workspace.slug).toBe("demo-workspace");
    expect(output.chats.map((chat: any) => chat.id)).toEqual(["chat_1", "chat_2", "chat_3"]);
    expect(output.chats[0].url).toBe("https://app.example.test/workspace/demo-workspace/chat/chat_1");
  });
});

describe("chat get", () => {
  it("prints ndjson follow output with status, message, and done events", async () => {
    chatSnapshots.chat_1 = {
      index: 0,
      snapshots: [
        makeChatSnapshot({
          chatId: "chat_1",
          status: "streaming",
          messages: [
            {
              _id: "m1",
              _creationTime: 1,
              threadId: "thread-chat_1",
              id: "m1",
              role: "user",
              parts: [{ type: "text", text: "hello" }],
            },
            {
              _id: "m2",
              _creationTime: 2,
              threadId: "thread-chat_1",
              id: "m2",
              role: "assistant",
              parts: [{ type: "text", text: "par" }],
            },
          ],
        }),
        makeChatSnapshot({
          chatId: "chat_1",
          status: "completed",
          messages: [
            {
              _id: "m1",
              _creationTime: 1,
              threadId: "thread-chat_1",
              id: "m1",
              role: "user",
              parts: [{ type: "text", text: "hello" }],
            },
            {
              _id: "m2",
              _creationTime: 2,
              threadId: "thread-chat_1",
              id: "m2",
              role: "assistant",
              parts: [{ type: "text", text: "partial response" }],
            },
          ],
        }),
      ],
    };

    await getChat("chat_1", { follow: true, ndjson: true, pollIntervalMs: 0 });

    const lines = getConsoleText(logMock)
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    expect(lines[0].type).toBe("chat");
    expect(lines[1].type).toBe("status");
    expect(lines.some((entry) => entry.type === "message" && entry.transcript?.text === "hello")).toBe(true);
    expect(lines.some((entry) => entry.type === "message" && entry.transcript?.text === "partial response")).toBe(true);
    expect(lines.at(-1)?.type).toBe("done");
  });
});

describe("chat send", () => {
  it("surfaces active-thread send errors", async () => {
    sendChatError = new Error("Thread thread-chat_1 status=streaming, cannot add message");

    await expect(sendMessageToChat("chat_1", "next step")).rejects.toThrow(
      "Thread thread-chat_1 status=streaming, cannot add message",
    );
  });
});
