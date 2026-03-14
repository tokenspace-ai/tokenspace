import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { verifyExecutorInstanceToken } from "./executorAuth";
import { assertWorkspaceAssignedToExecutor, isExecutorInstanceHealthy } from "./executors";

type RoutingCtx = QueryCtx | MutationCtx;

export type QueueKind = "runtime" | "compile";

export type ExecutorUnavailableReason = "unassigned_executor" | "no_healthy_instance";

export type ExecutorUnavailablePayload = {
  errorType: "EXECUTOR_UNAVAILABLE";
  reason: ExecutorUnavailableReason;
  workspaceId: Id<"workspaces">;
  executorId?: Id<"executors">;
};

type SchedulableInstance = Pick<
  Doc<"executorInstances">,
  "_id" | "status" | "expiresAt" | "lastHeartbeatAt" | "maxConcurrentRuntimeJobs" | "maxConcurrentCompileJobs"
>;

type AssignmentAwareRecord = {
  assignedInstanceId?: Id<"executorInstances">;
};

type QueueSchedulableRecord = AssignmentAwareRecord & {
  status: "pending" | "running" | "completed" | "failed" | "canceled";
};

type ScheduledAssignment =
  | {
      kind: "assigned";
      workspaceId: Id<"workspaces">;
      targetExecutorId: Id<"executors">;
      assignedInstanceId: Id<"executorInstances">;
      assignmentUpdatedAt: number;
    }
  | {
      kind: "unavailable";
      workspaceId: Id<"workspaces">;
      targetExecutorId?: Id<"executors">;
      assignmentUpdatedAt: number;
      error: {
        message: string;
        data: ExecutorUnavailablePayload;
      };
    };

function compareInstanceIds(a: Id<"executorInstances">, b: Id<"executorInstances">): number {
  return String(a).localeCompare(String(b));
}

function buildInstanceLoadMap(records: AssignmentAwareRecord[]): Map<Id<"executorInstances">, number> {
  const counts = new Map<Id<"executorInstances">, number>();
  for (const record of records) {
    if (!record.assignedInstanceId) {
      continue;
    }
    counts.set(record.assignedInstanceId, (counts.get(record.assignedInstanceId) ?? 0) + 1);
  }
  return counts;
}

function isNonterminalStatus(status: QueueSchedulableRecord["status"]): boolean {
  return status === "pending" || status === "running";
}

function getInstanceCapacity(instance: SchedulableInstance, queueKind: QueueKind): number | undefined {
  return queueKind === "runtime" ? instance.maxConcurrentRuntimeJobs : instance.maxConcurrentCompileJobs;
}

export function buildExecutorUnavailableError(args: {
  reason: ExecutorUnavailableReason;
  workspaceId: Id<"workspaces">;
  executorId?: Id<"executors">;
}): {
  message: string;
  data: ExecutorUnavailablePayload;
} {
  return {
    message:
      args.reason === "unassigned_executor"
        ? "Workspace has no assigned executor"
        : "No healthy executor instance is available",
    data: {
      errorType: "EXECUTOR_UNAVAILABLE",
      reason: args.reason,
      workspaceId: args.workspaceId,
      ...(args.executorId ? { executorId: args.executorId } : {}),
    },
  };
}

export function pickPreferredExecutorInstance(args: {
  instances: SchedulableInstance[];
  queueKind: QueueKind;
  loadByInstanceId: Map<Id<"executorInstances">, number>;
  now?: number;
}): SchedulableInstance | null {
  const now = args.now ?? Date.now();
  const eligible = args.instances
    .filter((instance) => isExecutorInstanceHealthy(instance, now))
    .filter((instance) => {
      const capacity = getInstanceCapacity(instance, args.queueKind);
      if (capacity == null) {
        return true;
      }
      return (args.loadByInstanceId.get(instance._id) ?? 0) < capacity;
    })
    .sort((a, b) => {
      const loadDiff = (args.loadByInstanceId.get(a._id) ?? 0) - (args.loadByInstanceId.get(b._id) ?? 0);
      if (loadDiff !== 0) {
        return loadDiff;
      }
      if (a.lastHeartbeatAt !== b.lastHeartbeatAt) {
        return b.lastHeartbeatAt - a.lastHeartbeatAt;
      }
      return compareInstanceIds(a._id, b._id);
    });

  return eligible[0] ?? null;
}

