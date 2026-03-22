import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from "./_generated/server";
import { verifyExecutorInstanceToken } from "./executorAuth";
import {
  requireExecutorQueueAccess,
  resolveEffectiveAssignedInstanceId,
  scheduleJobToExecutorInstance,
} from "./executorRouting";
import { assertWorkspaceAssignedToExecutor } from "./executors";

const MIN_LEASE_MS = 1_000;
const MAX_LEASE_MS = 10 * 60_000;
const RUNNABLE_SCAN_LIMIT = 200;

type BuildManifestSummary = {
  schemaVersion: number;
  compilerVersion: string;
  sourceFingerprint: string;
  mode: "local" | "server";
  artifacts: {
    revisionFs: { hash: string; size: number };
    bundle: { hash: string; size: number };
    metadata: { hash: string; size: number };
    diagnostics: { hash: string; size: number };
    deps?: { hash: string; size: number };
  };
};

type PrepareResult =
  | { kind: "existing"; revisionId: Id<"revisions"> }
  | {
      kind: "upload";
      commitId: Id<"commits">;
      artifactFingerprint: string;
      upload: {
        revisionFs: { kind: "existing"; blobId: Id<"blobs"> } | { kind: "upload"; uploadUrl: string };
        bundle: { kind: "existing"; blobId: Id<"blobs"> } | { kind: "upload"; uploadUrl: string };
        metadata: { kind: "existing"; blobId: Id<"blobs"> } | { kind: "upload"; uploadUrl: string };
        diagnostics: { kind: "existing"; blobId: Id<"blobs"> } | { kind: "upload"; uploadUrl: string };
        deps?: { kind: "existing"; blobId: Id<"blobs"> } | { kind: "upload"; uploadUrl: string };
      };
    };

type CommitResult = { revisionId: Id<"revisions">; created: boolean };

const vBuildArtifact = v.object({
  hash: v.string(),
  size: v.number(),
});

const vBuildManifestSummary = v.object({
  schemaVersion: v.number(),
  compilerVersion: v.string(),
  sourceFingerprint: v.string(),
  mode: v.union(v.literal("local"), v.literal("server")),
  artifacts: v.object({
    revisionFs: vBuildArtifact,
    bundle: vBuildArtifact,
    metadata: vBuildArtifact,
    diagnostics: vBuildArtifact,
    deps: v.optional(vBuildArtifact),
  }),
});

const vArtifactReference = v.union(
  v.object({
    blobId: v.id("blobs"),
    hash: v.string(),
    size: v.number(),
  }),
  v.object({
    storageId: v.id("_storage"),
    hash: v.string(),
    size: v.number(),
  }),
);

const vUploadInstruction = v.union(
  v.object({ kind: v.literal("existing"), blobId: v.id("blobs") }),
  v.object({ kind: v.literal("upload"), uploadUrl: v.string() }),
);

async function requireExecutorAccessToCompileJob(
  ctx: QueryCtx | MutationCtx,
  args: { instanceToken: string; job: Doc<"compileJobs">; now?: number },
) {
  return await requireExecutorQueueAccess(ctx, {
    instanceToken: args.instanceToken,
    workspaceId: args.job.workspaceId,
    targetExecutorId: args.job.targetExecutorId,
    assignedInstanceId: args.job.assignedInstanceId,
    queueKind: "compile",
    now: args.now,
  });
}

function clampLeaseMs(leaseMs: number): number {
  return Math.max(MIN_LEASE_MS, Math.min(leaseMs, MAX_LEASE_MS));
}

async function assertBranchHeadUnchanged(
  ctx: any,
  args: {
    branchId: Id<"branches">;
    expectedCommitId: Id<"commits">;
  },
): Promise<void> {
  const branch = await ctx.runQuery(internal.vcs.getBranchInternal, {
    branchId: args.branchId,
  });
  if (!branch) {
    throw new Error("Branch not found");
  }
  if (branch.commitId !== args.expectedCommitId) {
    throw new Error("Branch head changed after compile snapshot was created");
  }
}

function assertRunningOwnedJob(
  job: {
    status: "pending" | "running" | "completed" | "failed" | "canceled";
    workerId?: string;
    leaseExpiresAt?: number;
  },
  workerId: string,
): void {
  if (job.status !== "running") {
    throw new Error("Compile job must be running");
  }
  if (job.workerId !== workerId) {
    throw new Error("Compile job is not owned by this worker");
  }
  if (job.leaseExpiresAt != null && job.leaseExpiresAt < Date.now()) {
    throw new Error("Compile job lease expired");
  }
}

