import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type AssignedExecutorStatusLike = {
  executor: {
    onlineInstanceCount: number;
  };
} | null;

export type WorkspaceExecutorState = {
  key: "online" | "offline" | "unassigned";
  label: "Online" | "Offline" | "Unassigned";
  description: string;
  iconClassName: string;
  badgeClassName: string;
};

export function deriveWorkspaceExecutorState(status: AssignedExecutorStatusLike): WorkspaceExecutorState {
  if (!status) {
    return {
      key: "unassigned",
      label: "Unassigned",
      description: "No executor is assigned to this workspace.",
      iconClassName: "text-red-500",
      badgeClassName: "border-border text-muted-foreground",
    };
  }

  if (status.executor.onlineInstanceCount > 0) {
    return {
      key: "online",
      label: "Online",
      description: "A healthy executor instance is available.",
      iconClassName: "text-emerald-500",
      badgeClassName: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    };
  }

  return {
    key: "offline",
    label: "Offline",
    description: "An executor is assigned, but no healthy instances are online.",
    iconClassName: "text-red-500",
    badgeClassName: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  };
}

export function ExecutorStateBadge({ state, className }: { state: WorkspaceExecutorState; className?: string }) {
  return (
    <Badge variant="outline" className={cn(state.badgeClassName, className)}>
      {state.label}
    </Badge>
  );
}