async function listExecutorInstances(
  ctx: RoutingCtx,
  executorId: Id<"executors">,
): Promise<Array<Doc<"executorInstances">>> {
  return await ctx.db
    .query("executorInstances")
    .withIndex("by_executor", (q) => q.eq("executorId", executorId))
    .collect();
}

async function listNonterminalQueueAssignments(
  ctx: RoutingCtx,
  args: { executorId: Id<"executors">; queueKind: QueueKind },
): Promise<AssignmentAwareRecord[]> {
  if (args.queueKind === "runtime") {
    const [pending, running] = await Promise.all([
      ctx.db
        .query("jobs")
        .withIndex("by_target_executor_status", (q) =>
          q.eq("targetExecutorId", args.executorId).eq("status", "pending"),
        )
        .collect(),
      ctx.db
        .query("jobs")
        .withIndex("by_target_executor_status", (q) =>
          q.eq("targetExecutorId", args.executorId).eq("status", "running"),
        )
        .collect(),
    ]);
    return [...pending, ...running];
  }

  const [pending, running] = await Promise.all([
    ctx.db
      .query("compileJobs")
      .withIndex("by_target_executor_status", (q) => q.eq("targetExecutorId", args.executorId).eq("status", "pending"))
      .collect(),
    ctx.db
      .query("compileJobs")
      .withIndex("by_target_executor_status", (q) => q.eq("targetExecutorId", args.executorId).eq("status", "running"))
      .collect(),
  ]);
  return [...pending, ...running];
}

export async function scheduleJobToExecutorInstance(
  ctx: RoutingCtx,
  args: {
    workspaceId: Id<"workspaces">;
    queueKind: QueueKind;
    now?: number;
  },
): Promise<ScheduledAssignment> {
  const now = args.now ?? Date.now();
  const workspace = await ctx.db.get(args.workspaceId);
  if (!workspace) {
    throw new Error("Workspace not found");
  }
  if (!workspace.executorId) {
    return {
      kind: "unavailable",
      workspaceId: workspace._id,
      assignmentUpdatedAt: now,
      error: buildExecutorUnavailableError({
        reason: "unassigned_executor",
        workspaceId: workspace._id,
      }),
    };
  }

  const executor = await ctx.db.get(workspace.executorId);
  if (!executor || executor.status !== "active") {
    return {
      kind: "unavailable",
      workspaceId: workspace._id,
      targetExecutorId: workspace.executorId,
      assignmentUpdatedAt: now,
      error: buildExecutorUnavailableError({
        reason: "no_healthy_instance",
        workspaceId: workspace._id,
        executorId: workspace.executorId,
      }),
    };
  }

  const [instances, nonterminalAssignments] = await Promise.all([
    listExecutorInstances(ctx, executor._id),
    listNonterminalQueueAssignments(ctx, {
      executorId: executor._id,
      queueKind: args.queueKind,
    }),
  ]);

  const preferred = pickPreferredExecutorInstance({
    instances,
    queueKind: args.queueKind,
    loadByInstanceId: buildInstanceLoadMap(nonterminalAssignments),
    now,
  });

  if (!preferred) {
    return {
      kind: "unavailable",
      workspaceId: workspace._id,
      targetExecutorId: executor._id,
      assignmentUpdatedAt: now,
      error: buildExecutorUnavailableError({
        reason: "no_healthy_instance",
        workspaceId: workspace._id,
        executorId: executor._id,
      }),
    };
  }

  return {
    kind: "assigned",
    workspaceId: workspace._id,
    targetExecutorId: executor._id,
    assignedInstanceId: preferred._id,
    assignmentUpdatedAt: now,
  };
}

