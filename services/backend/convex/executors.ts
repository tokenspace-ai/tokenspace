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

type ExecutorCtx = QueryCtx | MutationCtx | ActionCtx;
type ExecutorDoc = Doc<"executors">;
type WorkspaceDoc = Doc<"workspaces">;
type ExecutorInstanceDoc = Doc<"executorInstances">;

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
  const [executors, instances] = await Promise.all([
    ctx.db.query("executors").collect(),
    ctx.db.query("executorInstances").collect(),
  ]);
  return {
    executors: sortExecutorsByName(executors),
    instancesByExecutorId: mapInstancesByExecutorId(instances),
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

    return {
      workspaceId: workspace._id,
      currentExecutorId: workspace.executorId ?? null,
      executors: await Promise.all(
        executors.map(
          async (executor) =>
            await buildExecutorSummaryForUser(user, executor, instancesByExecutorId.get(executor._id) ?? [], now),
        ),
      ),
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

    await ctx.db.patch(args.workspaceId, {
      executorId,
      updatedAt: now,
    });

    const executor = await ctx.db.get(executorId);
    if (!executor) {
      throw new Error("Executor not found after creation");
    }

    return {
      executor: await buildExecutorSummaryForUser(user, executor, [], now),
      bootstrapToken: bootstrap.token,
      setup: buildExecutorSetupPayload(bootstrap.token),
    };
  },
});

export const assignWorkspaceExecutor = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    executorId: v.optional(v.id("executors")),
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
    const { executor, user } = await requireExecutorLifecycleManager(ctx, args.executorId);
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
  },
});

export const rotateExecutorBootstrapToken = mutation({
  args: {
    executorId: v.id("executors"),
  },
  handler: async (ctx, args) => {
    const { executor, user } = await requireExecutorLifecycleManager(ctx, args.executorId);
    const now = Date.now();
    const bootstrap = await createOpaqueToken();
    await ctx.db.patch(executor._id, {
      bootstrapTokenId: bootstrap.tokenId,
      bootstrapTokenHash: bootstrap.tokenHash,
      bootstrapIssuedAt: now,
      bootstrapLastUsedAt: undefined,
      tokenVersion: executor.tokenVersion + 1,
      updatedAt: now,
    });
    const updated = await ctx.db.get(executor._id);
    if (!updated) {
      throw new Error("Executor not found after rotation");
    }
    const instances = await ctx.db
      .query("executorInstances")
      .withIndex("by_executor", (q) => q.eq("executorId", executor._id))
      .collect();
    for (const instance of instances) {
      if (instance.status === "online") {
        await ctx.db.patch(instance._id, { status: "offline", expiresAt: now });
      }
    }
    return {
      executor: await buildExecutorSummaryForUser(user, updated, instances, now),
      bootstrapToken: bootstrap.token,
      setup: buildExecutorSetupPayload(bootstrap.token),
    };
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
    return {
      executor: await buildExecutorSummaryForUser(user, updated, instances, updatedAt),
    };
  },
});

export const deleteExecutor = mutation({
  args: {
    executorId: v.id("executors"),
  },
  handler: async (ctx, args) => {
    await requireExecutorLifecycleManager(ctx, args.executorId);
    const now = Date.now();
    const [workspaces, instances] = await Promise.all([
      ctx.db
        .query("workspaces")
        .withIndex("by_executor", (q) => q.eq("executorId", args.executorId))
        .collect(),
      ctx.db
        .query("executorInstances")
        .withIndex("by_executor", (q) => q.eq("executorId", args.executorId))
        .collect(),
    ]);

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

export const setWorkspaceExecutorInternal = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    executorId: v.optional(v.id("executors")),
  },
  handler: async (ctx, args) => {
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

    await ctx.db.patch(args.workspaceId, {
      executorId: args.executorId,
      updatedAt: Date.now(),
    });
  },
});
