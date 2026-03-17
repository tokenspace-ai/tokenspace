import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import {
  AlertCircleIcon,
  KeyRoundIcon,
  Loader2,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  ServerIcon,
  Trash2Icon,
  UnplugIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ExecutorAssignmentWarning,
  ExecutorAvailabilityBadge,
  ExecutorInstancesTable,
  ExecutorSetupInstructionsCard,
  type ExecutorSetupState,
  ExecutorStatusTable,
  formatExecutorDateTime,
} from "@/components/executors/executor-management";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { deriveWorkspaceExecutorState, ExecutorStateBadge } from "./executor-status";

export function WorkspaceExecutorSettings({
  workspaceId,
  isWorkspaceAdmin,
}: {
  workspaceId: Id<"workspaces">;
  isWorkspaceAdmin: boolean;
}) {
  const assignedStatus = useQuery(api.executors.getAssignedExecutorStatus, { workspaceId });
  const assignableExecutors = useQuery(
    api.executors.listAssignableExecutorsForWorkspace,
    isWorkspaceAdmin ? { workspaceId } : "skip",
  );
  const assignWorkspaceExecutor = useMutation(api.executors.assignWorkspaceExecutor);
  const createExecutor = useMutation(api.executors.createExecutor);
  const renameExecutor = useMutation(api.executors.renameExecutor);
  const rotateExecutorBootstrapToken = useMutation(api.executors.rotateExecutorBootstrapToken);
  const deleteExecutor = useMutation(api.executors.deleteExecutor);

  const [selectedExecutorId, setSelectedExecutorId] = useState<string>("");
  const [newExecutorName, setNewExecutorName] = useState("");
  const [renameExecutorName, setRenameExecutorName] = useState("");
  const [isAssigning, setIsAssigning] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [isRotating, setIsRotating] = useState(false);
  const [isUnassigning, setIsUnassigning] = useState(false);
  const [isDeletingExecutor, setIsDeletingExecutor] = useState(false);
  const [setupState, setSetupState] = useState<ExecutorSetupState | null>(null);
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [rotateDialogOpen, setRotateDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [unassignDialogOpen, setUnassignDialogOpen] = useState(false);

  const currentExecutorId = assignableExecutors?.currentExecutorId ?? assignedStatus?.currentExecutorId ?? null;

  useEffect(() => {
    setSelectedExecutorId(currentExecutorId ?? "");
  }, [currentExecutorId]);

  useEffect(() => {
    setRenameExecutorName(assignedStatus?.executor.name ?? "");
  }, [assignedStatus?.executor.name]);

  const executorState = deriveWorkspaceExecutorState(assignedStatus ?? null);

  const assignmentRows = useMemo(() => {
    const assignable = assignableExecutors?.executors ?? [];
    const rows = assignable.map((executor) => ({
      executor,
      isCurrent: executor._id === currentExecutorId,
      selectable: true,
    }));

    const current = assignedStatus?.executor;
    if (current && currentExecutorId && !rows.some((row) => row.executor._id === currentExecutorId)) {
      rows.unshift({
        executor: {
          ...current,
          _id: currentExecutorId,
        },
        isCurrent: true,
        selectable: false,
      });
    }

    return rows;
  }, [assignableExecutors, assignedStatus, currentExecutorId]);

  const assignableCount = assignmentRows.filter((row) => row.selectable).length;
  const canApplyAssignment =
    isWorkspaceAdmin &&
    !!selectedExecutorId &&
    assignmentRows.some((row) => row.executor._id === selectedExecutorId && row.selectable) &&
    selectedExecutorId !== currentExecutorId &&
    assignableExecutors !== undefined;

  const handleAssignExecutor = async () => {
    if (!selectedExecutorId) return;
    setIsAssigning(true);
    try {
      await assignWorkspaceExecutor({
        workspaceId,
        executorId: selectedExecutorId as Id<"executors">,
        failPendingJobs: true,
      });
      toast.success("Executor assignment updated");
      setAssignDialogOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update executor assignment");
      console.error(error);
    } finally {
      setIsAssigning(false);
    }
  };

  const handleUnassignExecutor = async () => {
    setIsUnassigning(true);
    try {
      await assignWorkspaceExecutor({
        workspaceId,
        executorId: undefined,
        failPendingJobs: true,
      });
      toast.success("Executor unassigned");
      setUnassignDialogOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to unassign executor");
      console.error(error);
    } finally {
      setIsUnassigning(false);
    }
  };

  const handleCreateExecutor = async () => {
    if (!newExecutorName.trim()) {
      toast.error("Executor name is required");
      return;
    }
    setIsCreating(true);
    try {
      const result = await createExecutor({
        workspaceId,
        name: newExecutorName.trim(),
        failPendingJobs: true,
      });
      setSetupState({
        mode: "create",
        bootstrapToken: result.bootstrapToken,
        setup: result.setup,
      });
      setSelectedExecutorId(result.executor._id);
      setNewExecutorName("");
      setCreateDialogOpen(false);
      toast.success("Executor created and assigned");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create executor");
      console.error(error);
    } finally {
      setIsCreating(false);
    }
  };

  const handleRenameExecutor = async () => {
    if (!assignedStatus?.currentExecutorId) return;
    if (!renameExecutorName.trim()) {
      toast.error("Executor name is required");
      return;
    }
    setIsRenaming(true);
    try {
      await renameExecutor({
        executorId: assignedStatus.currentExecutorId,
        name: renameExecutorName.trim(),
      });
      setRenameDialogOpen(false);
      toast.success("Executor renamed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to rename executor");
      console.error(error);
    } finally {
      setIsRenaming(false);
    }
  };

  const handleRotateBootstrapToken = async () => {
    if (!assignedStatus?.currentExecutorId) return;
    setIsRotating(true);
    try {
      const result = await rotateExecutorBootstrapToken({
        executorId: assignedStatus.currentExecutorId,
      });
      setSetupState({
        mode: "rotate",
        bootstrapToken: result.bootstrapToken,
        setup: result.setup,
      });
      setRotateDialogOpen(false);
      toast.success("Bootstrap token rotated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to rotate bootstrap token");
      console.error(error);
    } finally {
      setIsRotating(false);
    }
  };

  const handleDeleteExecutor = async () => {
    if (!assignedStatus?.currentExecutorId) return;
    setIsDeletingExecutor(true);
    try {
      await deleteExecutor({
        executorId: assignedStatus.currentExecutorId,
      });
      setSetupState(null);
      setDeleteDialogOpen(false);
      toast.success("Executor deleted");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete executor");
      console.error(error);
    } finally {
      setIsDeletingExecutor(false);
    }
  };

  if (assignedStatus === undefined) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin" />
          Loading executor status...
        </div>
      </div>
    );
  }

  const showEmptyAssignmentState = !assignedStatus;

  return (
    <div className="space-y-6">
      {!isWorkspaceAdmin && (
        <Alert>
          <AlertCircleIcon />
          <AlertTitle>Read-only access</AlertTitle>
          <AlertDescription>
            You can inspect executor assignment and instance health here, but only workspace admins can create or
            reassign executors.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="gap-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                <ServerIcon className="size-4" />
                {assignedStatus ? assignedStatus.executor.name : "No Executor Assigned"}
              </CardTitle>
              <CardDescription>
                Review executor routing for this workspace and the fleet&apos;s live health before sending jobs to it.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <ExecutorStateBadge state={executorState} />
              {(isWorkspaceAdmin || assignedStatus?.executor.canManageLifecycle) && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="size-8">
                      <MoreHorizontalIcon className="size-4" />
                      <span className="sr-only">Executor actions</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {assignedStatus?.executor.canManageLifecycle ? (
                      <DropdownMenuItem onSelect={() => setRenameDialogOpen(true)}>
                        <PencilIcon className="size-4" />
                        Rename executor
                      </DropdownMenuItem>
                    ) : null}
                    {isWorkspaceAdmin ? (
                      <DropdownMenuItem onSelect={() => setAssignDialogOpen(true)}>
                        <ServerIcon className="size-4" />
                        Change executor
                      </DropdownMenuItem>
                    ) : null}
                    {assignedStatus?.executor.canManageLifecycle && (
                      <DropdownMenuItem onSelect={() => setRotateDialogOpen(true)}>
                        <KeyRoundIcon className="size-4" />
                        Rotate bootstrap token
                      </DropdownMenuItem>
                    )}
                    {assignedStatus?.executor.canManageLifecycle ? (
                      <DropdownMenuItem variant="destructive" onSelect={() => setDeleteDialogOpen(true)}>
                        <Trash2Icon className="size-4" />
                        Delete executor
                      </DropdownMenuItem>
                    ) : null}
                    {isWorkspaceAdmin && assignedStatus ? (
                      <DropdownMenuItem variant="destructive" onSelect={() => setUnassignDialogOpen(true)}>
                        <UnplugIcon className="size-4" />
                        Unassign executor
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuSeparator />
                    {isWorkspaceAdmin ? (
                      <DropdownMenuItem onSelect={() => setCreateDialogOpen(true)}>
                        <PlusIcon className="size-4" />
                        Create new executor
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {assignedStatus ? (
            <>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-lg border p-4">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">Executor</div>
                  <div className="mt-2 text-sm font-medium">{assignedStatus.executor.name}</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <ExecutorAvailabilityBadge executor={assignedStatus.executor} className="text-[10px]" />
                    <Badge variant="outline" className="text-[10px] capitalize">
                      {assignedStatus.executor.status}
                    </Badge>
                  </div>
                </div>
                <div className="rounded-lg border p-4">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">Online Instances</div>
                  <div className="mt-2 text-sm font-medium">{assignedStatus.executor.onlineInstanceCount}</div>
                </div>
                <div className="rounded-lg border p-4">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">Recent Heartbeat</div>
                  <div className="mt-2 text-sm font-medium">
                    {assignedStatus.executor.lastHeartbeatAt ? (
                      <span>{formatExecutorDateTime(assignedStatus.executor.lastHeartbeatAt)}</span>
                    ) : (
                      "Never"
                    )}
                  </div>
                </div>
                <div className="rounded-lg border p-4">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">Bootstrap Last Used</div>
                  <div className="mt-2 text-sm font-medium">
                    {formatExecutorDateTime(assignedStatus.executor.bootstrapLastUsedAt)}
                  </div>
                </div>
              </div>

              <div className="rounded-lg border">
                <div className="flex items-center justify-between border-b px-4 py-3">
                  <div>
                    <h3 className="text-sm font-medium">Executor Instances</h3>
                    <p className="text-xs text-muted-foreground">
                      Heartbeat and capacity snapshots for currently known instances.
                    </p>
                  </div>
                </div>
                <ExecutorInstancesTable
                  instances={assignedStatus.instances}
                  emptyMessage="No instances have registered yet. Start one with the setup instructions below."
                />
              </div>
            </>
          ) : (
            <Empty className="border bg-muted/15 py-10">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ServerIcon className="size-5" />
                </EmptyMedia>
                <EmptyTitle>No executor assigned</EmptyTitle>
                <EmptyDescription>
                  This workspace is not routed to a self-hosted executor yet. Add an existing executor or create a new
                  one before running tools that require execution.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent className="max-w-lg">
                {isWorkspaceAdmin ? (
                  <div className="flex flex-wrap items-center justify-center gap-3">
                    <Button onClick={() => setAssignDialogOpen(true)} disabled={assignableCount === 0}>
                      Add executor
                    </Button>
                    <Button variant="outline" onClick={() => setCreateDialogOpen(true)}>
                      Create new executor
                    </Button>
                  </div>
                ) : (
                  <Alert className="w-full text-left">
                    <AlertCircleIcon />
                    <AlertTitle>Workspace admin required</AlertTitle>
                    <AlertDescription>
                      Ask a workspace admin to assign an executor before execution can be enabled here.
                    </AlertDescription>
                  </Alert>
                )}
                {isWorkspaceAdmin && assignableCount === 0 ? (
                  <p className="text-sm text-muted-foreground">No assignable executors are available yet.</p>
                ) : null}
              </EmptyContent>
            </Empty>
          )}
        </CardContent>
      </Card>

      <Dialog open={assignDialogOpen} onOpenChange={setAssignDialogOpen}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Assign Executor</DialogTitle>
            <DialogDescription>
              Switch this workspace to a different executor immediately. Pending jobs on the current executor will be
              failed before the switch, and running jobs must finish or be stopped first.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <ExecutorStatusTable
              mode="select"
              rows={assignmentRows}
              selectedExecutorId={selectedExecutorId}
              onSelectExecutor={setSelectedExecutorId}
              emptyMessage="No assignable executors available. Create one first."
            />
            <ExecutorAssignmentWarning>
              If the newly assigned executor has no healthy instance, this workspace will not execute jobs until one
              connects.
            </ExecutorAssignmentWarning>
            {showEmptyAssignmentState ? (
              <Alert className="border-dashed bg-muted/20">
                <AlertCircleIcon />
                <AlertTitle>Workspace currently has no executor</AlertTitle>
                <AlertDescription>
                  Select a healthy executor if one is available, or create a new fleet if you need a fresh bootstrap
                  token.
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleAssignExecutor} disabled={!canApplyAssignment || isAssigning}>
              {isAssigning ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Saving...
                </>
              ) : (
                "Apply"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={createDialogOpen}
        onOpenChange={(open) => {
          setCreateDialogOpen(open);
          if (!open) setNewExecutorName("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Executor</DialogTitle>
            <DialogDescription>
              Create a self-hosted executor, then immediately assign it to this workspace.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 py-2">
            <Label htmlFor="new-executor-name">Executor name</Label>
            <Input
              id="new-executor-name"
              placeholder="Production fleet"
              value={newExecutorName}
              onChange={(event) => setNewExecutorName(event.target.value)}
            />
            <ExecutorAssignmentWarning>
              The new executor becomes active for this workspace as soon as it is created. Pending jobs on the current
              executor will be failed before the switch, and this workspace will remain non-functional until an executor
              process connects with the new bootstrap token.
            </ExecutorAssignmentWarning>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateExecutor} disabled={isCreating || !newExecutorName.trim()}>
              {isCreating ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={renameDialogOpen}
        onOpenChange={(open) => {
          setRenameDialogOpen(open);
          if (!open) {
            setRenameExecutorName(assignedStatus?.executor.name ?? "");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename executor</DialogTitle>
            <DialogDescription>Update the display name for the currently assigned executor.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 py-2">
            <Label htmlFor="assigned-executor-name">Executor name</Label>
            <Input
              id="assigned-executor-name"
              value={renameExecutorName}
              onChange={(event) => setRenameExecutorName(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleRenameExecutor} disabled={isRenaming || !renameExecutorName.trim()}>
              {isRenaming ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={rotateDialogOpen} onOpenChange={setRotateDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rotate bootstrap token</AlertDialogTitle>
            <AlertDialogDescription>
              This issues a new bootstrap token, invalidates the current bootstrap token, and marks all online instances
              offline. Any executor process that should continue serving jobs must restart and register again with the
              new token.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={handleRotateBootstrapToken} disabled={isRotating}>
              {isRotating ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Rotating...
                </>
              ) : (
                "Rotate token"
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete executor</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the assigned executor and all recorded instance rows. Any workspaces assigned to
              it will be unassigned immediately, execution will stop until a new executor is assigned, and deletion is
              blocked while runtime or compile jobs are still pending or running.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={handleDeleteExecutor} disabled={isDeletingExecutor}>
              {isDeletingExecutor ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                "Delete executor"
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={unassignDialogOpen} onOpenChange={setUnassignDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unassign executor</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the executor assignment from the workspace immediately. Pending jobs on the current
              executor will be failed first, running jobs must finish or be stopped first, and code execution will stop
              working until a new executor is assigned.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleUnassignExecutor}
              disabled={isUnassigning}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isUnassigning ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Unassigning...
                </>
              ) : (
                "Unassign"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {setupState ? (
        <ExecutorSetupInstructionsCard
          setupState={setupState}
          description={`The bootstrap credential is shown only for this ${setupState.mode === "rotate" ? "rotation" : "creation"} flow. Store it before leaving the page.`}
          credentialNotice={
            setupState.mode === "rotate"
              ? "Tokenspace will not re-show this plaintext bootstrap token after this view is gone. Use the updated setup commands below for any executor instance you want to register with this executor."
              : "Tokenspace will not re-show this plaintext bootstrap token after this view is gone."
          }
        />
      ) : null}
    </div>
  );
}
