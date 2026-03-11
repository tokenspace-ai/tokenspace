import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { useSmoothText } from "@tokenspace/convex-durable-agents/react";
import type { TextUIPart, ToolUIPart, UIDataTypes, UIMessage } from "ai";
import { MessageResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "../../ai-elements/reasoning";
import { RequestApprovalToolCall } from "./tools/approval";
import { SubAgentToolCall } from "./tools/sub-agent";
import { ToolPart } from "./tools/tool-part";
import type { AgentTools } from "./tools/types";

export function AssistantMessage({
  message,
  sessionId,
  isLastMessage,
}: {
  message: UIMessage<unknown, UIDataTypes, AgentTools>;
  sessionId?: Id<"sessions">;
  isLastMessage: boolean;
}) {
  const metadata = message.metadata as { status?: string } | undefined;
  const isFailed = metadata?.status === "failed";

  return (
    <>
      {message.parts.map((part, index) => {
        if (part.type === "text") {
          return (
            <div key={index} className="pt-2 pb-1">
              <TextPart textPart={part} />
            </div>
          );
        }
        if (part.type === "tool-requestApproval") {
          return sessionId ? (
            <RequestApprovalToolCall
              key={index}
              sessionId={sessionId}
              toolPart={part}
              isLastMessage={isLastMessage && index === message.parts.length - 1}
            />
          ) : null;
        }
        if (part.type === "tool-subAgent") {
          return <SubAgentToolCall key={index} toolPart={part} />;
        }
        if (part.type.startsWith("tool-")) {
          return (
            <ToolPart
              key={index}
              part={part as ToolUIPart<AgentTools>}
              isLastMessage={isLastMessage && index === message.parts.length - 1}
            />
          );
        }
        if (part.type === "reasoning") {
          return (
            <Reasoning key={index} className="w-full py-1" isStreaming={part.state === "streaming"} defaultOpen={false}>
              <ReasoningTrigger />
              <ReasoningContent>{part.text}</ReasoningContent>
            </Reasoning>
          );
        }
        return null;
      })}
      {isFailed ? (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          Something went wrong. Please try again.
        </div>
      ) : null}
    </>
  );
}

function TextPart({ textPart }: { textPart: TextUIPart }) {
  const [visibleText] = useSmoothText(textPart.text, {
    startStreaming: textPart.state === "streaming",
  });

  return (
    <div className="relative space-y-4">
      <MessageResponse
        className={cn(
          "prose prose-sm prose-invert max-w-none",
          "prose-p:leading-relaxed prose-p:my-2",
          "prose-headings:font-semibold prose-headings:tracking-tight",
          "prose-code:rounded prose-code:bg-secondary prose-code:px-1.5 prose-code:py-0.5 prose-code:text-xs",
          "prose-pre:bg-secondary/80 prose-pre:border prose-pre:border-border/40",
          "prose-a:text-primary prose-a:no-underline hover:prose-a:underline",
        )}
      >
        {visibleText}
      </MessageResponse>
    </div>
  );
}
