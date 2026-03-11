import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import type { UIDataTypes, UIMessage } from "ai";
import { AlertTriangleIcon, SparklesIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { cn } from "@/lib/utils";
import { ChatMessage } from "./msg/chat-message";

type AgentTools = any;

type ChatConversationViewProps = {
  messages: UIMessage<unknown, UIDataTypes, AgentTools>[];
  sessionId?: Id<"sessions">;
  isLoading?: boolean;
  isGenerating?: boolean;
  isError?: boolean;
  errorMessage?: string | null;
  emptyStateTitle?: string;
  emptyStateDescription?: string;
  emptyStateIcon?: ReactNode;
  className?: string;
  contentClassName?: string;
  showScrollButton?: boolean;
};

export function ChatConversationView({
  messages,
  sessionId,
  isLoading = false,
  isGenerating = false,
  isError = false,
  errorMessage,
  emptyStateTitle = "Start a conversation",
  emptyStateDescription = "Ask me anything and I'll help you out.",
  emptyStateIcon = <SparklesIcon className="size-8" />,
  className,
  contentClassName,
  showScrollButton = true,
}: ChatConversationViewProps) {
  return (
    <Conversation className={cn("flex-1 min-h-0", className)}>
      <ConversationContent className={cn("w-full mx-auto max-w-3xl", contentClassName)}>
        {messages.length === 0 ? (
          !isLoading ? (
            <ConversationEmptyState title={emptyStateTitle} description={emptyStateDescription} icon={emptyStateIcon} />
          ) : (
            <div className="flex items-center justify-center py-20">
              <div className="text-xs text-muted-foreground">Loading...</div>
            </div>
          )
        ) : (
          <>
            {messages.map((message, index) => (
              <ChatMessage
                key={message.id}
                message={message}
                sessionId={sessionId}
                isLastMessage={index === messages.length - 1}
              />
            ))}
            <div>
              <div className={cn("bg-primary animate-pulse rounded-full size-3 mt-2", !isGenerating && "hidden")}>
                <span className="sr-only">Loading</span>
              </div>
            </div>
            {isError && (
              <div className="flex flex-col items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4">
                <div className="flex items-center gap-2 text-destructive">
                  <AlertTriangleIcon className="size-5" />
                  <span className="font-medium">Generation Failed</span>
                </div>
                {errorMessage && <p className="text-center text-sm text-muted-foreground">{errorMessage}</p>}
              </div>
            )}
          </>
        )}
      </ConversationContent>
      {showScrollButton ? <ConversationScrollButton /> : null}
    </Conversation>
  );
}
