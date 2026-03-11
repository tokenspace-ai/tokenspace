import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import type { UIDataTypes, UIMessage } from "ai";
import { UserIcon } from "lucide-react";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import { AssistantMessage } from "./assistant-message";
import { UserMessageContent } from "./user-message";

type AgentTools = any;

export function ChatMessage({
  message,
  sessionId,
  isLastMessage,
}: {
  message: UIMessage<unknown, UIDataTypes, AgentTools>;
  sessionId?: Id<"sessions">;
  isLastMessage?: boolean;
}) {
  const isUser = message.role === "user";

  return (
    <Message
      from={message.role}
      data-testid={`message-${message.id}`}
      className={cn("", isUser ? "py-2" : "max-w-full")}
    >
      <div className={cn("flex gap-3", isUser ? "flex-row-reverse" : "flex-row")}>
        {isUser && (
          <div className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary")}>
            <UserIcon className="size-4 text-muted-foreground" />
          </div>
        )}

        <MessageContent
          className={cn(isUser ? "rounded-2xl rounded-tr-sm bg-secondary px-4 py-3" : "max-w-none flex-1")}
        >
          {isUser ? (
            <UserMessageContent message={message} />
          ) : (
            <AssistantMessage message={message} sessionId={sessionId} isLastMessage={!!isLastMessage} />
          )}
        </MessageContent>
      </div>
    </Message>
  );
}
