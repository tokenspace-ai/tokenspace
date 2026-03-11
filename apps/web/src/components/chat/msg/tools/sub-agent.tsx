import { api } from "@tokenspace/backend/convex/_generated/api";
import type { ToolUIPart } from "ai";
import { useQuery } from "convex/react";
import { AlertTriangleIcon, BotIcon, CheckCircle2Icon, ChevronRightIcon, Clock3Icon } from "lucide-react";
import { useCallback } from "react";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useChatSidebarOptional } from "../../chat-sidebar";
import { ToolCallDisplay } from "./tool-call-display";
import type { AgentTools } from "./types";

export function SubAgentToolCall({ toolPart }: { toolPart: ToolUIPart<AgentTools> & { type: "tool-subAgent" } }) {
  if (!toolPart.input) return null;
  if (toolPart.input.threadIds) {
    return (
      <ToolCallDisplay
        text={`Waiting for ${toolPart.input.threadIds.length} sub-agents to complete`}
        icon={BotIcon}
        part={toolPart}
      />
    );
  }
  return <SubAgentStatus toolPart={toolPart} />;
}

function SubAgentStatus({ toolPart }: { toolPart: ToolUIPart<AgentTools> & { type: "tool-subAgent" } }) {
  const sidebar = useChatSidebarOptional();
  const referenceThreadId = resolveReferencedThreadId(toolPart);
  const subAgent = useQuery(
    api.ai.subagent.getSubAgentStatus,
    sidebar?.sessionId
      ? {
          sessionId: sidebar.sessionId,
          toolCallId: toolPart.toolCallId,
          threadId: referenceThreadId,
        }
      : "skip",
  );

  const threadId = subAgent?.threadId ?? referenceThreadId;
  const status = subAgent?.status ?? mapToolStateToSubAgentStatus(toolPart.state);
  const prompt = toolPart.input?.prompt;
  const promptSnippet = truncate(prompt, 140);
  const activity = getActivityText({
    status,
    profile: subAgent?.profile,
    fallbackPrompt: promptSnippet,
  });
  const isActive = status === "initializing" || status === "running" || status === "awaiting_tool_results";
  const isError = status === "failed" || toolPart.state === "output-error";
  const canOpenConversation = !!sidebar && !!threadId;
  const isShownInSidebar =
    sidebar?.sidebarSection === "debug" &&
    sidebar?.debugView === "subagents" &&
    !!threadId &&
    sidebar?.subAgentThreadId === threadId;

  const handleClick = useCallback(() => {
    if (!canOpenConversation || !threadId || !sidebar) return;
    sidebar.openSubAgentConversation(threadId);
  }, [canOpenConversation, threadId, sidebar]);

  return (
    <button
      type="button"
      className={cn(
        "mb-2 w-full rounded-md border bg-card px-3 py-2 text-left transition-colors",
        canOpenConversation ? "cursor-pointer hover:bg-muted/40" : "cursor-default",
        isShownInSidebar && "border-primary/40 bg-muted/60",
      )}
      onClick={handleClick}
      disabled={!canOpenConversation}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <BotIcon className="size-4 text-muted-foreground" />
          <span className="font-medium text-sm">Sub-agent</span>
          {status ? <StatusBadge status={status} /> : null}
        </div>
        {canOpenConversation ? <ChevronRightIcon className="size-4 text-muted-foreground" /> : null}
      </div>
      <div className="mt-2 flex items-start gap-2 text-xs text-muted-foreground">
        <StatusIcon isActive={isActive} isError={isError} />
        <div className="min-w-0">{isActive ? <Shimmer>{activity}</Shimmer> : <span>{activity}</span>}</div>
      </div>
      {!isActive && promptSnippet && !activity.includes(promptSnippet) ? (
        <p className="mt-1 text-muted-foreground text-xs">{promptSnippet}</p>
      ) : null}
    </button>
  );
}

function resolveReferencedThreadId(toolPart: ToolUIPart<AgentTools> & { type: "tool-subAgent" }): string | undefined {
  if (typeof toolPart.input?.threadId === "string" && toolPart.input.threadId.length > 0) {
    return toolPart.input.threadId;
  }

  const output = toolPart.output as any;
  if (output && typeof output === "object") {
    if (typeof output.threadId === "string" && output.threadId.length > 0) {
      return output.threadId;
    }
    if (Array.isArray(output.threads) && output.threads.length === 1) {
      const threadId = output.threads[0]?.threadId;
      if (typeof threadId === "string" && threadId.length > 0) {
        return threadId;
      }
    }
  }
  return undefined;
}

function mapToolStateToSubAgentStatus(state: ToolUIPart<AgentTools>["state"]) {
  switch (state) {
    case "input-streaming":
      return "initializing";
    case "input-available":
      return "running";
    case "output-available":
      return "completed";
    case "output-error":
      return "failed";
    default:
      return undefined;
  }
}

function getActivityText({
  status,
  profile,
  fallbackPrompt,
}: {
  status: string | undefined;
  profile: string | undefined;
  fallbackPrompt: string | undefined;
}) {
  if (!status) {
    return fallbackPrompt ? `Prompt: ${fallbackPrompt}` : "Preparing sub-agent...";
  }

  switch (status) {
    case "initializing":
      return "Initializing sub-agent...";
    case "running":
      return profile === "web_search" ? "Searching the web..." : "Working on the task...";
    case "awaiting_tool_results":
      return "Waiting for tool results...";
    case "completed":
      return "Sub-agent completed.";
    case "failed":
      return "Sub-agent failed.";
    case "stopped":
      return "Sub-agent stopped.";
    case "detached":
      return "Sub-agent running in background.";
    default:
      return fallbackPrompt ? `Prompt: ${fallbackPrompt}` : "Sub-agent started.";
  }
}

function StatusBadge({
  status,
}: {
  status: "initializing" | "running" | "awaiting_tool_results" | "completed" | "failed" | "stopped" | "detached";
}) {
  const isActive = status === "initializing" || status === "running" || status === "awaiting_tool_results";
  const isError = status === "failed";
  return (
    <Badge
      variant="secondary"
      className={cn(
        "text-[10px]",
        isActive && "bg-blue-500/10 text-blue-600 dark:text-blue-400",
        isError && "bg-destructive/10 text-destructive",
      )}
    >
      {statusLabel(status)}
    </Badge>
  );
}

function StatusIcon({ isActive, isError }: { isActive: boolean; isError: boolean }) {
  if (isError) {
    return <AlertTriangleIcon className="mt-0.5 size-3.5 text-destructive" />;
  }
  if (isActive) {
    return <Clock3Icon className="mt-0.5 size-3.5 animate-pulse text-blue-500" />;
  }
  return <CheckCircle2Icon className="mt-0.5 size-3.5 text-emerald-500" />;
}

function statusLabel(status: string) {
  switch (status) {
    case "awaiting_tool_results":
      return "Awaiting Tools";
    default:
      return status.charAt(0).toUpperCase() + status.slice(1);
  }
}

function truncate(value: string | undefined, maxLength: number) {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
}
