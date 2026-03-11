import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import type { ToolUIPart } from "ai";
import { useQuery } from "convex/react";
import { ShieldAlertIcon, ShieldCheckIcon, ShieldXIcon } from "lucide-react";
import { useState } from "react";
import { Task, TaskContent, TaskItem, TaskTrigger } from "../../../ai-elements/task";
import { ApprovalRequestCard } from "../../approval-request";
import type { AgentTools } from "./types";

export function RequestApprovalToolCall({
  sessionId,
  toolPart,
  isLastMessage,
}: {
  sessionId: Id<"sessions">;
  toolPart: ToolUIPart<AgentTools>;
  isLastMessage: boolean;
}) {
  const approvalRequest = useQuery(api.approvals.getApprovalRequestByToolCall, {
    sessionId,
    toolCallId: toolPart.toolCallId,
  });

  const status =
    toolPart.state === "output-available" ? "completed" : toolPart.state === "output-error" ? "failed" : "running";

  const input = toolPart.input as
    | {
        type?: string;
        action?: string;
        resource?: string;
        connection?: string;
        reason?: string;
      }
    | undefined;

  const [open, setIsOpen] = useState<boolean | undefined>(undefined);
  const isComplete = status === "completed";

  return (
    <Task open={open != null ? open : !isComplete || !!isLastMessage} onOpenChange={setIsOpen}>
      <TaskTrigger
        title={
          approvalRequest?.status === "approved"
            ? `Granted: ${approvalRequest.action}`
            : approvalRequest?.status === "denied"
              ? `Denied: ${approvalRequest.action}`
              : `Requesting approval: ${approvalRequest?.resolverComment ?? input?.type ?? "action"}`
        }
        status="completed"
        icon={
          approvalRequest?.status === "approved" ? (
            <ShieldCheckIcon className="text-green-500" />
          ) : approvalRequest?.status === "denied" ? (
            <ShieldXIcon className="text-red-500" />
          ) : (
            <ShieldAlertIcon />
          )
        }
      />
      <TaskContent>
        <TaskItem>{approvalRequest && <ApprovalRequestCard request={approvalRequest} />}</TaskItem>
      </TaskContent>
    </Task>
  );
}
