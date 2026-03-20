import type { Readable } from "node:stream";
import pc from "picocolors";
import { getDefaultWorkspaceSlug } from "../auth.js";
import { buildChatUrl, openUrl } from "../browser.js";
import {
  type Branch,
  type ChatDetails,
  type ChatMessage,
  type ChatMessagePart,
  type ChatStatus,
  type ChatSummary,
  type ChatThread,
  createChat,
  exitWithError,
  getChatDetails,
  getChatThread,
  getCurrentWorkingStateHash,
  getDefaultBranch,
  getWorkspaceBySlug,
  getWorkspaceRevision,
  listChatMessages,
  listChatsForWorkspace,
  sendChatMessage,
  type Workspace,
} from "../client.js";
import {
  findNearestLinkedWorkspaceRoot,
  printWorkspaceResolution,
  readLinkedWorkspaceConfig,
} from "../local-workspace.js";
import { readStdinValue } from "../stdin.js";

const DEFAULT_LIST_LIMIT = 20;
const FOLLOW_POLL_INTERVAL_MS = 750;

type LinkedWorkspaceContext = {
  resolvedDir?: string;
  resolution: "linked" | "default" | "flag";
  workspace: Workspace;
};

type LinkedWorkspaceRevisionContext = LinkedWorkspaceContext & {
  branch: Branch;
  revisionId: NonNullable<Awaited<ReturnType<typeof getWorkspaceRevision>>>;
};

export type TranscriptEntry = {
  id: string;
  role: "user" | "assistant";
  text: string;
  markers: string[];
};

export type ChatSnapshot = {
  chat: ChatDetails;
  thread: ChatThread | null;
  url: string;
  messages: ChatMessage[];
  transcript: TranscriptEntry[];
};

export type StartChatOptions = {
  workspace?: string;
  stdin?: boolean;
  model?: string;
  open?: boolean;
  follow?: boolean;
  json?: boolean;
  ndjson?: boolean;
  input?: Readable;
  pollIntervalMs?: number;
};

export type ListChatsOptions = {
  workspace?: string;
  limit?: number;
  all?: boolean;
  json?: boolean;
};

export type GetChatOptions = {
  workspace?: string;
  follow?: boolean;
  json?: boolean;
  ndjson?: boolean;
  pollIntervalMs?: number;
};

export type SendChatOptions = {
  workspace?: string;
  stdin?: boolean;
  follow?: boolean;
  json?: boolean;
  ndjson?: boolean;
  input?: Readable;
  pollIntervalMs?: number;
};

type FollowEvent =
  | { type: "chat"; snapshot: ChatSnapshot }
  | { type: "status"; snapshot: ChatSnapshot; changed: { chatStatus?: ChatStatus; threadStatus?: string } }
  | { type: "message"; snapshot: ChatSnapshot; message: ChatMessage; transcript?: TranscriptEntry; initial: boolean }
  | { type: "done"; snapshot: ChatSnapshot; interrupted: boolean };

type FollowChatOptions = {
  chatId: string;
  workspaceSlug: string;
  initialSnapshot?: ChatSnapshot;
  emitInitial?: boolean;
  pollIntervalMs?: number;
  onEvent: (event: FollowEvent) => void | Promise<void>;
};

function formatTimestamp(timestamp: number | undefined): string {
  return timestamp ? new Date(timestamp).toISOString() : "unknown";
}

