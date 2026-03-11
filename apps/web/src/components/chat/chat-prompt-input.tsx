import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import type { ChatStatus } from "ai";
import type { ReactNode } from "react";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { ConnectedModelSelector } from "@/components/chat/model-selector";

export type { PromptInputMessage };

interface ChatPromptInputProps {
  onSubmit: (message: PromptInputMessage) => void;
  onStop?: () => void;
  currentModelId: string;
  onModelSelect: (modelId: string) => void;
  revisionId?: Id<"revisions">;
  disabled?: boolean;
  status?: ChatStatus;
  placeholder?: string;
  textareaClassName?: string;
  /** Extra elements rendered inside PromptInputTools, after the model selector */
  extraTools?: ReactNode;
  className?: string;
}

export function ChatPromptInput({
  onSubmit,
  onStop,
  currentModelId,
  onModelSelect,
  revisionId,
  disabled,
  status = "ready",
  placeholder = "Send a message...",
  textareaClassName = "min-h-[52px] resize-none border-0 bg-transparent px-4 py-3.5 focus-visible:ring-0",
  extraTools,
  className = "rounded-2xl border border-border/60 bg-secondary/30 shadow-lg backdrop-blur-sm transition-all focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/15",
}: ChatPromptInputProps) {
  const isStopMode = status === "streaming" && onStop != null;

  return (
    <PromptInput onSubmit={onSubmit} className={className}>
      <PromptInputAttachments>{(attachment) => <PromptInputAttachment data={attachment} />}</PromptInputAttachments>
      <PromptInputTextarea placeholder={placeholder} className={textareaClassName} disabled={disabled || isStopMode} />
      <PromptInputFooter className="px-3 pb-3">
        <PromptInputTools>
          <PromptInputActionMenu>
            <PromptInputActionMenuTrigger />
            <PromptInputActionMenuContent>
              <PromptInputActionAddAttachments />
            </PromptInputActionMenuContent>
          </PromptInputActionMenu>
          <ConnectedModelSelector
            currentModelId={currentModelId}
            onModelSelect={onModelSelect}
            revisionId={revisionId}
          />
          {extraTools}
        </PromptInputTools>
        <PromptInputSubmit
          disabled={disabled}
          status={status}
          type={isStopMode ? "button" : "submit"}
          onClick={isStopMode ? onStop : undefined}
          aria-label={isStopMode ? "Stop" : "Submit"}
          title={isStopMode ? "Stop" : undefined}
          className="rounded-xl bg-primary text-primary-foreground shadow-sm transition-all hover:bg-primary/90 active:scale-95 disabled:opacity-50 disabled:active:scale-100"
        />
      </PromptInputFooter>
    </PromptInput>
  );
}
