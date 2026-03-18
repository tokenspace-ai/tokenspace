import type { UserIdentity } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  type ActionCtx,
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from "./_generated/server";
import { requireAuthenticatedUser, requireWorkspaceAdmin, requireWorkspaceMember } from "./authz";
import {
  buildExecutorSetupPayload,
  createOpaqueToken,
  EXECUTOR_HEARTBEAT_INTERVAL_MS,
  EXECUTOR_HEARTBEAT_TIMEOUT_MS,
  EXECUTOR_INSTANCE_TOKEN_TTL_MS,
  shouldRotateInstanceToken,
  verifyExecutorBootstrapToken,
  verifyExecutorInstanceToken,
} from "./executorAuth";
import {
  clearSessionExecutorAssignmentsForExecutor,
  clearSessionExecutorAssignmentsForWorkspace,
} from "./executorRouting";

type ExecutorCtx = QueryCtx | MutationCtx | ActionCtx;
type ExecutorDoc = Doc<"executors">;
type WorkspaceDoc = Doc<"workspaces">;
type ExecutorInstanceDoc = Doc<"executorInstances">;
type ExecutorWriteCtx = MutationCtx;
type AssignedWorkspaceRef = Pick<WorkspaceDoc, "_id" | "name" | "slug">;

export const LOCAL_DEV_EXECUTOR_NAME = "Local Dev Executor";
export const LOCAL_DEV_EXECUTOR_CREATED_BY = "dev-seed";
export const EXECUTOR_INACTIVE_INSTANCE_RETENTION_MS = 24 * 60 * 60_000;
const EXECUTOR_INSTANCE_CLEANUP_BATCH_SIZE = 128;

function getConvexUrl(): string {
  const url = process.env.CONVEX_URL?.trim() || process.env.CONVEX_CLOUD_URL?.trim();
  if (!url) {
    throw new Error("Server misconfigured: neither CONVEX_URL nor CONVEX_CLOUD_URL is set");
  }
  return url;
}

type ExecutorManagerIdentity = Pick<UserIdentity, "subject"> & { role?: string | null };

function normalizeExecutorName(name: string): string {
  const normalized = name.trim();
  if (!normalized) {
    throw new Error("Executor name is required");
  }
  return normalized;
}

function sortExecutorsByName(executors: ExecutorDoc[]): ExecutorDoc[] {
  return [...executors].sort((a, b) => a.name.localeCompare(b.name));
}

function mapInstancesByExecutorId(instances: ExecutorInstanceDoc[]): Map<Id<"executors">, ExecutorInstanceDoc[]> {
  const map = new Map<Id<"executors">, ExecutorInstanceDoc[]>();
  for (const instance of instances) {
    const current = map.get(instance.executorId);
    if (current) {
      current.push(instance);
    } else {
      map.set(instance.executorId, [instance]);
    }
  }
  return map;
}

function mapAssignedWorkspacesByExecutorId(workspaces: WorkspaceDoc[]): Map<Id<"executors">, AssignedWorkspaceRef[]> {
  const map = new Map<Id<"executors">, AssignedWorkspaceRef[]>();
  for (const workspace of workspaces) {
    if (!workspace.executorId) {
      continue;
    }
    const current = map.get(workspace.executorId);
    const ref = {
      _id: workspace._id,
      name: workspace.name,
      slug: workspace.slug,
    };
    if (current) {
      current.push(ref);
    } else {
      map.set(workspace.executorId, [ref]);
    }
  }
  return map;
}

function maxOrNull(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return Math.max(...values);
}

export function isExecutorInstanceHealthy(
  instance: Pick<ExecutorInstanceDoc, "status" | "expiresAt">,
  now: number = Date.now(),
): boolean {
  return instance.status === "online" && instance.expiresAt >= now;
}

export function deriveExecutorInstanceHealth(
  instance: Pick<ExecutorInstanceDoc, "status" | "expiresAt">,
  now: number = Date.now(),
): "online" | "offline" {
  return isExecutorInstanceHealthy(instance, now) ? "online" : "offline";
}

export function canManageExecutorLifecycle(args: {
  executor: Pick<ExecutorDoc, "createdBy">;
  user: ExecutorManagerIdentity;
}): boolean {
  return args.user.role === "admin" || args.user.subject === args.executor.createdBy;
}

export function assertWorkspaceExecutorAssignmentState(args: {
  executor: Pick<ExecutorDoc, "_id" | "status"> | null;
  workspace: Pick<WorkspaceDoc, "_id" | "executorId"> | null;
  expectedExecutorId: Id<"executors">;
}): void {
  if (!args.workspace) {
    throw new Error("Workspace not found");
  }
  if (!args.executor) {
    throw new Error("Executor not found");
  }
  if (args.executor._id !== args.expectedExecutorId) {
    throw new Error("Executor document does not match expected executor id");
  }
  if (args.executor.status !== "active") {
    throw new Error("Executor is not active");
  }
  if (args.workspace.executorId !== args.expectedExecutorId) {
    throw new Error("Workspace is not assigned to executor");
  }
}

