import type { ToolUIPart } from "ai";
import { AlertTriangleIcon, ChevronRightIcon, type LucideIcon } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useCallback } from "react";
import { cn } from "@/lib/utils";
import { Shimmer } from "../../../ai-elements/shimmer";
import { useChatSidebar, useChatSidebarOptional } from "../../chat-sidebar";
import type { AgentTools } from "./types";

export function ToolCallDisplay({
  text,
  icon,
  part,
}: {
  text: string;
  icon: LucideIcon;
  part: ToolUIPart<AgentTools>;
}) {
  const sidebar = useChatSidebarOptional();
  const Icon = icon;
  const active = !part.state.startsWith("output-");
  const error = part.state === "output-error";
  const handleToolClick = useCallback(() => {
    if (sidebar) {
      sidebar.openToolDetails(part.toolCallId);
    }
  }, [sidebar, part.toolCallId]);
  const handleToolKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handleToolClick();
      }
    },
    [handleToolClick],
  );
  const { toolCallId: currentToolCallId } = useChatSidebar();

  const isShownInSidebar = currentToolCallId === part.toolCallId;

  return (
    <div
      className={cn(
        "py-1 flex gap-2 items-center text-muted-foreground hover:text-foreground text-xs bg-muted/0 cursor-pointer",
        isShownInSidebar ? "bg-muted/60 text-foreground" : "",
      )}
      onClick={handleToolClick}
      onKeyDown={handleToolKeyDown}
      role="button"
      tabIndex={0}
    >
      <Icon className="size-3.5" />
      {active ? <Shimmer>{text}</Shimmer> : <span>{text}</span>}
      {error ? <AlertTriangleIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}
    </div>
  );
}
