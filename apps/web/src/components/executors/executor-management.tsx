import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronUpIcon,
  KeyRoundIcon,
  ServerIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CodeBlock, CodeBlockCopyButton } from "@/components/ai-elements/code-block";
import { RelativeTime } from "@/components/relative-time";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type ExecutorSetupState = {
  mode?: "create" | "rotate";
  bootstrapToken: string;
  setup: {
    requiredEnvVars: string[];
    snippets: {
      docker: string;
      raw: string;
    };
  };
};

export type ExecutorSummaryRecord = {
  _id: string;
  name: string;
  status: "active" | "disabled";
  onlineInstanceCount: number;
  lastHeartbeatAt: number | null;
  updatedAt: number;
  bootstrapLastUsedAt: number | null;
  canManageLifecycle: boolean;
};

export type ExecutorInstanceRecord = {
  _id: string;
  health: "online" | "offline";
  hostname: string | null;
  version: string | null;
  lastHeartbeatAt: number;
  registeredAt: number;
  maxConcurrentRuntimeJobs: number | null;
  maxConcurrentCompileJobs: number | null;
};

export type ExecutorStatusTableRow = {
  executor: ExecutorSummaryRecord;
  assignedWorkspaceCount?: number;
  isCurrent?: boolean;
  selectable?: boolean;
};

type ExecutorAvailabilityState = {
  key: "online" | "offline" | "disabled";
  label: "Online" | "Offline" | "Disabled";
  badgeClassName: string;
  iconClassName: string;
};

export function formatExecutorDateTime(timestamp: number | null | undefined): string {
  if (!timestamp) return "Never";
  return new Date(timestamp).toLocaleString();
}

export function formatExecutorCapacity(runtime: number | null, compile: number | null): string {
  const runtimeLabel = runtime == null ? "runtime unlimited" : `runtime ${runtime}`;
  const compileLabel = compile == null ? "compile unlimited" : `compile ${compile}`;
  return `${runtimeLabel} / ${compileLabel}`;
}

export function deriveExecutorAvailabilityState(executor: ExecutorSummaryRecord): ExecutorAvailabilityState {
  if (executor.status === "disabled") {
    return {
      key: "disabled",
      label: "Disabled",
      iconClassName: "text-muted-foreground",
      badgeClassName: "border-border text-muted-foreground",
    };
  }

  if (executor.onlineInstanceCount > 0) {
    return {
      key: "online",
      label: "Online",
      iconClassName: "text-emerald-500",
      badgeClassName: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    };
  }

  return {
    key: "offline",
    label: "Offline",
    iconClassName: "text-red-500",
    badgeClassName: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  };
}

export function ExecutorAvailabilityBadge({
  executor,
  className,
}: {
  executor: ExecutorSummaryRecord;
  className?: string;
}) {
  const state = deriveExecutorAvailabilityState(executor);
  return (
    <Badge variant="outline" className={cn(state.badgeClassName, className)}>
      {state.label}
    </Badge>
  );
}

