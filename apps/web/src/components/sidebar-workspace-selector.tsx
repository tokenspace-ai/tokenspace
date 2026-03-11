import { Link } from "@tanstack/react-router";
import {
  ArrowLeftRight,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock,
  GitBranch,
  GitCommit,
  Loader2,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { WorkspaceIcon } from "@/components/workspace-icon";
import { cn } from "@/lib/utils";
import type { Workspace } from "@/types/workspace";

export type { Workspace } from "@/types/workspace";

export type Branch = {
  id: string;
  name: string;
  isDefault: boolean;
};

export type RevisionState = "building" | "ready" | "error" | "pending";
export type WorkspaceWorkingChange = {
  path: string;
  status: "added" | "modified" | "deleted";
};

interface SidebarWorkspaceSelectorProps {
  workspaces: Workspace[];
  branches: Branch[];
  currentWorkspaceSlug?: string;
  currentBranchId?: string;
  includeWorkingState: boolean;
  workingStateHash?: string;
  revisionState: RevisionState;
  onBranchChange: (branchId: string, includeWorkingState: boolean) => void;
  onToggleWorkingState: (include: boolean) => void;
  workingChanges?: WorkspaceWorkingChange[];
  onCommitChanges?: (message: string) => Promise<void>;
  collapsed?: boolean;
}

const revisionConfig: Record<RevisionState, { icon: typeof Loader2; label: string; className: string }> = {
  building: {
    icon: Loader2,
    label: "Building",
    className: "text-muted-foreground",
  },
  ready: {
    icon: CheckCircle2,
    label: "Ready",
    className: "text-muted-foreground",
  },
  error: {
    icon: XCircle,
    label: "Error",
    className: "text-destructive",
  },
  pending: {
    icon: Clock,
    label: "Pending",
    className: "text-muted-foreground",
  },
};

export function SidebarWorkspaceSelector({
  workspaces,
  branches,
  currentWorkspaceSlug,
  currentBranchId,
  includeWorkingState,
  workingStateHash,
  revisionState,
  onBranchChange,
  onToggleWorkingState,
  workingChanges = [],
  onCommitChanges,
  collapsed = false,
}: SidebarWorkspaceSelectorProps) {
  const currentWorkspace = workspaces.find((w) => w.slug === currentWorkspaceSlug);
  const currentBranch = branches.find((b) => b.id === currentBranchId);
  const hasWorkingChanges = Boolean(workingStateHash);
  const hasCommitableChanges = workingChanges.length > 0;
  const [isCommitDialogOpen, setIsCommitDialogOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [isCommitting, setIsCommitting] = useState(false);

  const changeCounts = useMemo(() => {
    return workingChanges.reduce(
      (acc, change) => {
        acc.total += 1;
        acc[change.status] += 1;
        return acc;
      },
      { total: 0, added: 0, modified: 0, deleted: 0 },
    );
  }, [workingChanges]);

  const handleCommit = async () => {
    if (!onCommitChanges || !commitMessage.trim() || workingChanges.length === 0) return;
    setIsCommitting(true);
    try {
      await onCommitChanges(commitMessage.trim());
      setCommitMessage("");
      setIsCommitDialogOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to commit changes");
    } finally {
      setIsCommitting(false);
    }
  };

  // State flags for display logic
  const isOnMainBranch = currentBranch?.isDefault ?? true;
  const isWorkingStateActive = includeWorkingState && hasWorkingChanges;

  // Background color based on state: working state > non-main branch > default
  const selectorBgClass = isWorkingStateActive
    ? "bg-cyan-500/15 hover:bg-cyan-500/20 ring-1 ring-cyan-500/25"
    : !isOnMainBranch
      ? "bg-purple-500/15 hover:bg-purple-500/20"
      : "";

  const RevisionIcon = revisionConfig[revisionState].icon;
  const revisionClassName = revisionConfig[revisionState].className;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className={cn(
            "w-full justify-start gap-2 h-auto py-2 px-2",
            collapsed && "justify-center px-0",
            selectorBgClass,
          )}
        >
          <WorkspaceIcon
            name={currentWorkspace?.name ?? "Tokenspace"}
            iconUrl={currentWorkspace?.iconUrl}
            className="size-8 rounded-lg"
            fallbackClassName="bg-primary/10 text-primary"
          />
          {!collapsed && (
            <div className="flex flex-1 flex-col items-start gap-0.5 overflow-hidden">
              {/* Line 1: Workspace name + chevron */}
              <div className="flex w-full items-center gap-1">
                <span className="truncate text-sm font-semibold">{currentWorkspace?.name ?? "Select tokenspace"}</span>
                <ChevronDown className="ml-auto size-3 shrink-0 opacity-50" />
              </div>
              {/* Line 2: Branch + revision status (or just revision status if on main) */}
              <div className="flex items-center gap-1">
                {!isOnMainBranch && (
                  <>
                    <GitBranch className="size-3 text-muted-foreground" />
                    <span className="truncate text-xs text-muted-foreground">{currentBranch?.name}</span>
                    <span className="text-muted-foreground">·</span>
                  </>
                )}
                {isWorkingStateActive && (
                  <>
                    <span className="shrink-0 rounded bg-cyan-500/20 px-1 py-0.5 text-[10px] text-cyan-700 dark:text-cyan-300">
                      ephemeral
                    </span>
                    <span className="text-muted-foreground">·</span>
                  </>
                )}
                <RevisionIcon
                  className={cn("size-3", revisionClassName, revisionState === "building" && "animate-spin")}
                />
                <span className={cn("text-xs", revisionClassName)}>{revisionConfig[revisionState].label}</span>
              </div>
            </div>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64" side="right">
        <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">Workspace</DropdownMenuLabel>
        <DropdownMenuItem asChild className="flex items-center gap-2">
          <Link to="/">
            <ArrowLeftRight className="size-4 shrink-0 text-muted-foreground" />
            <span>Switch workspace</span>
          </Link>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">Branches</DropdownMenuLabel>
        {branches.map((branch) => (
          <DropdownMenuItem
            key={branch.id}
            onClick={() => onBranchChange(branch.id, includeWorkingState)}
            className="flex items-center gap-2"
          >
            <Check
              className={cn(
                "size-4 shrink-0",
                branch.id === currentBranchId && !includeWorkingState ? "opacity-100" : "opacity-0",
              )}
            />
            <GitBranch className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate">{branch.name}</span>
            {branch.isDefault && <span className="text-xs text-muted-foreground shrink-0">default</span>}
          </DropdownMenuItem>
        ))}
        {branches.length === 0 && (
          <DropdownMenuItem disabled className="text-muted-foreground">
            No branches available
          </DropdownMenuItem>
        )}

        {hasWorkingChanges && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onToggleWorkingState(!includeWorkingState)}
              className="flex items-center gap-2"
            >
              <Check className={cn("size-4 shrink-0", includeWorkingState ? "opacity-100" : "opacity-0")} />
              <Clock className="size-4 shrink-0 text-cyan-700 dark:text-cyan-300" />
              <span className="flex-1">Include ephemeral state</span>
              {workingStateHash && (
                <span className="text-xs text-muted-foreground font-mono">{workingStateHash.slice(0, 7)}</span>
              )}
            </DropdownMenuItem>
          </>
        )}

        {hasCommitableChanges && onCommitChanges && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setIsCommitDialogOpen(true)} className="flex items-center gap-2">
              <GitCommit className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex-1">Commit changes</span>
              <span className="text-xs text-muted-foreground">{workingChanges.length}</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>

      <Dialog
        open={isCommitDialogOpen}
        onOpenChange={(open) => {
          setIsCommitDialogOpen(open);
          if (!open) {
            setCommitMessage("");
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Commit Changes</DialogTitle>
            <DialogDescription>
              {changeCounts.total} files changed
              {changeCounts.added > 0 ? ` • ${changeCounts.added} added` : ""}
              {changeCounts.modified > 0 ? ` • ${changeCounts.modified} modified` : ""}
              {changeCounts.deleted > 0 ? ` • ${changeCounts.deleted} deleted` : ""}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <Input
              placeholder="Commit message"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleCommit();
                }
              }}
              disabled={isCommitting || workingChanges.length === 0}
            />

            <div className="rounded-md border">
              <ScrollArea className="max-h-56">
                <div className="divide-y">
                  {workingChanges.map((change) => (
                    <div key={change.path} className="flex items-center gap-2 px-3 py-2 text-xs">
                      <span
                        className={cn(
                          "w-4 font-mono",
                          change.status === "added" && "text-green-500",
                          change.status === "modified" && "text-amber-500",
                          change.status === "deleted" && "text-red-500",
                        )}
                      >
                        {change.status === "added" ? "A" : change.status === "modified" ? "M" : "D"}
                      </span>
                      <span className="truncate font-mono text-muted-foreground">{change.path}</span>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCommitDialogOpen(false)} disabled={isCommitting}>
              Cancel
            </Button>
            <Button
              onClick={() => void handleCommit()}
              disabled={!commitMessage.trim() || workingChanges.length === 0 || isCommitting}
            >
              <GitCommit className="mr-2 size-4" />
              {isCommitting ? "Committing..." : "Commit"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DropdownMenu>
  );
}