export const createCompileJob = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    sourceKind: v.union(v.literal("branch"), v.literal("branchState")),
    branchId: v.id("branches"),
    branchStateId: v.optional(v.id("branchStates")),
    commitId: v.id("commits"),
    workingStateHash: v.optional(v.string()),
    userId: v.optional(v.string()),
    snapshotStorageId: v.id("_storage"),
  },
  returns: v.id("compileJobs"),
  handler: async (ctx, args) => {
    const now = Date.now();
    const scheduled = await scheduleJobToExecutorInstance(ctx, {
      workspaceId: args.workspaceId,
      queueKind: "compile",
      now,
    });
    return await ctx.db.insert("compileJobs", {
      workspaceId: args.workspaceId,
      sourceKind: args.sourceKind,
      branchId: args.branchId,
      branchStateId: args.branchStateId,
      commitId: args.commitId,
      workingStateHash: args.workingStateHash,
      userId: args.userId,
      snapshotStorageId: args.snapshotStorageId,
      targetExecutorId: scheduled.targetExecutorId,
      assignedInstanceId: scheduled.kind === "assigned" ? scheduled.assignedInstanceId : undefined,
      assignmentUpdatedAt: scheduled.assignmentUpdatedAt,
      status: scheduled.kind === "assigned" ? "pending" : "failed",
      error: scheduled.kind === "unavailable" ? scheduled.error : undefined,
      completedAt: scheduled.kind === "unavailable" ? now : undefined,
      createdAt: now,
    });
  },
});

export const getCompileJob = internalQuery({
  args: {
    compileJobId: v.id("compileJobs"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.compileJobId);
  },
});

export const runnableCompileJobs = query({
  args: {
    instanceToken: v.string(),
  },
  returns: v.array(v.id("compileJobs")),
  handler: async (ctx, args) => {
    const now = Date.now();
    const verified = await verifyExecutorInstanceToken(ctx, args.instanceToken, now);
    const [assignedPending, assignedRunning, executorPending, executorRunning] = await Promise.all([
      ctx.db
        .query("compileJobs")
        .withIndex("by_assigned_instance_status", (q) =>
          q.eq("assignedInstanceId", verified.instanceId).eq("status", "pending"),
        )
        .take(RUNNABLE_SCAN_LIMIT),
      ctx.db
        .query("compileJobs")
        .withIndex("by_assigned_instance_status", (q) =>
          q.eq("assignedInstanceId", verified.instanceId).eq("status", "running"),
        )
        .take(RUNNABLE_SCAN_LIMIT),
      ctx.db
        .query("compileJobs")
        .withIndex("by_target_executor_status", (q) =>
          q.eq("targetExecutorId", verified.executorId).eq("status", "pending"),
        )
        .take(RUNNABLE_SCAN_LIMIT),
      ctx.db
        .query("compileJobs")
        .withIndex("by_target_executor_status", (q) =>
          q.eq("targetExecutorId", verified.executorId).eq("status", "running"),
        )
        .take(RUNNABLE_SCAN_LIMIT),
    ]);

    const runnable = new Map<string, Id<"compileJobs">>();
    for (const job of assignedPending) {
      try {
        await requireExecutorAccessToCompileJob(ctx, { instanceToken: args.instanceToken, job, now });
        runnable.set(String(job._id), job._id);
      } catch {}
    }
    for (const job of assignedRunning) {
      if (job.leaseExpiresAt != null && job.leaseExpiresAt >= now) {
        continue;
      }
      try {
        await requireExecutorAccessToCompileJob(ctx, { instanceToken: args.instanceToken, job, now });
        runnable.set(String(job._id), job._id);
      } catch {}
    }
    for (const job of [...executorPending, ...executorRunning]) {
      const effective = await resolveEffectiveAssignedInstanceId(ctx, {
        workspaceId: job.workspaceId,
        targetExecutorId: job.targetExecutorId,
        assignedInstanceId: job.assignedInstanceId,
        queueKind: "compile",
        now,
      }).catch(() => null);
      if (effective !== verified.instanceId) {
        continue;
      }
      if (job.status === "running" && job.leaseExpiresAt != null && job.leaseExpiresAt >= now) {
        continue;
      }
      runnable.set(String(job._id), job._id);
    }

    return Array.from(runnable.values());
  },
});

