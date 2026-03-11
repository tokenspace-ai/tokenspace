import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import type { UIDataTypes, UIMessage } from "ai";

type AgentTools = any;

const PENDING_CHAT_BOOTSTRAP_TTL_MS = 2 * 60 * 1000;

export type PendingChatBootstrap = {
  createdAt: number;
  modelId: string;
  messages: UIMessage<unknown, UIDataTypes, AgentTools>[];
};

const pendingChatBootstraps = new Map<Id<"chats">, PendingChatBootstrap>();

function pruneExpiredPendingChatBootstraps() {
  const now = Date.now();
  for (const [chatId, bootstrap] of pendingChatBootstraps) {
    if (now - bootstrap.createdAt > PENDING_CHAT_BOOTSTRAP_TTL_MS) {
      pendingChatBootstraps.delete(chatId);
    }
  }
}

export function setPendingChatBootstrap(chatId: Id<"chats">, bootstrap: Omit<PendingChatBootstrap, "createdAt">) {
  pruneExpiredPendingChatBootstraps();
  pendingChatBootstraps.set(chatId, {
    ...bootstrap,
    createdAt: Date.now(),
  });
}

export function getPendingChatBootstrap(chatId: Id<"chats">): PendingChatBootstrap | undefined {
  pruneExpiredPendingChatBootstraps();
  return pendingChatBootstraps.get(chatId);
}

export function clearPendingChatBootstrap(chatId: Id<"chats">) {
  pendingChatBootstraps.delete(chatId);
}
