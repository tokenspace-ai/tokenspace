"use client";

import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import { CheckIcon, ChevronDownIcon, Loader2Icon, MessageSquareIcon, ShieldAlertIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Label } from "../ui/label";

type ApprovalRequestCardProps = {
  request: {
    _id: Id<"approvalRequests">;
    action: string;
    data?: Record<string, any>;
    info?: Record<string, any>;
    description?: string;
    reason: string;
    status: "pending" | "approved" | "denied";
    createdAt: number;
    resolvedAt?: number;
    resolverComment?: string;
  };
};

export function ApprovalRequestCard({ request }: ApprovalRequestCardProps) {
  const [isApproving, setIsApproving] = useState(false);
  const [isDenying, setIsDenying] = useState(false);
  const [showDenyForm, setShowDenyForm] = useState(false);
  const [showApproveComment, setShowApproveComment] = useState(false);
  const [comment, setComment] = useState("");

  const grantApproval = useMutation(api.approvals.grantApproval);
  const denyApproval = useMutation(api.approvals.denyApproval);

  const handleApprove = async (withComment = false) => {
    setIsApproving(true);
    try {
      await grantApproval({
        requestId: request._id,
        comment: withComment && comment.trim() ? comment.trim() : undefined,
      });
    } finally {
      setIsApproving(false);
      setShowApproveComment(false);
      setComment("");
    }
  };

  const handleDeny = async () => {
    setIsDenying(true);
    try {
      await denyApproval({
        requestId: request._id,
        comment: comment.trim() || undefined,
      });
    } finally {
      setIsDenying(false);
      setShowDenyForm(false);
      setComment("");
    }
  };

  const isPending = request.status === "pending";
  const isApproved = request.status === "approved";
  const isDenied = request.status === "denied";

  const data = useMemo(() => {
    if (typeof request.data === "string") {
      return JSON.parse(request.data) as Record<string, any>;
    }
    return request.data;
  }, [request.data]);

  return (
    <div
      className={cn(
        "rounded-lg border p-4 space-y-3",
        isPending && "border-amber-500/50 bg-amber-500/5",
        isApproved && "border-green-500/50 bg-green-500/5",
        isDenied && "border-red-500/50 bg-red-500/5",
      )}
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-lg",
            isPending && "bg-amber-500/20 text-amber-500",
            isApproved && "bg-green-500/20 text-green-500",
            isDenied && "bg-red-500/20 text-red-500",
          )}
        >
          <ShieldAlertIcon className="size-4" />
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="font-medium text-sm">
            {isPending && "Approval Required"}
            {isApproved && "Approved"}
            {isDenied && "Denied"}
          </h4>
          <p className="text-muted-foreground text-xs mt-0.5">{request.action}</p>
        </div>
        {!isPending && (
          <div
            className={cn(
              "flex size-6 items-center justify-center rounded-full",
              isApproved && "bg-green-500 text-white",
              isDenied && "bg-red-500 text-white",
            )}
          >
            {isApproved && <CheckIcon className="size-3" />}
            {isDenied && <XIcon className="size-3" />}
          </div>
        )}
      </div>

      {/* Details */}
      <div className="space-y-2 text-sm">
        {request.description && <p className="text-foreground/80 italic">{request.description}</p>}
        <p className="text-foreground">{request.reason}</p>

        {data && typeof data !== "string" && Object.keys(data).length > 0 && (
          <div className="flex flex-wrap gap-2 text-xs">
            {Object.entries(data).map(([key, value]) => (
              <span key={key} className="rounded-md bg-secondary px-2 py-1">
                {key}: {typeof value === "object" ? JSON.stringify(value) : String(value)}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Resolver comment for resolved requests */}
      {!isPending && request.resolverComment && (
        <div
          className={cn(
            "rounded-md p-3 text-sm",
            isApproved && "bg-green-500/10 border border-green-500/20",
            isDenied && "bg-red-500/10 border border-red-500/20",
          )}
        >
          <div className="flex items-start gap-2">
            <MessageSquareIcon className="size-3.5 mt-0.5 shrink-0 opacity-70" />
            <p className="text-foreground/90">{request.resolverComment}</p>
          </div>
        </div>
      )}

      {/* Deny form - shown when user clicks Deny */}
      {isPending && showDenyForm && (
        <div className="space-y-3 pt-1">
          <div className="space-y-2">
            <Label className="text-sm font-medium text-foreground">Why are you denying this request?</Label>
            <Textarea
              placeholder="(Optional) Explain why this action may not be performed or what the AI should do instead..."
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              className="min-h-[80px] text-sm"
              autoFocus
            />
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setShowDenyForm(false);
                setComment("");
              }}
              disabled={isDenying}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button size="sm" variant="destructive" onClick={handleDeny} disabled={isDenying} className="flex-1">
              {isDenying ? <Loader2Icon className="size-3 animate-spin" /> : <XIcon className="size-3" />}
              Deny Request
            </Button>
          </div>
        </div>
      )}

      {/* Approve with comment form */}
      {isPending && showApproveComment && (
        <div className="space-y-3 pt-1">
          <div className="space-y-2">
            <Label className="text-sm font-medium text-foreground">Add a comment (optional)</Label>
            <Textarea
              placeholder="(Optional) Any additional context for the AI..."
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              className="min-h-[60px] text-sm"
              autoFocus
            />
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setShowApproveComment(false);
                setComment("");
              }}
              disabled={isApproving}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => handleApprove(true)}
              disabled={isApproving}
              className="flex-1 bg-green-600 hover:bg-green-700"
            >
              {isApproving ? <Loader2Icon className="size-3 animate-spin" /> : <CheckIcon className="size-3" />}
              Approve
            </Button>
          </div>
        </div>
      )}

      {/* Actions - shown when no form is open */}
      {isPending && !showDenyForm && !showApproveComment && (
        <div className="flex gap-2 pt-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowDenyForm(true)}
            disabled={isApproving || isDenying}
            className="flex-1"
          >
            <XIcon className="size-3" />
            Deny
          </Button>

          <div className="flex flex-1 gap-0.5">
            <Button
              size="sm"
              onClick={() => handleApprove(false)}
              disabled={isApproving || isDenying}
              className="flex-1 rounded-r-none bg-green-600 hover:bg-green-700"
            >
              {isApproving ? <Loader2Icon className="size-3 animate-spin" /> : <CheckIcon className="size-3" />}
              Approve
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  disabled={isApproving || isDenying}
                  className="rounded-l-none px-2 bg-green-600 hover:bg-green-700 border-l border-green-700"
                >
                  <ChevronDownIcon className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setShowApproveComment(true)}>
                  <MessageSquareIcon className="size-4" />
                  Approve with comment
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Display pending approval requests for a session.
 * Shows at the bottom of the chat when approvals are waiting.
 */
export function PendingApprovals({ sessionId }: { sessionId: Id<"sessions"> }) {
  const pendingRequests = useQuery(api.approvals.getPendingRequests, { sessionId });

  if (!pendingRequests || pendingRequests.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      {pendingRequests.map((request) => (
        <ApprovalRequestCard key={request._id} request={request} />
      ))}
    </div>
  );
}