export const claimCompileJob = mutation({
  args: {
    compileJobId: v.id("compileJobs"),
    workerId: v.string(),
    leaseMs: v.number(),
    instanceToken: v.string(),
  },
  returns: v.object({
    _id: v.id("compileJobs"),
    status: v.union(v.literal("running"), v.literal("completed"), v.literal("failed"), v.literal("canceled")),
    workspaceId: v.id("workspaces"),
    branchId: v.id("branches"),
    commitId: v.id("commits"),
    workingStateHash: v.optional(v.string()),
    userId: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const verified = await verifyExecutorInstanceToken(ctx, args.instanceToken, now);
    const job = await ctx.db.get(args.compileJobId);
    if (!job) {
      throw new Error("Compile job not found");
    }
    if (!job.targetExecutorId) {
      throw new Error("Compile job is missing executor assignment");
    }
    if (job.targetExecutorId !== verified.executorId) {
      throw new Error("Compile job is assigned to a different executor");
    }
    if (job.status === "completed" || job.status === "failed" || job.status === "canceled") {
      return {
        _id: job._id,
        status: job.status,
        workspaceId: job.workspaceId,
        branchId: job.branchId,
        commitId: job.commitId,
        workingStateHash: job.workingStateHash,
        userId: job.userId,
      };
    }

    const effectiveAssignedInstanceId = await resolveEffectiveAssignedInstanceId(ctx, {
      workspaceId: job.workspaceId,
      targetExecutorId: job.targetExecutorId,
      assignedInstanceId: job.assignedInstanceId,
      queueKind: "compile",
      now,
    });
    if (!effectiveAssignedInstanceId) {
      throw new Error("No healthy executor instance is available for this compile job");
    }
    if (effectiveAssignedInstanceId !== verified.instanceId) {
      throw new Error("Compile job is assigned to a different executor instance");
    }
    if (job.assignedInstanceId !== effectiveAssignedInstanceId) {
      await ctx.db.patch(job._id, {
        assignedInstanceId: effectiveAssignedInstanceId,
        assignmentUpdatedAt: now,
      });
    }

    const leaseMs = clampLeaseMs(args.leaseMs);
    const leaseExpiresAt = now + leaseMs;

    if (job.status === "pending") {
      await ctx.db.patch(job._id, {
        status: "running",
        startedAt: now,
        workerId: args.workerId,
        heartbeatAt: now,
        leaseExpiresAt,
      });
    } else if (job.status === "running") {
      const expired = job.leaseExpiresAt == null ? true : job.leaseExpiresAt < now;
      if (job.workerId === args.workerId || expired) {
        await ctx.db.patch(job._id, {
          workerId: args.workerId,
          heartbeatAt: now,
          leaseExpiresAt,
        });
      } else {
        throw new Error("Compile job already claimed");
      }
    }

    const updated = await ctx.db.get(job._id);
    if (!updated) {
      throw new Error("Compile job disappeared");
    }

    return {
      _id: updated._id,
      status: updated.status === "pending" ? "running" : updated.status,
      workspaceId: updated.workspaceId,
      branchId: updated.branchId,
      commitId: updated.commitId,
      workingStateHash: updated.workingStateHash,
      userId: updated.userId,
    };
  },
});

export const heartbeatCompileJob = mutation({
  args: {
    compileJobId: v.id("compileJobs"),
    workerId: v.string(),
    leaseMs: v.number(),
    instanceToken: v.string(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.compileJobId);
    if (!job) {
      throw new Error("Compile job not found");
    }
    await requireExecutorAccessToCompileJob(ctx, {
      instanceToken: args.instanceToken,
      job,
    });
    if (job.status !== "running") {
      throw new Error("Compile job is not running");
    }
    if (job.workerId !== args.workerId) {
      throw new Error("Compile job is not owned by this worker");
    }

    const now = Date.now();
    const leaseExpiresAt = now + clampLeaseMs(args.leaseMs);
    await ctx.db.patch(job._id, { heartbeatAt: now, leaseExpiresAt });
    return { heartbeatAt: now, leaseExpiresAt };
  },
});

export const getCompileJobSnapshot = query({
  args: {
    compileJobId: v.id("compileJobs"),
    instanceToken: v.string(),
  },
  returns: v.object({
    workspaceId: v.id("workspaces"),
    branchId: v.id("branches"),
    commitId: v.id("commits"),
    workingStateHash: v.optional(v.string()),
    userId: v.optional(v.string()),
    snapshotUrl: v.string(),
  }),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.compileJobId);
    if (!job) {
      throw new Error("Compile job not found");
    }
    await requireExecutorAccessToCompileJob(ctx, {
      instanceToken: args.instanceToken,
      job,
    });
    const snapshotUrl = await ctx.storage.getUrl(job.snapshotStorageId);
    if (!snapshotUrl) {
      throw new Error("Compile snapshot storage URL unavailable");
    }
    return {
      workspaceId: job.workspaceId,
      branchId: job.branchId,
      commitId: job.commitId,
      workingStateHash: job.workingStateHash,
      userId: job.userId,
      snapshotUrl,
    };
  },
});