export function buildExecutorSummary(
  executor: ExecutorDoc,
  instances: ExecutorInstanceDoc[],
  args?: { now?: number; canManageLifecycle?: boolean },
) {
  const now = args?.now ?? Date.now();
  return {
    _id: executor._id,
    name: executor.name,
    status: executor.status,
    authMode: executor.authMode,
    tokenVersion: executor.tokenVersion,
    createdBy: executor.createdBy,
    createdAt: executor.createdAt,
    updatedAt: executor.updatedAt,
    bootstrapIssuedAt: executor.bootstrapIssuedAt,
    bootstrapLastUsedAt: executor.bootstrapLastUsedAt ?? null,
    onlineInstanceCount: instances.filter((instance) => isExecutorInstanceHealthy(instance, now)).length,
    lastHeartbeatAt: maxOrNull(instances.map((instance) => instance.lastHeartbeatAt)),
    lastRegistrationAt: maxOrNull(instances.map((instance) => instance.registeredAt)),
    canManageLifecycle: args?.canManageLifecycle ?? false,
  };
}

function buildExecutorInstanceStatus(instance: ExecutorInstanceDoc, now: number = Date.now()) {
  return {
    _id: instance._id,
    executorId: instance.executorId,
    tokenVersion: instance.tokenVersion,
    status: instance.status,
    health: deriveExecutorInstanceHealth(instance, now),
    registeredAt: instance.registeredAt,
    lastHeartbeatAt: instance.lastHeartbeatAt,
    expiresAt: instance.expiresAt,
    instanceTokenIssuedAt: instance.instanceTokenIssuedAt,
    instanceTokenExpiresAt: instance.instanceTokenExpiresAt,
    hostname: instance.hostname ?? null,
    version: instance.version ?? null,
    maxConcurrentRuntimeJobs: instance.maxConcurrentRuntimeJobs ?? null,
    maxConcurrentCompileJobs: instance.maxConcurrentCompileJobs ?? null,
  };
}

async function getExecutorDoc(ctx: ExecutorCtx, executorId: Id<"executors">): Promise<ExecutorDoc | null> {
  if ("db" in ctx) {
    return await ctx.db.get(executorId);
  }
  return await ctx.runQuery(internal.executors.getExecutorInternal, { executorId });
}

async function getWorkspaceDoc(ctx: ExecutorCtx, workspaceId: Id<"workspaces">): Promise<WorkspaceDoc | null> {
  if ("db" in ctx) {
    return await ctx.db.get(workspaceId);
  }
  return await ctx.runQuery(internal.workspace.getInternal, { workspaceId });
}

function sortExecutorsByRecency(executors: ExecutorDoc[]): ExecutorDoc[] {
  return [...executors].sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) {
      return b.updatedAt - a.updatedAt;
    }
    return String(b._id).localeCompare(String(a._id));
  });
}

async function listExecutorsByMarker(
  ctx: ExecutorWriteCtx,
  args: { name: string; createdBy: string },
): Promise<ExecutorDoc[]> {
  const executors = await ctx.db.query("executors").collect();
  return sortExecutorsByRecency(
    executors.filter((executor) => executor.name === args.name && executor.createdBy === args.createdBy),
  );
}

export async function cleanupStaleExecutorInstancesInternalImpl(
  ctx: ExecutorWriteCtx,
  args?: { now?: number },
): Promise<{ deletedCount: number }> {
  const now = args?.now ?? Date.now();
  const cutoff = now - EXECUTOR_INACTIVE_INSTANCE_RETENTION_MS;
  let deletedCount = 0;

  while (true) {
    const staleInstances = await ctx.db
      .query("executorInstances")
      .withIndex("by_expires_at", (q) => q.lt("expiresAt", cutoff))
      .take(EXECUTOR_INSTANCE_CLEANUP_BATCH_SIZE);
    if (staleInstances.length === 0) {
      break;
    }

    for (const instance of staleInstances) {
      const [pendingJobs, runningJobs, pendingCompileJobs, runningCompileJobs] = await Promise.all([
        ctx.db
          .query("jobs")
          .withIndex("by_assigned_instance_status", (q) =>
            q.eq("assignedInstanceId", instance._id).eq("status", "pending"),
          )
          .collect(),
        ctx.db
          .query("jobs")
          .withIndex("by_assigned_instance_status", (q) =>
            q.eq("assignedInstanceId", instance._id).eq("status", "running"),
          )
          .collect(),
        ctx.db
          .query("compileJobs")
          .withIndex("by_assigned_instance_status", (q) =>
            q.eq("assignedInstanceId", instance._id).eq("status", "pending"),
          )
          .collect(),
        ctx.db
          .query("compileJobs")
          .withIndex("by_assigned_instance_status", (q) =>
            q.eq("assignedInstanceId", instance._id).eq("status", "running"),
          )
          .collect(),
      ]);
      for (const job of [...pendingJobs, ...runningJobs]) {
        await ctx.db.patch(job._id, {
          assignedInstanceId: undefined,
          assignmentUpdatedAt: now,
        });
      }
      for (const job of [...pendingCompileJobs, ...runningCompileJobs]) {
        await ctx.db.patch(job._id, {
          assignedInstanceId: undefined,
          assignmentUpdatedAt: now,
        });
      }

      const assignments = await ctx.db
        .query("sessionExecutorAssignments")
        .withIndex("by_instance", (q) => q.eq("assignedInstanceId", instance._id))
        .collect();
      for (const assignment of assignments) {
        await ctx.db.delete(assignment._id);
      }
      await ctx.db.delete(instance._id);
    }
    deletedCount += staleInstances.length;
  }

  return {
    deletedCount,
  };
}