export async function resolveEffectiveAssignedInstanceId(
  ctx: RoutingCtx,
  args: {
    workspaceId?: Id<"workspaces">;
    targetExecutorId?: Id<"executors">;
    assignedInstanceId?: Id<"executorInstances">;
    queueKind: QueueKind;
    now?: number;
  },
): Promise<Id<"executorInstances"> | null> {
  const now = args.now ?? Date.now();
  if (!args.workspaceId || !args.targetExecutorId) {
    return null;
  }

  await assertWorkspaceAssignedToExecutor(ctx, {
    workspaceId: args.workspaceId,
    executorId: args.targetExecutorId,
  });

  const [instances, nonterminalAssignments] = await Promise.all([
    listExecutorInstances(ctx, args.targetExecutorId),
    listNonterminalQueueAssignments(ctx, {
      executorId: args.targetExecutorId,
      queueKind: args.queueKind,
    }),
  ]);

  const assigned = args.assignedInstanceId
    ? instances.find((instance) => instance._id === args.assignedInstanceId)
    : null;
  if (assigned && isExecutorInstanceHealthy(assigned, now)) {
    return assigned._id;
  }

  return (
    pickPreferredExecutorInstance({
      instances,
      queueKind: args.queueKind,
      loadByInstanceId: buildInstanceLoadMap(nonterminalAssignments),
      now,
    })?._id ?? null
  );
}

export async function requireExecutorQueueAccess(
  ctx: RoutingCtx,
  args: {
    instanceToken: string;
    workspaceId?: Id<"workspaces">;
    targetExecutorId?: Id<"executors">;
    assignedInstanceId?: Id<"executorInstances">;
    queueKind: QueueKind;
    now?: number;
  },
): Promise<Awaited<ReturnType<typeof verifyExecutorInstanceToken>>> {
  const now = args.now ?? Date.now();
  const verified = await verifyExecutorInstanceToken(ctx, args.instanceToken, now);

  if (!args.workspaceId) {
    throw new Error("Job is missing workspace assignment");
  }
  if (!args.targetExecutorId) {
    throw new Error("Job is missing executor assignment");
  }
  if (verified.executorId !== args.targetExecutorId) {
    throw new Error("Job is assigned to a different executor");
  }

  const effectiveAssignedInstanceId = await resolveEffectiveAssignedInstanceId(ctx, {
    workspaceId: args.workspaceId,
    targetExecutorId: args.targetExecutorId,
    assignedInstanceId: args.assignedInstanceId,
    queueKind: args.queueKind,
    now,
  });
  if (!effectiveAssignedInstanceId) {
    throw new Error("No healthy executor instance is available for this job");
  }
  if (effectiveAssignedInstanceId !== verified.instanceId) {
    throw new Error("Job is assigned to a different executor instance");
  }

  return verified;
}

export function isClaimableJobForInstance(args: {
  job: QueueSchedulableRecord;
  effectiveAssignedInstanceId: Id<"executorInstances">;
  callerInstanceId: Id<"executorInstances">;
  now?: number;
  leaseExpiresAt?: number;
}): boolean {
  if (args.effectiveAssignedInstanceId !== args.callerInstanceId) {
    return false;
  }
  if (args.job.status === "pending") {
    return true;
  }
  if (args.job.status !== "running") {
    return false;
  }
  const now = args.now ?? Date.now();
  return args.leaseExpiresAt == null || args.leaseExpiresAt < now;
}

export function countNonterminalAssignments<T extends QueueSchedulableRecord>(
  records: T[],
): Map<Id<"executorInstances">, number> {
  return buildInstanceLoadMap(records.filter((record) => isNonterminalStatus(record.status)));
}
