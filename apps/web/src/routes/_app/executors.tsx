import { convexQuery } from "@convex-dev/react-query";
import { useQuery as useTanstackQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { api } from "@tokenspace/backend/convex/_generated/api";
import { useMutation, useQuery } from "convex/react";
import { Loader2, PlusIcon, ServerIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ExecutorAvailabilityBadge,
  ExecutorInstancesTable,
  ExecutorSetupInstructionsCard,
  type ExecutorSetupState,
  ExecutorStatusTable,
  formatExecutorDateTime,
} from "@/components/executors/executor-management";
import { UserMenu } from "@/components/header/user-menu";
import { Logo } from "@/components/logo";
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
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";

export const Route = createFileRoute("/_app/executors")({
  component: ExecutorsPage,
  ssr: false,
});

function ExecutorsPage() {
  const { user, signOut } = useAuth();
  const healthCheck = useTanstackQuery(convexQuery(api.health.check, {}));
  const executorResponse = useQuery(api.executors.listManageableExecutors, {});
  const createExecutorUnassigned = useMutation(api.executors.createExecutorUnassigned);
  const [selectedExecutorId, setSelectedExecutorId] = useState<string | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newExecutorName, setNewExecutorName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [setupState, setSetupState] = useState<ExecutorSetupState | null>(null);

  const rows = useMemo(
    () =>
      (executorResponse?.executors ?? []).map((entry) => ({
        executor: entry.executor,
        assignedWorkspaceCount: entry.assignedWorkspaceCount,
      })),
    [executorResponse],
  );

  useEffect(() => {
    if (!executorResponse?.executors.length) {
      setSelectedExecutorId(null);
      return;
    }

    setSelectedExecutorId((current) => {
      if (current && executorResponse.executors.some((entry) => entry.executor._id === current)) {
        return current;
      }
      return executorResponse.executors[0]?.executor._id ?? null;
    });
  }, [executorResponse]);

  const selectedExecutor = useMemo(
    () => executorResponse?.executors.find((entry) => entry.executor._id === selectedExecutorId) ?? null,
    [executorResponse, selectedExecutorId],
  );

  const handleCreateExecutor = async () => {
    if (!newExecutorName.trim()) {
      toast.error("Executor name is required");
      return;
    }
    setIsCreating(true);
    try {
      const result = await createExecutorUnassigned({
        name: newExecutorName.trim(),
      });
      setSetupState({
        bootstrapToken: result.bootstrapToken,
        setup: result.setup,
      });
      setSelectedExecutorId(result.executor._id);
      setCreateDialogOpen(false);
      setNewExecutorName("");
      toast.success("Executor created");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create executor");
      console.error(error);
    } finally {
      setIsCreating(false);
    }
  };

  if (executorResponse === undefined) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading executors...
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-svh flex flex-col">
      <header className="border-b border-border/50 px-6 py-4">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <Link to="/" className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Logo className="h-8 w-auto" />
          </Link>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <div
                className={`size-1.5 rounded-full ${healthCheck.data === "OK" ? "bg-green-500" : healthCheck.isLoading ? "bg-orange-400" : "bg-red-500"}`}
              />
              <span className="text-muted-foreground text-xs">
                {healthCheck.isLoading ? "Connecting..." : healthCheck.data === "OK" ? "Online" : "Offline"}
              </span>
            </div>
            {user ? <UserMenu user={user} onSignOut={signOut} /> : null}
          </div>
        </div>
      </header>

      <main className="flex-1 px-6 py-8">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div className="space-y-2">
              <p className="text-sm uppercase tracking-[0.2em] text-muted-foreground">Infrastructure</p>
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">Executors</h1>
                <p className="max-w-2xl text-sm text-muted-foreground">
                  Inspect every executor you can manage, compare live health across fleets, and mint bootstrap
                  credentials for new ones without assigning them to a workspace first.
                </p>
              </div>
            </div>
            <Button onClick={() => setCreateDialogOpen(true)}>
              <PlusIcon className="mr-2 size-4" />
              Create executor
            </Button>
          </div>

          {executorResponse.executors.length === 0 ? (
            <Empty className="border bg-muted/15 py-12">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ServerIcon className="size-5" />
                </EmptyMedia>
                <EmptyTitle>No managed executors yet</EmptyTitle>
                <EmptyDescription>
                  Create your first executor here, then assign it from any workspace that should run against it.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button onClick={() => setCreateDialogOpen(true)}>
                  <PlusIcon className="mr-2 size-4" />
                  Create executor
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <>
              <Card className="border-border/70">
                <CardHeader>
                  <CardTitle>Managed fleets</CardTitle>
                  <CardDescription>
                    Select an executor to inspect its instances and workspace assignments.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ExecutorStatusTable
                    rows={rows}
                    mode="browse"
                    selectedExecutorId={selectedExecutorId}
                    onSelectExecutor={setSelectedExecutorId}
                    showAssignedWorkspaces
                  />
                </CardContent>
              </Card>

              {selectedExecutor ? (
                <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
                  <Card>
                    <CardHeader className="gap-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <CardTitle className="flex items-center gap-2">
                            <ServerIcon className="size-4" />
                            {selectedExecutor.executor.name}
                          </CardTitle>
                          <CardDescription>
                            Instance heartbeat and capacity snapshots for this executor.
                          </CardDescription>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <ExecutorAvailabilityBadge executor={selectedExecutor.executor} className="text-[10px]" />
                          <Badge variant="outline" className="text-[10px] capitalize">
                            {selectedExecutor.executor.status}
                          </Badge>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="grid gap-3 md:grid-cols-3">
                        <MetricCard
                          label="Online Instances"
                          value={String(selectedExecutor.executor.onlineInstanceCount)}
                        />
                        <MetricCard
                          label="Last Heartbeat"
                          value={formatExecutorDateTime(selectedExecutor.executor.lastHeartbeatAt)}
                        />
                        <MetricCard
                          label="Bootstrap Last Used"
                          value={formatExecutorDateTime(selectedExecutor.executor.bootstrapLastUsedAt)}
                        />
                      </div>
                      <div className="rounded-lg border">
                        <div className="border-b px-4 py-3">
                          <h3 className="text-sm font-medium">Executor Instances</h3>
                        </div>
                        <ExecutorInstancesTable instances={selectedExecutor.instances} />
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle>Assigned workspaces</CardTitle>
                      <CardDescription>Workspaces currently routed to this executor.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {selectedExecutor.assignedWorkspaces.length === 0 ? (
                        <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
                          No workspaces are assigned to this executor yet.
                        </div>
                      ) : (
                        selectedExecutor.assignedWorkspaces.map((workspace) => (
                          <Link
                            key={workspace._id}
                            to="/workspace/$slug/admin/executor"
                            params={{ slug: workspace.slug }}
                            className="flex items-center justify-between rounded-lg border p-3 transition-colors hover:bg-muted/40"
                          >
                            <div>
                              <div className="font-medium">{workspace.name}</div>
                              <div className="text-xs text-muted-foreground">{workspace.slug}</div>
                            </div>
                            <Badge variant="outline">Open</Badge>
                          </Link>
                        ))
                      )}
                    </CardContent>
                  </Card>
                </div>
              ) : null}
            </>
          )}

          {setupState ? (
            <ExecutorSetupInstructionsCard
              setupState={setupState}
              title="New Executor Bootstrap"
              description="The plaintext bootstrap token is only shown immediately after creation."
            />
          ) : null}
        </div>
      </main>

      <Dialog
        open={createDialogOpen}
        onOpenChange={(open) => {
          setCreateDialogOpen(open);
          if (!open) {
            setNewExecutorName("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create executor</DialogTitle>
            <DialogDescription>
              Create a self-hosted executor without assigning it to any workspace yet.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 py-2">
            <Label htmlFor="executor-name">Executor name</Label>
            <Input
              id="executor-name"
              placeholder="Shared staging fleet"
              value={newExecutorName}
              onChange={(event) => setNewExecutorName(event.target.value)}
            />
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
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-2 text-sm font-medium">{value}</div>
    </div>
  );
}
