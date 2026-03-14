import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CircleDotIcon,
  CpuIcon,
  KeyRoundIcon,
  Loader2,
  ServerIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CodeBlock, CodeBlockCopyButton } from "@/components/ai-elements/code-block";
import { RelativeTime } from "@/components/relative-time";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { deriveWorkspaceExecutorState, ExecutorStateBadge, type WorkspaceExecutorState } from "./executor-status";

type SetupState = {
  bootstrapToken: string;
  setup: {
    requiredEnvVars: string[];
    snippets: {
      docker: string;
      raw: string;
    };
  };
};

function formatDateTime(timestamp: number | null | undefined): string {
  if (!timestamp) return "Never";
  return new Date(timestamp).toLocaleString();
}

function formatCapacity(runtime: number | null, compile: number | null): string {
  const runtimeLabel = runtime == null ? "runtime unlimited" : `runtime ${runtime}`;
  const compileLabel = compile == null ? "compile unlimited" : `compile ${compile}`;
  return `${runtimeLabel} / ${compileLabel}`;
}

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

  const [selectedExecutorId, setSelectedExecutorId] = useState<string>("");
  const [newExecutorName, setNewExecutorName] = useState("");
  const [isAssigning, setIsAssigning] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [setupState, setSetupState] = useState<SetupState | null>(null);

  const currentExecutorId = assignableExecutors?.currentExecutorId ?? assignedStatus?.currentExecutorId ?? null;

  useEffect(() => {
    setSelectedExecutorId(currentExecutorId ?? "");
  }, [currentExecutorId]);

  const executorState = deriveWorkspaceExecutorState(assignedStatus ?? null);

  const executorOptions = useMemo(() => {
    if (!assignableExecutors) return [];
    const options = [...assignableExecutors.executors];
    const current = assignedStatus?.executor;
    const currentId = assignedStatus?.currentExecutorId;
    if (current && currentId && !options.some((executor) => executor._id === currentId)) {
      options.unshift({
        ...current,
        _id: currentId,
      });
    }
    return options;
  }, [assignableExecutors, assignedStatus]);

  const canApplyAssignment =
    isWorkspaceAdmin &&
    !!selectedExecutorId &&
    selectedExecutorId !== currentExecutorId &&
    assignableExecutors !== undefined;

  const handleAssignExecutor = async () => {
    if (!selectedExecutorId) return;
    setIsAssigning(true);
    try {
      await assignWorkspaceExecutor({
        workspaceId,
        executorId: selectedExecutorId as Id<"executors">,
      });
      toast.success("Executor assignment updated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update executor assignment");
      console.error(error);
    } finally {
      setIsAssigning(false);
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
      });
      setSetupState({
        bootstrapToken: result.bootstrapToken,
        setup: result.setup,
      });
      setSelectedExecutorId(result.executor._id);
      setNewExecutorName("");
      toast.success("Executor created and assigned");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create executor");
      console.error(error);
    } finally {
      setIsCreating(false);
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
                Current Assignment
              </CardTitle>
              <CardDescription>
                Review the executor assigned to this workspace and the fleet's live health.
              </CardDescription>
            </div>
            <ExecutorStateBadge state={executorState} />
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
                    <ExecutorStateBadge state={executorState} className="text-[10px]" />
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
                      <RelativeTime timestamp={assignedStatus.executor.lastHeartbeatAt} />
                    ) : (
                      "Never"
                    )}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {formatDateTime(assignedStatus.executor.lastHeartbeatAt)}
                  </div>
                </div>
                <div className="rounded-lg border p-4">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">Bootstrap Last Used</div>
                  <div className="mt-2 text-sm font-medium">
                    {assignedStatus.executor.bootstrapLastUsedAt ? (
                      <RelativeTime timestamp={assignedStatus.executor.bootstrapLastUsedAt} />
                    ) : (
                      "Never"
                    )}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {formatDateTime(assignedStatus.executor.bootstrapLastUsedAt)}
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
                {assignedStatus.instances.length === 0 ? (
                  <div className="px-4 py-6 text-sm text-muted-foreground">
                    No instances have registered yet. Start one with the setup instructions below.
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Health</TableHead>
                        <TableHead>Host</TableHead>
                        <TableHead>Version</TableHead>
                        <TableHead>Last Heartbeat</TableHead>
                        <TableHead>Registered</TableHead>
                        <TableHead>Capacity</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {assignedStatus.instances.map((instance) => {
                        const healthState: WorkspaceExecutorState =
                          instance.health === "online"
                            ? {
                                key: "online",
                                label: "Online",
                                description: "",
                                iconClassName: "",
                                badgeClassName:
                                  "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                              }
                            : {
                                key: "offline",
                                label: "Offline",
                                description: "",
                                iconClassName: "",
                                badgeClassName: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
                              };

                        return (
                          <TableRow key={instance._id}>
                            <TableCell>
                              <ExecutorStateBadge state={healthState} className="text-[10px]" />
                            </TableCell>
                            <TableCell>{instance.hostname ?? "Unknown host"}</TableCell>
                            <TableCell>{instance.version ?? "Unknown version"}</TableCell>
                            <TableCell>
                              <div className="font-medium">
                                <RelativeTime timestamp={instance.lastHeartbeatAt} />
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {formatDateTime(instance.lastHeartbeatAt)}
                              </div>
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {formatDateTime(instance.registeredAt)}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {formatCapacity(instance.maxConcurrentRuntimeJobs, instance.maxConcurrentCompileJobs)}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </div>
            </>
          ) : (
            <Alert>
              <AlertCircleIcon />
              <AlertTitle>No executor assigned</AlertTitle>
              <AlertDescription>
                This workspace is not routed to a self-hosted executor yet. Assign an existing executor or create a new
                one below.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {isWorkspaceAdmin && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CircleDotIcon className="size-4" />
              Assignment Controls
            </CardTitle>
            <CardDescription>Select an existing executor for this workspace.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="executor-select">Assigned executor</Label>
              <Select value={selectedExecutorId} onValueChange={setSelectedExecutorId}>
                <SelectTrigger id="executor-select">
                  <SelectValue placeholder="Choose an executor" />
                </SelectTrigger>
                <SelectContent>
                  {executorOptions.map((executor) => (
                    <SelectItem key={executor._id} value={executor._id}>
                      {executor.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {assignableExecutors && assignableExecutors.executors.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No assignable executors are available yet. Create one below to bootstrap this workspace.
              </p>
            )}

            <div className="flex justify-end">
              <Button onClick={handleAssignExecutor} disabled={!canApplyAssignment || isAssigning}>
                {isAssigning ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Apply Assignment"
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {isWorkspaceAdmin && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CpuIcon className="size-4" />
              Create Executor
            </CardTitle>
            <CardDescription>
              Create a self-hosted executor and immediately assign it to this workspace.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="new-executor-name">Executor name</Label>
              <Input
                id="new-executor-name"
                placeholder="Production fleet"
                value={newExecutorName}
                onChange={(event) => setNewExecutorName(event.target.value)}
              />
            </div>

            <div className="flex justify-end">
              <Button onClick={handleCreateExecutor} disabled={isCreating || !newExecutorName.trim()}>
                {isCreating ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  "Create Executor"
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {setupState && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRoundIcon className="size-4" />
              Setup Instructions
            </CardTitle>
            <CardDescription>
              The bootstrap credential is shown only for this create flow. Store it before leaving the page.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <Alert className="border-emerald-500/20 bg-emerald-500/5">
              <CheckCircle2Icon className="text-emerald-500" />
              <AlertTitle>Bootstrap credential</AlertTitle>
              <AlertDescription>
                Tokenspace will not re-show this plaintext bootstrap token after this view is gone.
              </AlertDescription>
            </Alert>

            <div className="space-y-2">
              <Label>Bootstrap token</Label>
              <div className="overflow-hidden rounded-lg border">
                <CodeBlock code={setupState.bootstrapToken} language="bash" fontSize="xs">
                  <CodeBlockCopyButton
                    variant="outline"
                    size="sm"
                    onCopy={() => toast.success("Bootstrap token copied")}
                  />
                </CodeBlock>
              </div>
            </div>

            <div className="space-y-3">
              <Label>Required environment variables</Label>
              <div className="flex flex-wrap gap-2">
                {setupState.setup.requiredEnvVars.map((envVar) => (
                  <div key={envVar} className="rounded-full border px-3 py-1 text-xs font-medium">
                    {envVar}
                  </div>
                ))}
              </div>
            </div>

            <Separator />

            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Docker</Label>
                <div className="overflow-hidden rounded-lg border">
                  <CodeBlock code={setupState.setup.snippets.docker} language="bash">
                    <CodeBlockCopyButton
                      variant="outline"
                      size="sm"
                      onCopy={() => toast.success("Docker snippet copied")}
                    />
                  </CodeBlock>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Raw CLI</Label>
                <div className="overflow-hidden rounded-lg border">
                  <CodeBlock code={setupState.setup.snippets.raw} language="bash">
                    <CodeBlockCopyButton
                      variant="outline"
                      size="sm"
                      onCopy={() => toast.success("CLI snippet copied")}
                    />
                  </CodeBlock>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