export function ExecutorStatusTable({
  rows,
  selectedExecutorId,
  onSelectExecutor,
  mode = "browse",
  showAssignedWorkspaces = false,
  emptyMessage = "No executors available.",
}: {
  rows: ExecutorStatusTableRow[];
  selectedExecutorId?: string | null;
  onSelectExecutor?: (executorId: string) => void;
  mode?: "browse" | "select";
  showAssignedWorkspaces?: boolean;
  emptyMessage?: string;
}) {
  const selectable = mode === "select";

  const renderTable = () => (
    <Table>
      <TableHeader>
        <TableRow>
          {selectable ? <TableHead className="w-12">Pick</TableHead> : null}
          <TableHead>Executor</TableHead>
          <TableHead>Availability</TableHead>
          <TableHead>Online Instances</TableHead>
          <TableHead>Last Heartbeat</TableHead>
          {showAssignedWorkspaces ? <TableHead>Assigned Workspaces</TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={showAssignedWorkspaces ? (selectable ? 6 : 5) : selectable ? 5 : 4}>
              <div className="py-6 text-center text-sm text-muted-foreground">{emptyMessage}</div>
            </TableCell>
          </TableRow>
        ) : (
          rows.map((row) => {
            const { executor } = row;
            const isSelected = executor._id === selectedExecutorId;
            const canSelect = row.selectable ?? true;
            return (
              <TableRow
                key={executor._id}
                data-state={isSelected ? "selected" : undefined}
                className={cn(onSelectExecutor && canSelect ? "cursor-pointer" : undefined)}
                onClick={() => {
                  if (onSelectExecutor && canSelect) {
                    onSelectExecutor(executor._id);
                  }
                }}
              >
                {selectable ? (
                  <TableCell>
                    <RadioGroupItem
                      value={executor._id}
                      disabled={!canSelect}
                      aria-label={`Select ${executor.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                      }}
                    />
                  </TableCell>
                ) : null}
                <TableCell>
                  <div className="flex items-center gap-2">
                    <ServerIcon className={cn("size-4", deriveExecutorAvailabilityState(executor).iconClassName)} />
                    <div className="min-w-0">
                      <div className="font-medium">{executor.name}</div>
                      <div className="flex flex-wrap gap-2 pt-1">
                        {row.isCurrent ? (
                          <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
                            Current
                          </Badge>
                        ) : null}
                        {!canSelect && selectable ? (
                          <Badge variant="outline" className="text-[10px] text-muted-foreground">
                            Read only
                          </Badge>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <ExecutorAvailabilityBadge executor={executor} className="text-[10px]" />
                </TableCell>
                <TableCell>{executor.onlineInstanceCount}</TableCell>
                <TableCell>
                  {executor.lastHeartbeatAt ? (
                    <div>
                      <div className="font-medium">
                        <RelativeTime timestamp={executor.lastHeartbeatAt} />
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {formatExecutorDateTime(executor.lastHeartbeatAt)}
                      </div>
                    </div>
                  ) : (
                    <span className="text-muted-foreground">Never</span>
                  )}
                </TableCell>
                {showAssignedWorkspaces ? (
                  <TableCell>{row.assignedWorkspaceCount ? row.assignedWorkspaceCount : 0}</TableCell>
                ) : null}
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );

  if (!selectable) {
    return renderTable();
  }

  return (
    <RadioGroup value={selectedExecutorId ?? ""} onValueChange={onSelectExecutor} className="gap-0">
      {renderTable()}
    </RadioGroup>
  );
}

export function ExecutorInstancesTable({
  instances,
  emptyMessage = "No instances have registered yet.",
  initialVisibleCount = 5,
}: {
  instances: ExecutorInstanceRecord[];
  emptyMessage?: string;
  initialVisibleCount?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const instanceSetKey = useMemo(
    () =>
      instances
        .map((instance) => instance._id)
        .sort()
        .join(":"),
    [instances],
  );

  useEffect(() => {
    setExpanded(false);
  }, [instanceSetKey]);

  if (instances.length === 0) {
    return <div className="px-4 py-6 text-sm text-muted-foreground">{emptyMessage}</div>;
  }

  const visibleInstances = expanded ? instances : instances.slice(0, initialVisibleCount);
  const hasHiddenInstances = instances.length > initialVisibleCount;

  return (
    <div>
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
          {visibleInstances.map((instance) => (
            <TableRow key={instance._id}>
              <TableCell>
                <Badge
                  variant="outline"
                  className={cn(
                    "text-[10px]",
                    instance.health === "online"
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
                  )}
                >
                  {instance.health === "online" ? "Online" : "Offline"}
                </Badge>
              </TableCell>
              <TableCell>{instance.hostname ?? "Unknown host"}</TableCell>
              <TableCell>{instance.version ?? "Unknown version"}</TableCell>
              <TableCell>
                <div className="font-medium">
                  <RelativeTime timestamp={instance.lastHeartbeatAt} />
                </div>
                <div className="text-xs text-muted-foreground">{formatExecutorDateTime(instance.lastHeartbeatAt)}</div>
              </TableCell>
              <TableCell className="text-muted-foreground">{formatExecutorDateTime(instance.registeredAt)}</TableCell>
              <TableCell className="text-muted-foreground">
                {formatExecutorCapacity(instance.maxConcurrentRuntimeJobs, instance.maxConcurrentCompileJobs)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {hasHiddenInstances ? (
        <div className="border-t px-4 py-3">
          <Button variant="ghost" size="sm" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
            {expanded ? (
              <>
                <ChevronUpIcon className="mr-2 size-4" />
                Show less
              </>
            ) : (
              <>
                <ChevronDownIcon className="mr-2 size-4" />
                Show {instances.length - initialVisibleCount} more
              </>
            )}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function ExecutorSetupInstructionsCard({
  setupState,
  title = "Setup Instructions",
  description = "The bootstrap credential is shown only for this create flow. Store it before leaving the page.",
  credentialNotice = "Tokenspace will not re-show this plaintext bootstrap token after this view is gone.",
}: {
  setupState: ExecutorSetupState;
  title?: string;
  description?: string;
  credentialNotice?: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRoundIcon className="size-4" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <Alert className="border-emerald-500/20 bg-emerald-500/5">
          <CheckCircle2Icon className="text-emerald-500" />
          <AlertTitle>Bootstrap credential</AlertTitle>
          <AlertDescription>{credentialNotice}</AlertDescription>
        </Alert>

        <div className="space-y-2">
          <Label>Bootstrap token</Label>
          <div className="overflow-hidden rounded-lg border">
            <CodeBlock code={setupState.bootstrapToken} language="bash" fontSize="xs">
              <CodeBlockCopyButton variant="outline" size="sm" onCopy={() => toast.success("Bootstrap token copied")} />
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
                <CodeBlockCopyButton variant="outline" size="sm" onCopy={() => toast.success("CLI snippet copied")} />
              </CodeBlock>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function ExecutorAssignmentWarning({ children }: { children: ReactNode }) {
  return (
    <Alert>
      <AlertCircleIcon />
      <AlertTitle>Routing changes immediately</AlertTitle>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