export const prepareRevisionFromBuildForExecutor = action({
  args: {
    compileJobId: v.id("compileJobs"),
    workerId: v.string(),
    manifest: vBuildManifestSummary,
    instanceToken: v.string(),
  },
  returns: v.union(
    v.object({
      kind: v.literal("existing"),
      revisionId: v.id("revisions"),
    }),
    v.object({
      kind: v.literal("upload"),
      commitId: v.id("commits"),
      artifactFingerprint: v.string(),
      upload: v.object({
        revisionFs: vUploadInstruction,
        bundle: vUploadInstruction,
        metadata: vUploadInstruction,
        diagnostics: vUploadInstruction,
        deps: v.optional(vUploadInstruction),
      }),
    }),
  ),
  handler: async (ctx, args): Promise<PrepareResult> => {
    const job = await ctx.runQuery(internal.compileJobs.getCompileJob, {
      compileJobId: args.compileJobId,
    });
    if (!job) {
      throw new Error("Compile job not found");
    }
    const verified = await verifyExecutorInstanceToken(ctx, args.instanceToken);
    if (!job.targetExecutorId || !job.assignedInstanceId) {
      throw new Error("Compile job is missing executor assignment");
    }
    if (verified.executorId !== job.targetExecutorId || verified.instanceId !== job.assignedInstanceId) {
      throw new Error("Compile job is assigned to a different executor instance");
    }
    await assertWorkspaceAssignedToExecutor(ctx, {
      workspaceId: job.workspaceId,
      executorId: job.targetExecutorId,
    });
    assertRunningOwnedJob(job, args.workerId);

    await assertBranchHeadUnchanged(ctx, {
      branchId: job.branchId,
      expectedCommitId: job.commitId,
    });

    return await ctx.runAction(internal.revisionBuild.prepareRevisionFromBuildInternal, {
      workspaceId: job.workspaceId,
      branchId: job.branchId,
      branchStateId: job.branchStateId,
      workingStateHash: job.workingStateHash,
      manifest: args.manifest as BuildManifestSummary,
    });
  },
});

export const commitRevisionFromBuildForExecutor = action({
  args: {
    compileJobId: v.id("compileJobs"),
    workerId: v.string(),
    artifactFingerprint: v.string(),
    manifest: vBuildManifestSummary,
    artifacts: v.object({
      revisionFs: vArtifactReference,
      bundle: vArtifactReference,
      metadata: vArtifactReference,
      diagnostics: vArtifactReference,
      deps: v.optional(vArtifactReference),
    }),
    instanceToken: v.string(),
  },
  returns: v.object({
    revisionId: v.id("revisions"),
    created: v.boolean(),
  }),
  handler: async (ctx, args): Promise<CommitResult> => {
    const job = await ctx.runQuery(internal.compileJobs.getCompileJob, {
      compileJobId: args.compileJobId,
    });
    if (!job) {
      throw new Error("Compile job not found");
    }
    const verified = await verifyExecutorInstanceToken(ctx, args.instanceToken);
    if (!job.targetExecutorId || !job.assignedInstanceId) {
      throw new Error("Compile job is missing executor assignment");
    }
    if (verified.executorId !== job.targetExecutorId || verified.instanceId !== job.assignedInstanceId) {
      throw new Error("Compile job is assigned to a different executor instance");
    }
    await assertWorkspaceAssignedToExecutor(ctx, {
      workspaceId: job.workspaceId,
      executorId: job.targetExecutorId,
    });
    assertRunningOwnedJob(job, args.workerId);

    await assertBranchHeadUnchanged(ctx, {
      branchId: job.branchId,
      expectedCommitId: job.commitId,
    });

    return await ctx.runAction(internal.revisionBuild.commitRevisionFromBuildInternal, {
      workspaceId: job.workspaceId,
      branchId: job.branchId,
      branchStateId: job.branchStateId,
      commitId: job.commitId,
      workingStateHash: job.workingStateHash,
      artifactFingerprint: args.artifactFingerprint,
      manifest: args.manifest as BuildManifestSummary,
      artifacts: args.artifacts,
    });
  },
});

