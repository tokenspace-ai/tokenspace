import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type ActionCtx, internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";

type ExecutorCtx = QueryCtx | MutationCtx | ActionCtx;
type ExecutorDoc = Doc<"executors">;
type WorkspaceDoc = Doc<"workspaces">;
type ExecutorInstanceDoc = Doc<"executorInstances">;

export function isExecutorInstanceHealthy(
  instance: Pick<ExecutorInstanceDoc, "status" | "expiresAt">,
  now: number = Date.now(),
): boolean {
  return instance.status === "online" && instance.expiresAt >= now;
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