export async function setWorkspaceExecutorInternalImpl(
  ctx: ExecutorWriteCtx,
  args: {
    workspaceId: Id<"workspaces">;
    executorId: Id<"executors"> | undefined;
    failPendingJobs?: boolean;
  },
): Promise<void> {
  const workspace = await ctx.db.get(args.workspaceId);
  if (!workspace) {
    throw new Error("Workspace not found");
  }

  if (args.executorId !== undefined) {
    const executor = await ctx.db.get(args.executorId);
    if (!executor) {
      throw new Error("Executor not found");
    }
    if (executor.status !== "active") {
      throw new Error("Executor is not active");
    }
  }
  if (workspace.executorId !== args.executorId) {
    await assertWorkspaceExecutorAssignmentCanChange(ctx, {
      workspaceId: args.workspaceId,
      currentExecutorId: workspace.executorId,
      failPendingJobs: args.failPendingJobs ?? false,
    });
    await clearSessionExecutorAssignmentsForWorkspace(ctx, {
      workspaceId: args.workspaceId,
    });
  }

  await ctx.db.patch(args.workspaceId, {
    executorId: args.executorId,
    updatedAt: Date.now(),
  });
}

async function createExecutorInternalRecord(
  ctx: ExecutorWriteCtx,
  args: { name: string; createdBy: string; now: number },
): Promise<{ executorId: Id<"executors">; bootstrapToken: string }> {
  const bootstrap = await createOpaqueToken();
  const executorId = await ctx.db.insert("executors", {
    name: normalizeExecutorName(args.name),
    status: "active",
    authMode: "opaque_secret",
    tokenVersion: 1,
    bootstrapTokenId: bootstrap.tokenId,
    bootstrapTokenHash: bootstrap.tokenHash,
    bootstrapIssuedAt: args.now,
    createdBy: args.createdBy,
    createdAt: args.now,
    updatedAt: args.now,
  });
  return {
    executorId,
    bootstrapToken: bootstrap.token,
  };
}

async function rotateExecutorBootstrapInternal(
  ctx: ExecutorWriteCtx,
  args: { executor: ExecutorDoc; now: number },
): Promise<{ bootstrapToken: string }> {
  const bootstrap = await createOpaqueToken();
  await ctx.db.patch(args.executor._id, {
    bootstrapTokenId: bootstrap.tokenId,
    bootstrapTokenHash: bootstrap.tokenHash,
    bootstrapIssuedAt: args.now,
    bootstrapLastUsedAt: undefined,
    tokenVersion: args.executor.tokenVersion + 1,
    updatedAt: args.now,
  });
  const instances = await ctx.db
    .query("executorInstances")
    .withIndex("by_executor", (q) => q.eq("executorId", args.executor._id))
    .collect();
  for (const instance of instances) {
    if (instance.status === "online") {
      await ctx.db.patch(instance._id, { status: "offline", expiresAt: args.now });
    }
  }
  return {
    bootstrapToken: bootstrap.token,
  };
}

export async function ensureLocalDevExecutorInternalImpl(
  ctx: ExecutorWriteCtx,
  args: {
    workspaceIds?: Id<"workspaces">[];
    rotateBootstrap?: boolean;
  },
): Promise<{
  executorId: Id<"executors">;
  assignedWorkspaceIds: Id<"workspaces">[];
  bootstrapToken?: string;
}> {
  const now = Date.now();
  const existing = await listExecutorsByMarker(ctx, {
    name: LOCAL_DEV_EXECUTOR_NAME,
    createdBy: LOCAL_DEV_EXECUTOR_CREATED_BY,
  });

  let executor = existing[0] ?? null;
  let bootstrapToken: string | undefined;

  if (!executor) {
    const created = await createExecutorInternalRecord(ctx, {
      name: LOCAL_DEV_EXECUTOR_NAME,
      createdBy: LOCAL_DEV_EXECUTOR_CREATED_BY,
      now,
    });
    const createdExecutor = await ctx.db.get(created.executorId);
    bootstrapToken = created.bootstrapToken;
    if (!createdExecutor) {
      throw new Error("Executor not found after creation");
    }
    executor = createdExecutor;
  } else if (executor.status !== "active") {
    await ctx.db.patch(executor._id, {
      status: "active",
      updatedAt: now,
    });
    const reactivatedExecutor = await ctx.db.get(executor._id);
    if (!reactivatedExecutor) {
      throw new Error("Executor not found after reactivation");
    }
    executor = reactivatedExecutor;
  }

  if (args.rotateBootstrap) {
    const rotated = await rotateExecutorBootstrapInternal(ctx, {
      executor,
      now,
    });
    bootstrapToken = rotated.bootstrapToken;
  }

  const assignedWorkspaceIds: Id<"workspaces">[] = [];
  for (const workspaceId of args.workspaceIds ?? []) {
    await setWorkspaceExecutorInternalImpl(ctx, {
      workspaceId,
      executorId: executor._id,
    });
    assignedWorkspaceIds.push(workspaceId);
  }

  return {
    executorId: executor._id,
    assignedWorkspaceIds,
    ...(bootstrapToken ? { bootstrapToken } : {}),
  };
}

