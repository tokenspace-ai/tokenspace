import { readUIMessageStream, type UIMessageChunk } from "ai";
import type { ChatMessage, ChatMessagePart, ChatStatus, ChatThread } from "../client.js";
import { buildConversationStepItems, type ConversationStepItem } from "./chat.js";

export type TuiMessage = {
  id: string;
  role: "system" | "user" | "assistant";
  parts: ChatMessagePart[];
  metadata?: {
    _creationTime?: number;
    committedSeq?: number;
    status?: string;
  };
};

export type StreamingUpdates = {
  messages: Array<{
    msgId: string;
    parts: Array<Record<string, unknown>>;
  }>;
};

export function addConvexMetadata(message: ChatMessage): TuiMessage {
  return {
    id: message.id,
    role: message.role,
    parts: message.parts,
    metadata: {
      ...(typeof message.metadata === "object" && message.metadata !== null
        ? (message.metadata as Record<string, unknown>)
        : {}),
      _creationTime: message._creationTime,
      committedSeq: message.committedSeq,
      status: "success",
    },
  };
}

export function isThreadRunningStatus(status: ChatThread["status"] | ChatStatus | undefined): boolean {
  return status === "streaming" || status === "awaiting_tool_results";
}

export function splitConversationSteps(
  messages: TuiMessage[],
  status: ChatThread["status"] | ChatStatus | undefined,
): {
  staticSteps: ConversationStepItem[];
  liveSteps: ConversationStepItem[];
} {
  if (messages.length === 0) {
    return { staticSteps: [], liveSteps: [] };
  }

  const lastMessage = messages.at(-1);
  const isLiveAssistant = isThreadRunningStatus(status) && lastMessage?.role === "assistant";
  const staticMessages = isLiveAssistant ? messages.slice(0, -1) : messages;
  const liveMessages = isLiveAssistant && lastMessage ? [lastMessage] : [];

  return {
    staticSteps: buildConversationStepItems(staticMessages as ChatMessage[]),
    liveSteps: buildConversationStepItems(liveMessages as ChatMessage[]),
  };
}

export async function applyStreamingUpdates(
  messages: TuiMessage[],
  streamingUpdates: StreamingUpdates,
): Promise<TuiMessage[]> {
  const finalMessages = structuredClone(messages);
  const messageMap = new Map<string, number>();
  let committedSeq = -1;

  for (let index = 0; index < finalMessages.length; index += 1) {
    const message = finalMessages[index]!;
    messageMap.set(message.id, index);
    committedSeq = Math.max(committedSeq, message.metadata?.committedSeq ?? -1);
  }

  for (const update of streamingUpdates.messages) {
    const existingIndex = messageMap.get(update.msgId);
    let currentMessage: TuiMessage;

    if (existingIndex === undefined) {
      currentMessage = { id: update.msgId, role: "assistant", parts: [] };
      finalMessages.push(currentMessage);
      messageMap.set(update.msgId, finalMessages.length - 1);
    } else {
      currentMessage = finalMessages[existingIndex]!;
    }

    const parts = update.parts.filter((part) => {
      const seq = typeof part.seq === "number" ? part.seq : -1;
      return seq > committedSeq;
    });

    const stream = readUIMessageStream({
      message: currentMessage as never,
      stream: new ReadableStream({
        start(controller) {
          for (const part of parts) {
            controller.enqueue(part as UIMessageChunk);
          }
          controller.close();
        },
      }),
    });

    for await (const nextMessage of stream) {
      const next = nextMessage as TuiMessage;
      const nextIndex = messageMap.get(next.id);
      if (nextIndex === undefined) {
        finalMessages.push(next);
        messageMap.set(next.id, finalMessages.length - 1);
        continue;
      }
      finalMessages[nextIndex] = next;
    }
  }

  return finalMessages;
}