export const completeCompileJob = mutation({
  args: {
    compileJobId: v.id("compileJobs"),
    revisionId: v.id("revisions"),
    workerId: v.string(),
    revisionFsDeclarationCount: v.optional(v.number()),
    revisionFsFileCount: v.optional(v.number()),
    revisionFsSystemCount: v.optional(v.number()),
    compilerVersion: v.optional(v.string()),
    sourceFingerprint: v.optional(v.string()),
    artifactFingerprint: v.optional(v.string()),
    instanceToken: v.string(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.compileJobId);
    if (!job) {
      throw new Error("Compile job not found");
    }
    await requireExecutorAccessToCompileJob(ctx, {
      instanceToken: args.instanceToken,
      job,
    });
    if (job.status !== "running") {
      throw new Error("Compile job is not running");
    }
    if (job.workerId !== args.workerId) {
      throw new Error("Compile job is not owned by this worker");
    }
    const revision = await ctx.db.get(args.revisionId);
    if (!revision) {
      throw new Error("Revision not found");
    }
    if (revision.workspaceId !== job.workspaceId) {
      throw new Error("Revision does not belong to compile job workspace");
    }
    await ctx.db.patch(args.compileJobId, {
      status: "completed",
      revisionId: args.revisionId,
      revisionFsDeclarationCount: args.revisionFsDeclarationCount,
      revisionFsFileCount: args.revisionFsFileCount,
      revisionFsSystemCount: args.revisionFsSystemCount,
      compilerVersion: args.compilerVersion ?? revision?.compilerVersion,
      sourceFingerprint: args.sourceFingerprint ?? revision?.sourceFingerprint,
      artifactFingerprint: args.artifactFingerprint ?? revision?.artifactFingerprint,
      completedAt: Date.now(),
    });
    if (job.branchStateId) {
      const branchState = await ctx.db.get(job.branchStateId);
      if (branchState) {
        await ctx.db.patch(job.branchStateId, {
          lastCompiledRevisionId: args.revisionId,
          updatedAt: Date.now(),
        });
      }
    }
  },
});

export const cancelCompileJob = mutation({
  args: {
    compileJobId: v.id("compileJobs"),
    workerId: v.optional(v.string()),
    error: v.optional(
      v.object({
        message: v.string(),
        stack: v.optional(v.string()),
        details: v.optional(v.string()),
        data: v.optional(v.any()),
      }),
    ),
    instanceToken: v.string(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.compileJobId);
    if (!job) {
      throw new Error("Compile job not found");
    }
    await requireExecutorAccessToCompileJob(ctx, {
      instanceToken: args.instanceToken,
      job,
    });
    if (job.status !== "running" && job.status !== "pending") {
      return;
    }
    if (args.workerId && job.workerId && job.workerId !== args.workerId) {
      throw new Error("Compile job is not owned by this worker");
    }
    await ctx.db.patch(args.compileJobId, {
      status: "canceled",
      completedAt: Date.now(),
      error: args.error,
    });
  },
});

export const failCompileJob = mutation({
  args: {
    compileJobId: v.id("compileJobs"),
    workerId: v.string(),
    error: v.object({
      message: v.string(),
      stack: v.optional(v.string()),
      details: v.optional(v.string()),
      data: v.optional(v.any()),
    }),
    instanceToken: v.string(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.compileJobId);
    if (!job) {
      throw new Error("Compile job not found");
    }
    await requireExecutorAccessToCompileJob(ctx, {
      instanceToken: args.instanceToken,
      job,
    });
    if (job.status !== "running") {
      throw new Error("Compile job is not running");
    }
    if (job.workerId !== args.workerId) {
      throw new Error("Compile job is not owned by this worker");
    }
    await ctx.db.patch(args.compileJobId, {
      status: "failed",
      completedAt: Date.now(),
      error: args.error,
    });
  },
});