export async function rotateExecutorBootstrapTokenImpl(ctx: MutationCtx, args: { executorId: Id<"executors"> }) {
  const { executor, user } = await requireExecutorLifecycleManager(ctx, args.executorId);
  const now = Date.now();
  const rotated = await rotateExecutorBootstrapInternal(ctx, {
    executor,
    now,
  });
  const updated = await ctx.db.get(executor._id);
  if (!updated) {
    throw new Error("Executor not found after rotation");
  }
  const updatedInstances = await ctx.db
    .query("executorInstances")
    .withIndex("by_executor", (q) => q.eq("executorId", executor._id))
    .collect();
  return {
    executor: await buildExecutorSummaryForUser(user, updated, updatedInstances, now),
    bootstrapToken: rotated.bootstrapToken,
    setup: buildExecutorSetupPayload(rotated.bootstrapToken, getConvexUrl()),
  };
}

export async function renameExecutorImpl(
  ctx: MutationCtx,
  args: { executorId: Id<"executors">; name: string },
): Promise<{ executor: Awaited<ReturnType<typeof buildExecutorSummaryForUser>> }> {
  const { executor, user } = await requireExecutorLifecycleManager(ctx, args.executorId);
  if (executor.name === LOCAL_DEV_EXECUTOR_NAME && executor.createdBy === LOCAL_DEV_EXECUTOR_CREATED_BY) {
    throw new Error("Local dev executor cannot be renamed");
  }
  const name = normalizeExecutorName(args.name);
  const updatedAt = Date.now();
  await ctx.db.patch(executor._id, {
    name,
    updatedAt,
  });
  const updated = await ctx.db.get(executor._id);
  if (!updated) {
    throw new Error("Executor not found after rename");
  }
  const instances = await ctx.db
    .query("executorInstances")
    .withIndex("by_executor", (q) => q.eq("executorId", executor._id))
    .collect();
  return {
    executor: await buildExecutorSummaryForUser(user, updated, instances, updatedAt),
  };
}

export async function deleteExecutorImpl(
  ctx: MutationCtx,
  args: { executorId: Id<"executors"> },
): Promise<{ deleted: true; clearedWorkspaceCount: number; deletedInstanceCount: number }> {
  await requireExecutorLifecycleManager(ctx, args.executorId);
  const now = Date.now();
  const [workspaces, instances, pendingJobs, runningJobs, pendingCompileJobs, runningCompileJobs] = await Promise.all([
    ctx.db
      .query("workspaces")
      .withIndex("by_executor", (q) => q.eq("executorId", args.executorId))
      .collect(),
    ctx.db
      .query("executorInstances")
      .withIndex("by_executor", (q) => q.eq("executorId", args.executorId))
      .collect(),
    ctx.db
      .query("jobs")
      .withIndex("by_target_executor_status", (q) => q.eq("targetExecutorId", args.executorId).eq("status", "pending"))
      .collect(),
    ctx.db
      .query("jobs")
      .withIndex("by_target_executor_status", (q) => q.eq("targetExecutorId", args.executorId).eq("status", "running"))
      .collect(),
    ctx.db
      .query("compileJobs")
      .withIndex("by_target_executor_status", (q) => q.eq("targetExecutorId", args.executorId).eq("status", "pending"))
      .collect(),
    ctx.db
      .query("compileJobs")
      .withIndex("by_target_executor_status", (q) => q.eq("targetExecutorId", args.executorId).eq("status", "running"))
      .collect(),
  ]);
  const nonterminalCount =
    pendingJobs.length + runningJobs.length + pendingCompileJobs.length + runningCompileJobs.length;
  if (nonterminalCount > 0) {
    throw new Error(
      `Cannot delete executor while it has ${nonterminalCount} pending/running job(s). Wait for them to complete or cancel them first.`,
    );
  }

  await clearSessionExecutorAssignmentsForExecutor(ctx, {
    executorId: args.executorId,
  });

  for (const workspace of workspaces) {
    await ctx.db.patch(workspace._id, {
      executorId: undefined,
      updatedAt: now,
    });
  }
  for (const instance of instances) {
    await ctx.db.delete(instance._id);
  }
  await ctx.db.delete(args.executorId);

  return {
    deleted: true,
    clearedWorkspaceCount: workspaces.length,
    deletedInstanceCount: instances.length,
  };
}

async function getWorkspaceOrThrow(ctx: QueryCtx | MutationCtx, workspaceId: Id<"workspaces">): Promise<WorkspaceDoc> {
  const workspace = await ctx.db.get(workspaceId);
  if (!workspace) {
    throw new Error("Workspace not found");
  }
  return workspace;
}

async function requireExecutorLifecycleManager(
  ctx: QueryCtx | MutationCtx,
  executorId: Id<"executors">,
): Promise<{ executor: ExecutorDoc; user: UserIdentity }> {
  const user = await requireAuthenticatedUser(ctx);
  const executor = await ctx.db.get(executorId);
  if (!executor) {
    throw new Error("Executor not found");
  }
  if (!canManageExecutorLifecycle({ executor, user })) {
    throw new Error("Unauthorized");
  }
  return { executor, user };
}

async function listAllExecutorsWithInstances(ctx: QueryCtx | MutationCtx) {
  const [executors, instances, workspaces] = await Promise.all([
    ctx.db.query("executors").collect(),
    ctx.db.query("executorInstances").collect(),
    ctx.db.query("workspaces").collect(),
  ]);
  return {
    executors: sortExecutorsByName(executors),
    instancesByExecutorId: mapInstancesByExecutorId(instances),
    assignedWorkspacesByExecutorId: mapAssignedWorkspacesByExecutorId(workspaces),
  };
}

