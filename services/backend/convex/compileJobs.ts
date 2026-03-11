import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";

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

function assertExecutorToken(executorToken: string): void {
  const expected = process.env.TOKENSPACE_EXECUTOR_TOKEN;
  if (!expected || executorToken !== expected) {
    throw new Error("Unauthorized");
  }
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
    branchId: v.id("branches"),
    commitId: v.id("commits"),
    workingStateHash: v.optional(v.string()),
    userId: v.optional(v.string()),
    snapshotStorageId: v.id("_storage"),
  },
  returns: v.id("compileJobs"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("compileJobs", {
      workspaceId: args.workspaceId,
      branchId: args.branchId,
      commitId: args.commitId,
      workingStateHash: args.workingStateHash,
      userId: args.userId,
      snapshotStorageId: args.snapshotStorageId,
      status: "pending",
      createdAt: Date.now(),
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
    executorToken: v.string(),
  },
  returns: v.array(v.id("compileJobs")),
  handler: async (ctx, args) => {
    assertExecutorToken(args.executorToken);
    const now = Date.now();

    const pending = await ctx.db
      .query("compileJobs")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .take(RUNNABLE_SCAN_LIMIT);
    const reclaimableRunning = await ctx.db
      .query("compileJobs")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .filter((q) => q.or(q.eq(q.field("leaseExpiresAt"), undefined), q.lt(q.field("leaseExpiresAt"), now + 1)))
      .take(RUNNABLE_SCAN_LIMIT);

    return [...pending, ...reclaimableRunning].map((job) => job._id);
  },
});

export const claimCompileJob = mutation({
  args: {
    compileJobId: v.id("compileJobs"),
    workerId: v.string(),
    leaseMs: v.number(),
    executorToken: v.string(),
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
    assertExecutorToken(args.executorToken);
    const job = await ctx.db.get(args.compileJobId);
    if (!job) {
      throw new Error("Compile job not found");
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

    const now = Date.now();
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
    executorToken: v.string(),
  },
  handler: async (ctx, args) => {
    assertExecutorToken(args.executorToken);
    const job = await ctx.db.get(args.compileJobId);
    if (!job) {
      throw new Error("Compile job not found");
    }
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
    executorToken: v.string(),
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
    assertExecutorToken(args.executorToken);
    const job = await ctx.db.get(args.compileJobId);
    if (!job) {
      throw new Error("Compile job not found");
    }
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
    executorToken: v.string(),
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
    assertExecutorToken(args.executorToken);
    const job = await ctx.runQuery(internal.compileJobs.getCompileJob, {
      compileJobId: args.compileJobId,
    });
    if (!job) {
      throw new Error("Compile job not found");
    }
    assertRunningOwnedJob(job, args.workerId);

    await assertBranchHeadUnchanged(ctx, {
      branchId: job.branchId,
      expectedCommitId: job.commitId,
    });

    return await ctx.runAction(internal.revisionBuild.prepareRevisionFromBuildInternal, {
      workspaceId: job.workspaceId,
      branchId: job.branchId,
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
    executorToken: v.string(),
  },
  returns: v.object({
    revisionId: v.id("revisions"),
    created: v.boolean(),
  }),
  handler: async (ctx, args): Promise<CommitResult> => {
    assertExecutorToken(args.executorToken);
    const job = await ctx.runQuery(internal.compileJobs.getCompileJob, {
      compileJobId: args.compileJobId,
    });
    if (!job) {
      throw new Error("Compile job not found");
    }
    assertRunningOwnedJob(job, args.workerId);

    await assertBranchHeadUnchanged(ctx, {
      branchId: job.branchId,
      expectedCommitId: job.commitId,
    });

    return await ctx.runAction(internal.revisionBuild.commitRevisionFromBuildInternal, {
      workspaceId: job.workspaceId,
      branchId: job.branchId,
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
    executorToken: v.string(),
  },
  handler: async (ctx, args) => {
    assertExecutorToken(args.executorToken);
    const job = await ctx.db.get(args.compileJobId);
    if (!job) {
      throw new Error("Compile job not found");
    }
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
    executorToken: v.string(),
  },
  handler: async (ctx, args) => {
    assertExecutorToken(args.executorToken);
    const job = await ctx.db.get(args.compileJobId);
    if (!job) {
      throw new Error("Compile job not found");
    }
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
    executorToken: v.string(),
  },
  handler: async (ctx, args) => {
    assertExecutorToken(args.executorToken);
    const job = await ctx.db.get(args.compileJobId);
    if (!job) {
      throw new Error("Compile job not found");
    }
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
