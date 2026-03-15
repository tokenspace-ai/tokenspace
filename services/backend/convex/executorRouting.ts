import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { verifyExecutorInstanceToken } from "./executorAuth";
import { assertWorkspaceAssignedToExecutor, isExecutorInstanceHealthy } from "./executors";

type ReadRoutingCtx = QueryCtx | MutationCtx;
type WriteRoutingCtx = MutationCtx;

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

type SessionExecutorAssignmentDoc = Doc<"sessionExecutorAssignments">;

function compareInstanceIds(a: Id<"executorInstances">, b: Id<"executorInstances">): number {
  return String(a).localeCompare(String(b));
}

async function getSessionExecutorAssignment(
  ctx: ReadRoutingCtx,
  sessionId: Id<"sessions">,
): Promise<SessionExecutorAssignmentDoc | null> {
  return await ctx.db
    .query("sessionExecutorAssignments")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .first();
}

async function upsertSessionExecutorAssignment(
  ctx: WriteRoutingCtx,
  args: {
    sessionId: Id<"sessions">;
    workspaceId: Id<"workspaces">;
    executorId: Id<"executors">;
    assignedInstanceId: Id<"executorInstances">;
    now: number;
  },
): Promise<void> {
  const existing = await getSessionExecutorAssignment(ctx, args.sessionId);
  if (existing) {
    await ctx.db.patch(existing._id, {
      workspaceId: args.workspaceId,
      executorId: args.executorId,
      assignedInstanceId: args.assignedInstanceId,
      updatedAt: args.now,
    });
    return;
  }

  await ctx.db.insert("sessionExecutorAssignments", {
    sessionId: args.sessionId,
    workspaceId: args.workspaceId,
    executorId: args.executorId,
    assignedInstanceId: args.assignedInstanceId,
    createdAt: args.now,
    updatedAt: args.now,
  });
}

async function deleteSessionExecutorAssignmentBySessionId(
  ctx: WriteRoutingCtx,
  sessionId: Id<"sessions">,
): Promise<void> {
  const existing = await getSessionExecutorAssignment(ctx, sessionId);
  if (existing) {
    await ctx.db.delete(existing._id);
  }
}

async function assertSessionBelongsToWorkspace(
  ctx: ReadRoutingCtx,
  args: { sessionId: Id<"sessions">; workspaceId: Id<"workspaces"> },
): Promise<void> {
  const session = await ctx.db.get(args.sessionId);
  if (!session) {
    throw new Error("Session not found");
  }
  const revision = await ctx.db.get(session.revisionId);
  if (!revision) {
    throw new Error("Session revision not found");
  }
  if (revision.workspaceId !== args.workspaceId) {
    throw new Error("Session does not belong to workspace");
  }
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
  preferredInstanceId?: Id<"executorInstances">;
  honorPreferredCapacity?: boolean;
  now?: number;
}): SchedulableInstance | null {
  const now = args.now ?? Date.now();
  const healthyInstances = args.instances.filter((instance) => isExecutorInstanceHealthy(instance, now));
  const preferred = args.preferredInstanceId
    ? healthyInstances.find((instance) => instance._id === args.preferredInstanceId)
    : null;
  if (preferred) {
    if (args.honorPreferredCapacity) {
      return preferred;
    }
    const capacity = getInstanceCapacity(preferred, args.queueKind);
    if (capacity == null || (args.loadByInstanceId.get(preferred._id) ?? 0) < capacity) {
      return preferred;
    }
  }

  const eligible = healthyInstances
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
  ctx: ReadRoutingCtx,
  executorId: Id<"executors">,
): Promise<Array<Doc<"executorInstances">>> {
  return await ctx.db
    .query("executorInstances")
    .withIndex("by_executor", (q) => q.eq("executorId", executorId))
    .collect();
}