async function buildExecutorSummaryForUser(
  user: ExecutorManagerIdentity,
  executor: ExecutorDoc,
  instances: ExecutorInstanceDoc[],
  now: number = Date.now(),
) {
  return buildExecutorSummary(executor, instances, {
    now,
    canManageLifecycle: canManageExecutorLifecycle({ executor, user }),
  });
}

function buildManageableExecutorRecord(args: {
  user: ExecutorManagerIdentity;
  executor: ExecutorDoc;
  instances: ExecutorInstanceDoc[];
  assignedWorkspaces: AssignedWorkspaceRef[];
  now?: number;
}) {
  const now = args.now ?? Date.now();
  return {
    executor: buildExecutorSummary(args.executor, args.instances, {
      now,
      canManageLifecycle: canManageExecutorLifecycle({ executor: args.executor, user: args.user }),
    }),
    instances: args.instances
      .map((instance) => buildExecutorInstanceStatus(instance, now))
      .sort((a, b) => {
        return b.lastHeartbeatAt - a.lastHeartbeatAt;
      }),
    assignedWorkspaces: [...args.assignedWorkspaces].sort((a, b) => a.name.localeCompare(b.name)),
    assignedWorkspaceCount: args.assignedWorkspaces.length,
  };
}

export async function listManageableExecutorsInternalImpl(
  ctx: QueryCtx | MutationCtx,
  args: { user: ExecutorManagerIdentity; now?: number },
) {
  const now = args.now ?? Date.now();
  const { executors, instancesByExecutorId, assignedWorkspacesByExecutorId } = await listAllExecutorsWithInstances(ctx);
  const manageableExecutors = executors.filter((executor) => canManageExecutorLifecycle({ executor, user: args.user }));

  return manageableExecutors.map((executor) =>
    buildManageableExecutorRecord({
      user: args.user,
      executor,
      instances: instancesByExecutorId.get(executor._id) ?? [],
      assignedWorkspaces: assignedWorkspacesByExecutorId.get(executor._id) ?? [],
      now,
    }),
  );
}

export async function createExecutorUnassignedInternalImpl(
  ctx: ExecutorWriteCtx,
  args: { name: string; createdBy: string; now?: number },
) {
  const now = args.now ?? Date.now();
  const created = await createExecutorInternalRecord(ctx, {
    name: args.name,
    createdBy: args.createdBy,
    now,
  });
  const executor = await ctx.db.get(created.executorId);
  if (!executor) {
    throw new Error("Executor not found after creation");
  }

  return {
    executor: buildExecutorSummary(executor, [], {
      now,
      canManageLifecycle: true,
    }),
    bootstrapToken: created.bootstrapToken,
    setup: buildExecutorSetupPayload(created.bootstrapToken, getConvexUrl()),
  };
}

export async function assertWorkspaceAssignedToExecutor(
  ctx: ExecutorCtx,
  args: { workspaceId: Id<"workspaces">; executorId: Id<"executors"> },
): Promise<{ executor: ExecutorDoc; workspace: WorkspaceDoc }> {
  const [workspace, executor] = await Promise.all([
    getWorkspaceDoc(ctx, args.workspaceId),
    getExecutorDoc(ctx, args.executorId),
  ]);
  assertWorkspaceExecutorAssignmentState({
    executor,
    workspace,
    expectedExecutorId: args.executorId,
  });
  return {
    executor: executor!,
    workspace: workspace!,
  };
}

export const listAssignableExecutorsForWorkspace = query({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireWorkspaceAdmin(ctx, args.workspaceId);
    const workspace = await getWorkspaceOrThrow(ctx, args.workspaceId);
    const now = Date.now();
    const { executors, instancesByExecutorId } = await listAllExecutorsWithInstances(ctx);
    const assignableExecutors = executors.filter((executor) => canManageExecutorLifecycle({ executor, user }));

    return {
      workspaceId: workspace._id,
      currentExecutorId: workspace.executorId ?? null,
      executors: await Promise.all(
        assignableExecutors.map(
          async (executor) =>
            await buildExecutorSummaryForUser(user, executor, instancesByExecutorId.get(executor._id) ?? [], now),
        ),
      ),
    };
  },
});

export const listManageableExecutors = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireAuthenticatedUser(ctx);
    return {
      executors: await listManageableExecutorsInternalImpl(ctx, { user }),
    };
  },
});

export const getAssignedExecutorStatus = query({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireWorkspaceMember(ctx, args.workspaceId);
    const workspace = await getWorkspaceOrThrow(ctx, args.workspaceId);
    if (!workspace.executorId) {
      return null;
    }

    const executor = await ctx.db.get(workspace.executorId);
    if (!executor) {
      return null;
    }

    const instances = await ctx.db
      .query("executorInstances")
      .withIndex("by_executor", (q) => q.eq("executorId", executor._id))
      .collect();
    const now = Date.now();

    return {
      workspaceId: workspace._id,
      currentExecutorId: executor._id,
      executor: await buildExecutorSummaryForUser(user, executor, instances, now),
      instances: instances
        .map((instance) => buildExecutorInstanceStatus(instance, now))
        .sort((a, b) => b.lastHeartbeatAt - a.lastHeartbeatAt),
    };
  },
});