function statusLabel(status: ChatStatus | undefined): string {
  return status ?? "unknown";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPromptPresent(prompt: string | undefined): boolean {
  return typeof prompt === "string" && prompt.trim().length > 0;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function validateStructuredOutputFlags(options: { follow?: boolean; json?: boolean; ndjson?: boolean }): void {
  if (options.json && options.ndjson) {
    exitWithError("Choose either `--json` or `--ndjson`, not both.");
  }
  if (options.json && options.follow) {
    exitWithError("`--json` is snapshot-only. Use `--ndjson --follow` for machine-readable follow mode.");
  }
  if (options.ndjson && !options.follow) {
    exitWithError("`--ndjson` requires `--follow`.");
  }
}

async function readPromptInput(
  prompt: string | undefined,
  options: { stdin?: boolean; input?: Readable },
): Promise<string | undefined> {
  if (options.stdin && prompt !== undefined) {
    exitWithError("Provide either a prompt argument or `--stdin`, not both.");
  }
  if (!options.stdin) {
    return prompt;
  }
  return await readStdinValue(options.input);
}

function printWorkspaceSource(context: LinkedWorkspaceContext): void {
  if (context.resolution === "linked" && context.resolvedDir) {
    printWorkspaceResolution("Workspace", context.resolvedDir);
    return;
  }

  const prefix = context.resolution === "default" ? "  Default workspace: " : "  Workspace: ";
  console.log(pc.dim(`${prefix}${context.workspace.slug}`));
}

async function loadLinkedWorkspaceContext(workspaceSlug?: string): Promise<LinkedWorkspaceContext> {
  const explicitWorkspaceSlug = workspaceSlug?.trim();
  if (explicitWorkspaceSlug) {
    const workspace = await getWorkspaceBySlug(explicitWorkspaceSlug);
    if (!workspace) {
      exitWithError(`Tokenspace '${explicitWorkspaceSlug}' not found`);
    }
    return {
      resolution: "flag",
      workspace,
    };
  }

  const resolvedDir = await findNearestLinkedWorkspaceRoot(process.cwd());
  if (resolvedDir) {
    const linked = await readLinkedWorkspaceConfig(resolvedDir);
    if (!linked) {
      exitWithError("Linked tokenspace metadata is missing or invalid.");
    }

    const workspace = await getWorkspaceBySlug(linked.workspaceSlug);
    if (!workspace) {
      exitWithError(`Tokenspace '${linked.workspaceSlug}' not found`);
    }

    return {
      resolvedDir,
      resolution: "linked",
      workspace,
    };
  }

  const defaultWorkspaceSlug = getDefaultWorkspaceSlug();
  if (defaultWorkspaceSlug) {
    const workspace = await getWorkspaceBySlug(defaultWorkspaceSlug);
    if (!workspace) {
      exitWithError(
        `Default tokenspace '${defaultWorkspaceSlug}' was not found. Run \`tokenspace use <slug>\` to choose another.`,
      );
    }

    return {
      resolution: "default",
      workspace,
    };
  }

  exitWithError(
    "No linked tokenspace found and no default workspace is configured. Use `--workspace <slug>` or run `tokenspace use <slug>`.",
  );
}

async function loadLinkedWorkspaceRevisionContext(workspaceSlug?: string): Promise<LinkedWorkspaceRevisionContext> {
  const context = await loadLinkedWorkspaceContext(workspaceSlug);
  const branch = await getDefaultBranch(context.workspace._id);
  if (!branch) {
    exitWithError(`No default branch found in tokenspace '${context.workspace.slug}'`);
  }

  const workingStateHash = (await getCurrentWorkingStateHash(context.workspace._id, branch._id)) ?? undefined;
  const revisionId = await getWorkspaceRevision(context.workspace._id, branch._id, workingStateHash);
  if (!revisionId) {
    exitWithError(`No compiled revision found for '${context.workspace.slug}'. Run \`tokenspace push\` first.`);
  }

  return {
    ...context,
    branch,
    revisionId,
  };
}

function describeNonTextPart(part: ChatMessagePart): string | null {
  const type = isNonEmptyString(part.type) ? part.type : "part";
  const state = isNonEmptyString(part.state) ? ` ${part.state}` : "";

  if (isNonEmptyString(part.toolName)) {
    return `[tool ${part.toolName}${state}]`;
  }

  if (type === "text") {
    return null;
  }

  return `[${type}${state}]`;
}

function getTextFromParts(parts: ChatMessagePart[]): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("");
}

export function getTranscriptEntry(message: ChatMessage): TranscriptEntry | null {
  if (message.role !== "user" && message.role !== "assistant") {
    return null;
  }

  return {
    id: message.id,
    role: message.role,
    text: getTextFromParts(message.parts),
    markers: message.parts.map(describeNonTextPart).filter((value): value is string => value !== null),
  };
}

export function buildTranscript(messages: ChatMessage[]): TranscriptEntry[] {
  return messages.map(getTranscriptEntry).filter((entry): entry is TranscriptEntry => entry !== null);
}

function printTranscriptEntry(entry: TranscriptEntry): void {
  const label = entry.role === "user" ? pc.cyan("User") : pc.green("Assistant");
  console.log(label);
  if (entry.text) {
    console.log(entry.text);
  }
  if (entry.markers.length > 0) {
    for (const marker of entry.markers) {
      console.log(pc.dim(marker));
    }
  }
  console.log("");
}

function printChatHeader(args: { context: LinkedWorkspaceContext; snapshot: ChatSnapshot }): void {
  const { context, snapshot } = args;
  console.log(pc.cyan(`Chat ${pc.bold(snapshot.chat.id)}`));
  printWorkspaceSource(context);
  console.log(pc.dim(`  URL: ${snapshot.url}`));
  console.log(pc.dim(`  Title: ${snapshot.chat.title || "Untitled"}`));
  console.log(pc.dim(`  Status: ${statusLabel(snapshot.chat.status)}`));
  console.log(pc.dim(`  Created: ${formatTimestamp(snapshot.chat.createdAt)}`));
  console.log(pc.dim(`  Messages: ${snapshot.chat.messageCount ?? snapshot.transcript.length}`));
  if (snapshot.chat.errorMessage) {
    console.log(pc.red(`  Error: ${snapshot.chat.errorMessage}`));
  }
  console.log("");
}

function printStartOrSendSummary(args: {
  action: "Started" | "Updated";
  context: LinkedWorkspaceContext;
  snapshot: ChatSnapshot;
}): void {
  const { action, context, snapshot } = args;
  console.log(pc.cyan(`${action} chat ${pc.bold(snapshot.chat.id)}`));
  printWorkspaceSource(context);
  console.log(pc.dim(`  URL: ${snapshot.url}`));
  console.log(pc.dim(`  Status: ${statusLabel(snapshot.chat.status)}`));
  console.log(pc.dim(`  Title: ${snapshot.chat.title || "Untitled"}`));
}

function printListTable(args: { context: LinkedWorkspaceContext; chats: ChatSummary[] }): void {
  const { context, chats } = args;
  console.log(pc.cyan(`Listing chats for ${pc.bold(context.workspace.slug)}`));
  printWorkspaceSource(context);
  console.log("");

  if (chats.length === 0) {
    console.log(pc.dim("No chats found."));
    return;
  }

  const idWidth = Math.max("ID".length, ...chats.map((chat) => chat.id.length));
  const statusWidth = Math.max("STATUS".length, ...chats.map((chat) => statusLabel(chat.status).length));
  const countWidth = Math.max("MSGS".length, ...chats.map((chat) => String(chat.messageCount).length));

  console.log(
    ["ID".padEnd(idWidth), "STATUS".padEnd(statusWidth), "MSGS".padStart(countWidth), "CREATED", "TITLE"].join("  "),
  );

  for (const chat of chats) {
    console.log(
      [
        chat.id.padEnd(idWidth),
        statusLabel(chat.status).padEnd(statusWidth),
        String(chat.messageCount).padStart(countWidth),
        formatTimestamp(chat.createdAt),
        chat.title || "Untitled",
      ].join("  "),
    );
    console.log(pc.dim(`  ${buildChatUrl(context.workspace.slug, chat.id)}`));
  }
}

function assertChatBelongsToWorkspace(chat: ChatDetails, workspace: Workspace): void {
  if (!chat.workspaceId || chat.workspaceId !== workspace._id) {
    exitWithError(`Chat '${chat.id}' does not belong to tokenspace '${workspace.slug}'.`);
  }
}

export async function loadChatSnapshot(chatId: string, workspaceSlug: string): Promise<ChatSnapshot> {
  const chat = await getChatDetails(chatId);
  if (!chat) {
    exitWithError(`Chat '${chatId}' not found.`);
  }

  const messages = await listChatMessages(chat.threadId);
  const thread = await getChatThread(chat.threadId);
  return {
    chat,
    thread,
    url: buildChatUrl(workspaceSlug, chat.id),
    messages,
    transcript: buildTranscript(messages),
  };
}

function printSnapshotJson(snapshot: ChatSnapshot): void {
  console.log(JSON.stringify(snapshot, null, 2));
}

function printFollowEventNdjson(event: FollowEvent): void {
  switch (event.type) {
    case "chat":
      console.log(
        JSON.stringify({
          type: "chat",
          chat: event.snapshot.chat,
          thread: event.snapshot.thread,
          url: event.snapshot.url,
        }),
      );
      return;
    case "status":
      console.log(
        JSON.stringify({
          type: "status",
          chatId: event.snapshot.chat.id,
          chatStatus: event.snapshot.chat.status,
          threadStatus: event.snapshot.thread?.status,
          changed: event.changed,
        }),
      );
      return;
    case "message":
      console.log(
        JSON.stringify({
          type: "message",
          chatId: event.snapshot.chat.id,
          initial: event.initial,
          message: event.message,
          transcript: event.transcript,
        }),
      );
      return;
    case "done":
      console.log(
        JSON.stringify({
          type: "done",
          chatId: event.snapshot.chat.id,
          chatStatus: event.snapshot.chat.status,
          threadStatus: event.snapshot.thread?.status,
          interrupted: event.interrupted,
        }),
      );
      return;
  }
}

function isTerminalSnapshot(snapshot: ChatSnapshot): boolean {
  return (
    snapshot.chat.status === "completed" ||
    snapshot.chat.status === "failed" ||
    snapshot.chat.status === "stopped" ||
    snapshot.chat.status === "waiting_for_approval"
  );
}

async function emitInitialFollowState(args: {
  snapshot: ChatSnapshot;
  messageSignatures: Map<string, string>;
  onEvent: FollowChatOptions["onEvent"];
}): Promise<void> {
  await args.onEvent({ type: "chat", snapshot: args.snapshot });
  await args.onEvent({
    type: "status",
    snapshot: args.snapshot,
    changed: {
      chatStatus: args.snapshot.chat.status,
      threadStatus: args.snapshot.thread?.status,
    },
  });

  for (const message of args.snapshot.messages) {
    args.messageSignatures.set(message.id, JSON.stringify({ role: message.role, parts: message.parts }));
    await args.onEvent({
      type: "message",
      snapshot: args.snapshot,
      message,
      transcript: getTranscriptEntry(message) ?? undefined,
      initial: true,
    });
  }
}

export async function followChat(options: FollowChatOptions): Promise<ChatSnapshot> {
  const messageSignatures = new Map<string, string>();
  let snapshot = options.initialSnapshot ?? (await loadChatSnapshot(options.chatId, options.workspaceSlug));

  let lastChatStatus = snapshot.chat.status;
  let lastThreadStatus = snapshot.thread?.status;
  let interrupted = false;

  const sigintHandler = () => {
    interrupted = true;
  };
  process.on("SIGINT", sigintHandler);

  try {
    if (options.emitInitial !== false) {
      await emitInitialFollowState({ snapshot, messageSignatures, onEvent: options.onEvent });
    } else {
      for (const message of snapshot.messages) {
        messageSignatures.set(message.id, JSON.stringify({ role: message.role, parts: message.parts }));
      }
    }

    while (!interrupted && !isTerminalSnapshot(snapshot)) {
      await sleep(options.pollIntervalMs ?? FOLLOW_POLL_INTERVAL_MS);
      snapshot = await loadChatSnapshot(options.chatId, options.workspaceSlug);

      if (snapshot.chat.status !== lastChatStatus || snapshot.thread?.status !== lastThreadStatus) {
        lastChatStatus = snapshot.chat.status;
        lastThreadStatus = snapshot.thread?.status;
        await options.onEvent({
          type: "status",
          snapshot,
          changed: {
            chatStatus: snapshot.chat.status,
            threadStatus: snapshot.thread?.status,
          },
        });
      }

      for (const message of snapshot.messages) {
        const signature = JSON.stringify({ role: message.role, parts: message.parts });
        if (messageSignatures.get(message.id) === signature) {
          continue;
        }
        messageSignatures.set(message.id, signature);
        await options.onEvent({
          type: "message",
          snapshot,
          message,
          transcript: getTranscriptEntry(message) ?? undefined,
          initial: false,
        });
      }
    }

    await options.onEvent({ type: "done", snapshot, interrupted });
    return snapshot;
  } finally {
    process.off("SIGINT", sigintHandler);
  }
}

async function collectChats(context: LinkedWorkspaceContext, options: ListChatsOptions): Promise<ChatSummary[]> {
  if (options.limit !== undefined && (!Number.isFinite(options.limit) || options.limit < 1)) {
    exitWithError("`--limit` must be a positive integer.");
  }
  const limit = Math.max(1, options.limit ?? DEFAULT_LIST_LIMIT);
  const chats: ChatSummary[] = [];
  let cursor: string | null = null;

  while (true) {
    const pageSize = options.all ? 100 : Math.min(100, limit - chats.length);
    const result = await listChatsForWorkspace(context.workspace._id, {
      limit: pageSize,
      cursor,
    });
    chats.push(...result.chats);

    if (options.all) {
      if (result.isDone || !result.continueCursor) {
        break;
      }
      cursor = result.continueCursor;
      continue;
    }

    if (chats.length >= limit || result.isDone || !result.continueCursor) {
      break;
    }
    cursor = result.continueCursor;
  }

  return options.all ? chats : chats.slice(0, limit);
}

export async function startChat(promptArg: string | undefined, options: StartChatOptions = {}): Promise<void> {
  validateStructuredOutputFlags(options);
  const prompt = await readPromptInput(promptArg, options);
  if (options.follow && !isPromptPresent(prompt)) {
    exitWithError("`--follow` requires an initial prompt. Provide a prompt argument or `--stdin`.");
  }

  const context = await loadLinkedWorkspaceRevisionContext(options.workspace);
  const created = await createChat(context.revisionId, options.model);
  if (isPromptPresent(prompt)) {
    await sendChatMessage(created.chatId, prompt!);
  }

  const snapshot = await loadChatSnapshot(created.chatId, context.workspace.slug);
  assertChatBelongsToWorkspace(snapshot.chat, context.workspace);

  if (options.open) {
    await openUrl(snapshot.url);
  }

  if (options.json) {
    printSnapshotJson(snapshot);
    return;
  }

  if (options.ndjson) {
    const finalSnapshot = await followChat({
      chatId: snapshot.chat.id,
      workspaceSlug: context.workspace.slug,
      initialSnapshot: snapshot,
      pollIntervalMs: options.pollIntervalMs,
      onEvent: printFollowEventNdjson,
    });
    if (finalSnapshot.chat.status === "failed") {
      exitWithError(finalSnapshot.chat.errorMessage ?? `Chat '${finalSnapshot.chat.id}' failed.`);
    }
    return;
  }

  printStartOrSendSummary({ action: "Started", context, snapshot });
  if (!options.follow) {
    return;
  }

  console.log("");
  const finalSnapshot = await followChat({
    chatId: snapshot.chat.id,
    workspaceSlug: context.workspace.slug,
    initialSnapshot: snapshot,
    emitInitial: false,
    pollIntervalMs: options.pollIntervalMs,
    onEvent: (event) => {
      if (event.type === "status") {
        console.log(pc.dim(`[status] ${statusLabel(event.snapshot.chat.status)}`));
        return;
      }
      if (event.type === "message" && event.transcript) {
        printTranscriptEntry(event.transcript);
      }
    },
  });
  if (finalSnapshot.chat.status === "failed") {
    exitWithError(finalSnapshot.chat.errorMessage ?? `Chat '${finalSnapshot.chat.id}' failed.`);
  }
}

export async function listChats(options: ListChatsOptions = {}): Promise<void> {
  const context = await loadLinkedWorkspaceContext(options.workspace);
  const chats = await collectChats(context, options);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          workspace: {
            id: context.workspace._id,
            slug: context.workspace.slug,
          },
          chats: chats.map((chat) => ({
            ...chat,
            url: buildChatUrl(context.workspace.slug, chat.id),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  printListTable({ context, chats });
}

export async function getChat(chatId: string, options: GetChatOptions = {}): Promise<void> {
  validateStructuredOutputFlags(options);
  const context = await loadLinkedWorkspaceContext(options.workspace);
  const snapshot = await loadChatSnapshot(chatId, context.workspace.slug);
  assertChatBelongsToWorkspace(snapshot.chat, context.workspace);

  if (options.json) {
    printSnapshotJson(snapshot);
    return;
  }

  if (options.ndjson) {
    const finalSnapshot = await followChat({
      chatId: snapshot.chat.id,
      workspaceSlug: context.workspace.slug,
      initialSnapshot: snapshot,
      pollIntervalMs: options.pollIntervalMs,
      onEvent: printFollowEventNdjson,
    });
    if (finalSnapshot.chat.status === "failed") {
      exitWithError(finalSnapshot.chat.errorMessage ?? `Chat '${finalSnapshot.chat.id}' failed.`);
    }
    return;
  }

  printChatHeader({ context, snapshot });
  for (const entry of snapshot.transcript) {
    printTranscriptEntry(entry);
  }

  if (!options.follow) {
    return;
  }

  const finalSnapshot = await followChat({
    chatId: snapshot.chat.id,
    workspaceSlug: context.workspace.slug,
    initialSnapshot: snapshot,
    emitInitial: false,
    pollIntervalMs: options.pollIntervalMs,
    onEvent: (event) => {
      if (event.type === "status") {
        console.log(pc.dim(`[status] ${statusLabel(event.snapshot.chat.status)}`));
        return;
      }
      if (event.type === "message" && event.transcript) {
        printTranscriptEntry(event.transcript);
      }
    },
  });
  if (finalSnapshot.chat.status === "failed") {
    exitWithError(finalSnapshot.chat.errorMessage ?? `Chat '${finalSnapshot.chat.id}' failed.`);
  }
}

export async function sendMessageToChat(
  chatId: string,
  promptArg: string | undefined,
  options: SendChatOptions = {},
): Promise<void> {
  validateStructuredOutputFlags(options);
  const prompt = await readPromptInput(promptArg, options);
  if (!isPromptPresent(prompt)) {
    exitWithError("A prompt is required. Provide a prompt argument or `--stdin`.");
  }

  const context = await loadLinkedWorkspaceContext(options.workspace);
  const existing = await getChatDetails(chatId);
  if (!existing) {
    exitWithError(`Chat '${chatId}' not found.`);
  }
  assertChatBelongsToWorkspace(existing, context.workspace);

  await sendChatMessage(existing.id, prompt!);

  const snapshot = await loadChatSnapshot(existing.id, context.workspace.slug);
  if (options.json) {
    printSnapshotJson(snapshot);
    return;
  }

  if (options.ndjson) {
    const finalSnapshot = await followChat({
      chatId: snapshot.chat.id,
      workspaceSlug: context.workspace.slug,
      initialSnapshot: snapshot,
      pollIntervalMs: options.pollIntervalMs,
      onEvent: printFollowEventNdjson,
    });
    if (finalSnapshot.chat.status === "failed") {
      exitWithError(finalSnapshot.chat.errorMessage ?? `Chat '${finalSnapshot.chat.id}' failed.`);
    }
    return;
  }

  printStartOrSendSummary({ action: "Updated", context, snapshot });
  if (!options.follow) {
    return;
  }

  console.log("");
  const finalSnapshot = await followChat({
    chatId: snapshot.chat.id,
    workspaceSlug: context.workspace.slug,
    initialSnapshot: snapshot,
    emitInitial: false,
    pollIntervalMs: options.pollIntervalMs,
    onEvent: (event) => {
      if (event.type === "status") {
        console.log(pc.dim(`[status] ${statusLabel(event.snapshot.chat.status)}`));
        return;
      }
      if (event.type === "message" && event.transcript) {
        printTranscriptEntry(event.transcript);
      }
    },
  });
  if (finalSnapshot.chat.status === "failed") {
    exitWithError(finalSnapshot.chat.errorMessage ?? `Chat '${finalSnapshot.chat.id}' failed.`);
  }
}