async function listNonterminalQueueAssignments(
  ctx: ReadRoutingCtx,
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
  ctx: WriteRoutingCtx,
  args: {
    workspaceId: Id<"workspaces">;
    queueKind: QueueKind;
    sessionId?: Id<"sessions">;
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
  let preferredInstanceId: Id<"executorInstances"> | undefined;
  if (args.queueKind === "runtime" && args.sessionId) {
    await assertSessionBelongsToWorkspace(ctx, {
      sessionId: args.sessionId,
      workspaceId: workspace._id,
    });
    const assignment = await getSessionExecutorAssignment(ctx, args.sessionId);
    if (assignment?.executorId === executor._id) {
      preferredInstanceId = assignment.assignedInstanceId;
    }
  }

  const preferred = pickPreferredExecutorInstance({
    instances,
    queueKind: args.queueKind,
    loadByInstanceId: buildInstanceLoadMap(nonterminalAssignments),
    preferredInstanceId,
    honorPreferredCapacity: args.queueKind === "runtime" && args.sessionId !== undefined,
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

  if (args.queueKind === "runtime" && args.sessionId) {
    await upsertSessionExecutorAssignment(ctx, {
      sessionId: args.sessionId,
      workspaceId: workspace._id,
      executorId: executor._id,
      assignedInstanceId: preferred._id,
      now,
    });
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
  ctx: ReadRoutingCtx,
  args: {
    workspaceId?: Id<"workspaces">;
    targetExecutorId?: Id<"executors">;
    assignedInstanceId?: Id<"executorInstances">;
    queueKind: QueueKind;
    sessionId?: Id<"sessions">;
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
  let preferredInstanceId: Id<"executorInstances"> | undefined;
  if (args.queueKind === "runtime" && args.sessionId) {
    await assertSessionBelongsToWorkspace(ctx, {
      sessionId: args.sessionId,
      workspaceId: args.workspaceId,
    });
    const assignment = await getSessionExecutorAssignment(ctx, args.sessionId);
    if (assignment?.executorId === args.targetExecutorId) {
      preferredInstanceId = assignment.assignedInstanceId;
    }
  }

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
      preferredInstanceId,
      honorPreferredCapacity: args.queueKind === "runtime" && args.sessionId !== undefined,
      now,
    })?._id ?? null
  );
}

export async function requireExecutorQueueAccess(
  ctx: ReadRoutingCtx,
  args: {
    instanceToken: string;
    workspaceId?: Id<"workspaces">;
    targetExecutorId?: Id<"executors">;
    assignedInstanceId?: Id<"executorInstances">;
    queueKind: QueueKind;
    sessionId?: Id<"sessions">;
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
    sessionId: args.sessionId,
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

export async function moveSessionExecutorAssignment(
  ctx: WriteRoutingCtx,
  args: {
    sessionId: Id<"sessions">;
    workspaceId: Id<"workspaces">;
    executorId: Id<"executors">;
    assignedInstanceId: Id<"executorInstances">;
    now?: number;
  },
): Promise<void> {
  await assertSessionBelongsToWorkspace(ctx, {
    sessionId: args.sessionId,
    workspaceId: args.workspaceId,
  });
  await upsertSessionExecutorAssignment(ctx, {
    sessionId: args.sessionId,
    workspaceId: args.workspaceId,
    executorId: args.executorId,
    assignedInstanceId: args.assignedInstanceId,
    now: args.now ?? Date.now(),
  });
}

export async function clearSessionExecutorAssignment(
  ctx: WriteRoutingCtx,
  args: { sessionId: Id<"sessions"> },
): Promise<void> {
  await deleteSessionExecutorAssignmentBySessionId(ctx, args.sessionId);
}

export async function clearSessionExecutorAssignmentsForWorkspace(
  ctx: WriteRoutingCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<number> {
  const assignments = await ctx.db
    .query("sessionExecutorAssignments")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .collect();
  for (const assignment of assignments) {
    await ctx.db.delete(assignment._id);
  }
  return assignments.length;
}

export async function clearSessionExecutorAssignmentsForExecutor(
  ctx: WriteRoutingCtx,
  args: { executorId: Id<"executors"> },
): Promise<number> {
  const assignments = await ctx.db
    .query("sessionExecutorAssignments")
    .withIndex("by_executor", (q) => q.eq("executorId", args.executorId))
    .collect();
  for (const assignment of assignments) {
    await ctx.db.delete(assignment._id);
  }
  return assignments.length;
}