export const createExecutor = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    name: v.string(),
    failPendingJobs: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireWorkspaceAdmin(ctx, args.workspaceId);
    await getWorkspaceOrThrow(ctx, args.workspaceId);

    const name = normalizeExecutorName(args.name);
    const now = Date.now();
    const bootstrap = await createOpaqueToken();
    const executorId = await ctx.db.insert("executors", {
      name,
      status: "active",
      authMode: "opaque_secret",
      tokenVersion: 1,
      bootstrapTokenId: bootstrap.tokenId,
      bootstrapTokenHash: bootstrap.tokenHash,
      bootstrapIssuedAt: now,
      createdBy: user.subject,
      createdAt: now,
      updatedAt: now,
    });

    await setWorkspaceExecutorInternalImpl(ctx, {
      workspaceId: args.workspaceId,
      executorId,
      failPendingJobs: args.failPendingJobs,
    });
    const executor = await ctx.db.get(executorId);
    if (!executor) {
      throw new Error("Executor not found after creation");
    }

    return {
      executor: await buildExecutorSummaryForUser(user, executor, [], now),
      bootstrapToken: bootstrap.token,
      setup: buildExecutorSetupPayload(bootstrap.token, getConvexUrl()),
    };
  },
});

export const createExecutorUnassigned = mutation({
  args: {
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireAuthenticatedUser(ctx);
    return await createExecutorUnassignedInternalImpl(ctx, {
      name: args.name,
      createdBy: user.subject,
    });
  },
});

export const createExecutorForWorkspaceTest = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    name: v.optional(v.string()),
    createdBy: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const bootstrap = await createOpaqueToken();
    const name = normalizeExecutorName(args.name ?? "Test Executor");
    const executorId = await ctx.db.insert("executors", {
      name,
      status: "active",
      authMode: "opaque_secret",
      tokenVersion: 1,
      bootstrapTokenId: bootstrap.tokenId,
      bootstrapTokenHash: bootstrap.tokenHash,
      bootstrapIssuedAt: now,
      createdBy: args.createdBy ?? "integration-test",
      createdAt: now,
      updatedAt: now,
    });

    await ctx.runMutation(internal.executors.setWorkspaceExecutorInternal, {
      workspaceId: args.workspaceId,
      executorId,
    });

    return {
      workspaceId: args.workspaceId,
      executorId,
      bootstrapToken: bootstrap.token,
      setup: buildExecutorSetupPayload(bootstrap.token, getConvexUrl()),
    };
  },
});

export const ensureLocalDevExecutorInternal = internalMutation({
  args: {
    workspaceIds: v.optional(v.array(v.id("workspaces"))),
    rotateBootstrap: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    return await ensureLocalDevExecutorInternalImpl(ctx, args);
  },
});

export const assignWorkspaceExecutor = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    executorId: v.optional(v.id("executors")),
    failPendingJobs: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireWorkspaceAdmin(ctx, args.workspaceId);
    await getWorkspaceOrThrow(ctx, args.workspaceId);
    if (args.executorId) {
      const executor = await ctx.db.get(args.executorId);
      if (!executor) {
        throw new Error("Executor not found");
      }
      if (!canManageExecutorLifecycle({ executor, user })) {
        throw new Error("Unauthorized");
      }
    }
    await ctx.runMutation(internal.executors.setWorkspaceExecutorInternal, args);
    return {
      workspaceId: args.workspaceId,
      executorId: args.executorId ?? null,
    };
  },
});

export const renameExecutor = mutation({
  args: {
    executorId: v.id("executors"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    return await renameExecutorImpl(ctx, args);
  },
});

export const rotateExecutorBootstrapToken = mutation({
  args: {
    executorId: v.id("executors"),
  },
  handler: async (ctx, args) => {
    return await rotateExecutorBootstrapTokenImpl(ctx, args);
  },
});

export const setExecutorStatus = mutation({
  args: {
    executorId: v.id("executors"),
    status: v.union(v.literal("active"), v.literal("disabled")),
  },
  handler: async (ctx, args) => {
    const { executor, user } = await requireExecutorLifecycleManager(ctx, args.executorId);
    const updatedAt = Date.now();
    await ctx.db.patch(executor._id, {
      status: args.status,
      updatedAt,
    });
    const updated = await ctx.db.get(executor._id);
    if (!updated) {
      throw new Error("Executor not found after status update");
    }
    const instances = await ctx.db
      .query("executorInstances")
      .withIndex("by_executor", (q) => q.eq("executorId", executor._id))
      .collect();
    if (args.status === "disabled") {
      for (const instance of instances) {
        if (instance.status === "online") {
          await ctx.db.patch(instance._id, { status: "offline", expiresAt: updatedAt });
        }
      }
    }
    const updatedInstances =
      args.status === "disabled"
        ? await ctx.db
            .query("executorInstances")
            .withIndex("by_executor", (q) => q.eq("executorId", executor._id))
            .collect()
        : instances;
    return {
      executor: await buildExecutorSummaryForUser(user, updated, updatedInstances, updatedAt),
    };
  },
});

export const deleteExecutor = mutation({
  args: {
    executorId: v.id("executors"),
  },
  handler: async (ctx, args) => {
    return await deleteExecutorImpl(ctx, args);
  },
});

export const cleanupStaleExecutorInstancesInternal = internalMutation({
  args: {
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await cleanupStaleExecutorInstancesInternalImpl(ctx, args);
  },
});

export const registerExecutorInstance = mutation({
  args: {
    bootstrapToken: v.string(),
    hostname: v.optional(v.string()),
    version: v.optional(v.string()),
    maxConcurrentRuntimeJobs: v.optional(v.number()),
    maxConcurrentCompileJobs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const { executor } = await verifyExecutorBootstrapToken(ctx, args.bootstrapToken);
    const instanceToken = await createOpaqueToken();
    const instanceTokenExpiresAt = now + EXECUTOR_INSTANCE_TOKEN_TTL_MS;
    const instanceId = await ctx.db.insert("executorInstances", {
      executorId: executor._id,
      tokenVersion: executor.tokenVersion,
      status: "online",
      registeredAt: now,
      lastHeartbeatAt: now,
      expiresAt: now + EXECUTOR_HEARTBEAT_TIMEOUT_MS,
      instanceTokenId: instanceToken.tokenId,
      instanceTokenHash: instanceToken.tokenHash,
      instanceTokenIssuedAt: now,
      instanceTokenExpiresAt,
      hostname: args.hostname?.trim() || undefined,
      version: args.version?.trim() || undefined,
      maxConcurrentRuntimeJobs: args.maxConcurrentRuntimeJobs,
      maxConcurrentCompileJobs: args.maxConcurrentCompileJobs,
    });

    await ctx.db.patch(executor._id, {
      bootstrapLastUsedAt: now,
    });

    return {
      executorId: executor._id,
      instanceId,
      instanceToken: instanceToken.token,
      instanceTokenExpiresAt,
      heartbeatIntervalMs: EXECUTOR_HEARTBEAT_INTERVAL_MS,
      heartbeatTimeoutMs: EXECUTOR_HEARTBEAT_TIMEOUT_MS,
    };
  },
});

export const heartbeatExecutorInstance = mutation({
  args: {
    instanceToken: v.string(),
    hostname: v.optional(v.string()),
    version: v.optional(v.string()),
    maxConcurrentRuntimeJobs: v.optional(v.number()),
    maxConcurrentCompileJobs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const { executor, instance } = await verifyExecutorInstanceToken(ctx, args.instanceToken, now);
    const patch: Partial<Doc<"executorInstances">> = {
      lastHeartbeatAt: now,
      expiresAt: now + EXECUTOR_HEARTBEAT_TIMEOUT_MS,
    };

    if (args.hostname !== undefined) {
      patch.hostname = args.hostname.trim() || undefined;
    }
    if (args.version !== undefined) {
      patch.version = args.version.trim() || undefined;
    }
    if (args.maxConcurrentRuntimeJobs !== undefined) {
      patch.maxConcurrentRuntimeJobs = args.maxConcurrentRuntimeJobs;
    }
    if (args.maxConcurrentCompileJobs !== undefined) {
      patch.maxConcurrentCompileJobs = args.maxConcurrentCompileJobs;
    }

    let rotatedInstanceToken: string | undefined;
    let instanceTokenExpiresAt = instance.instanceTokenExpiresAt;
    if (shouldRotateInstanceToken(instance.instanceTokenExpiresAt, now)) {
      const nextToken = await createOpaqueToken();
      rotatedInstanceToken = nextToken.token;
      instanceTokenExpiresAt = now + EXECUTOR_INSTANCE_TOKEN_TTL_MS;
      patch.prevInstanceTokenId = instance.instanceTokenId;
      patch.prevInstanceTokenHash = instance.instanceTokenHash;
      patch.prevInstanceTokenExpiresAt = instance.instanceTokenExpiresAt;
      patch.instanceTokenId = nextToken.tokenId;
      patch.instanceTokenHash = nextToken.tokenHash;
      patch.instanceTokenIssuedAt = now;
      patch.instanceTokenExpiresAt = instanceTokenExpiresAt;
    }

    await ctx.db.patch(instance._id, patch);

    return {
      executorId: executor._id,
      instanceId: instance._id,
      instanceToken: rotatedInstanceToken,
      instanceTokenExpiresAt,
      lastHeartbeatAt: now,
      expiresAt: now + EXECUTOR_HEARTBEAT_TIMEOUT_MS,
      heartbeatIntervalMs: EXECUTOR_HEARTBEAT_INTERVAL_MS,
      heartbeatTimeoutMs: EXECUTOR_HEARTBEAT_TIMEOUT_MS,
    };
  },
});

export const getExecutorInternal = internalQuery({
  args: {
    executorId: v.id("executors"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.executorId);
  },
});

export const listExecutorInstancesInternal = internalQuery({
  args: {
    executorId: v.id("executors"),
  },
  handler: async (ctx, args) => {
    const instances = await ctx.db
      .query("executorInstances")
      .withIndex("by_executor", (q) => q.eq("executorId", args.executorId))
      .collect();

    return instances.sort((a, b) => b.lastHeartbeatAt - a.lastHeartbeatAt);
  },
});

export const listEligibleExecutorInstancesInternal = internalQuery({
  args: {
    executorId: v.id("executors"),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const instances = await ctx.db
      .query("executorInstances")
      .withIndex("by_executor_status_expires_at", (q) =>
        q.eq("executorId", args.executorId).eq("status", "online").gte("expiresAt", now),
      )
      .collect();

    return instances;
  },
});

async function listNonterminalJobsForWorkspaceExecutor(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  currentExecutorId: Id<"executors"> | undefined,
): Promise<{
  pendingJobs: Doc<"jobs">[];
  pendingCompileJobs: Doc<"compileJobs">[];
  runningJobs: Doc<"jobs">[];
  runningCompileJobs: Doc<"compileJobs">[];
}> {
  if (!currentExecutorId) {
    return {
      pendingJobs: [],
      pendingCompileJobs: [],
      runningJobs: [],
      runningCompileJobs: [],
    };
  }
  const [pendingJobs, pendingCompileJobs, runningJobs, runningCompileJobs] = await Promise.all([
    ctx.db
      .query("jobs")
      .withIndex("by_workspace_target_executor_status", (q) =>
        q.eq("workspaceId", workspaceId).eq("targetExecutorId", currentExecutorId).eq("status", "pending"),
      )
      .collect(),
    ctx.db
      .query("compileJobs")
      .withIndex("by_workspace_target_executor_status", (q) =>
        q.eq("workspaceId", workspaceId).eq("targetExecutorId", currentExecutorId).eq("status", "pending"),
      )
      .collect(),
    ctx.db
      .query("jobs")
      .withIndex("by_workspace_target_executor_status", (q) =>
        q.eq("workspaceId", workspaceId).eq("targetExecutorId", currentExecutorId).eq("status", "running"),
      )
      .collect(),
    ctx.db
      .query("compileJobs")
      .withIndex("by_workspace_target_executor_status", (q) =>
        q.eq("workspaceId", workspaceId).eq("targetExecutorId", currentExecutorId).eq("status", "running"),
      )
      .collect(),
  ]);

  return {
    pendingJobs,
    pendingCompileJobs,
    runningJobs,
    runningCompileJobs,
  };
}

function formatExecutorJobSummary(args: { runtimeCount: number; compileCount: number }): string | null {
  const parts: string[] = [];
  if (args.runtimeCount > 0) {
    parts.push(`${args.runtimeCount} runtime job(s)`);
  }
  if (args.compileCount > 0) {
    parts.push(`${args.compileCount} compile job(s)`);
  }
  if (parts.length === 0) {
    return null;
  }
  const [first, second] = parts;
  if (parts.length === 1) {
    return first ?? null;
  }
  return first && second ? `${first} and ${second}` : (first ?? null);
}

async function failPendingJobsForWorkspaceExecutor(
  ctx: MutationCtx,
  args: {
    pendingJobs: Doc<"jobs">[];
    pendingCompileJobs: Doc<"compileJobs">[];
  },
): Promise<void> {
  const completedAt = Date.now();
  const runtimeError = {
    message: "Job failed because the workspace executor was reassigned before execution started.",
    data: {
      errorType: "EXECUTOR_REASSIGNED",
    },
  };
  const compileError = {
    message: "Compile job failed because the workspace executor was reassigned before execution started.",
    data: {
      errorType: "EXECUTOR_REASSIGNED",
    },
  };

  for (const job of args.pendingJobs) {
    await ctx.db.patch(job._id, {
      status: "failed",
      completedAt,
      error: runtimeError,
    });
    if (job.threadId && job.toolCallId) {
      try {
        await ctx.runMutation(internal.ai.chat.addToolError, {
          threadId: job.threadId,
          toolCallId: job.toolCallId,
          error: `Code execution failed:\n${runtimeError.message}`,
        });
      } catch (error) {
        console.warn(`[executors] failed to add tool error for reassigned job ${job._id}: ${String(error)}`);
      }
    }
  }

  for (const job of args.pendingCompileJobs) {
    await ctx.db.patch(job._id, {
      status: "failed",
      completedAt,
      error: compileError,
    });
  }
}

async function assertWorkspaceExecutorAssignmentCanChange(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    currentExecutorId: Id<"executors"> | undefined;
    failPendingJobs: boolean;
  },
): Promise<void> {
  const nonterminal = await listNonterminalJobsForWorkspaceExecutor(ctx, args.workspaceId, args.currentExecutorId);
  const runningSummary = formatExecutorJobSummary({
    runtimeCount: nonterminal.runningJobs.length,
    compileCount: nonterminal.runningCompileJobs.length,
  });
  if (runningSummary) {
    throw new Error(
      `Cannot change executor assignment while workspace has running ${runningSummary} on the current executor`,
    );
  }

  const pendingSummary = formatExecutorJobSummary({
    runtimeCount: nonterminal.pendingJobs.length,
    compileCount: nonterminal.pendingCompileJobs.length,
  });
  if (!pendingSummary) {
    return;
  }
  if (!args.failPendingJobs) {
    throw new Error(
      `Cannot change executor assignment while workspace has pending ${pendingSummary} on the current executor unless pending jobs are explicitly failed`,
    );
  }

  await failPendingJobsForWorkspaceExecutor(ctx, nonterminal);
}

export const setWorkspaceExecutorInternal = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    executorId: v.optional(v.id("executors")),
    failPendingJobs: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await setWorkspaceExecutorInternalImpl(ctx, {
      workspaceId: args.workspaceId,
      executorId: args.executorId,
      failPendingJobs: args.failPendingJobs,
    });
  },
});
