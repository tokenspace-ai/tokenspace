import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { computeWorkingStateHash } from "./workingStateHash";

export const vRevisionBuildSource = v.union(
  v.object({
    kind: v.literal("branch"),
    branchId: v.id("branches"),
    workingStateHash: v.optional(v.string()),
  }),
  v.object({
    kind: v.literal("branchState"),
    branchStateId: v.id("branchStates"),
    sourceSnapshotHash: v.optional(v.string()),
  }),
  v.object({
    kind: v.literal("gitCommit"),
    commitSha: v.string(),
    repoRef: v.string(),
    branch: v.optional(v.string()),
    subdir: v.optional(v.string()),
  }),
);

export type RevisionBuildSource =
  | {
      kind: "branch";
      branchId: Id<"branches">;
      workingStateHash?: string;
    }
  | {
      kind: "branchState";
      branchStateId: Id<"branchStates">;
      sourceSnapshotHash?: string;
    }
  | {
      kind: "gitCommit";
      commitSha: string;
      repoRef: string;
      branch?: string;
      subdir?: string;
    };

export type ResolvedRevisionBuildSource =
  | {
      sourceKind: "branch";
      branchId: Id<"branches">;
      commitId: Id<"commits">;
      workingStateHash?: string;
    }
  | {
      sourceKind: "branchState";
      branchId: Id<"branches">;
      branchStateId: Id<"branchStates">;
      commitId: Id<"commits">;
      sourceSnapshotHash?: string;
    }
  | {
      sourceKind: "gitCommit";
      branchId: Id<"branches">;
      commitId: Id<"commits">;
      gitCommitSha: string;
      gitRepoRef: string;
      gitBranch?: string;
      gitSubdir?: string;
    };

export async function resolveRevisionBuildSource(
  ctx: any,
  args: {
    workspaceId: Id<"workspaces">;
    source: RevisionBuildSource;
    userId?: string;
  },
): Promise<ResolvedRevisionBuildSource> {
  if (args.source.kind === "branch") {
    const branch = await ctx.runQuery(internal.vcs.getBranchInternal, {
      branchId: args.source.branchId,
    });
    if (!branch || branch.workspaceId !== args.workspaceId) {
      throw new Error("Branch not found or does not belong to workspace");
    }

    let workingStateHash = args.source.workingStateHash;
    if (workingStateHash === undefined && args.userId) {
      const workingChanges = await ctx.runQuery(internal.fs.working.getChanges, {
        branchId: branch._id,
        userId: args.userId,
      });
      workingStateHash = workingChanges.length > 0 ? computeWorkingStateHash(workingChanges) : undefined;
    }

    return {
      sourceKind: "branch",
      branchId: branch._id,
      commitId: branch.commitId,
      workingStateHash,
    };
  }

  if (args.source.kind === "gitCommit") {
    const workspace = await ctx.runQuery(internal.workspace.getInternal, {
      workspaceId: args.workspaceId,
    });
    if (!workspace) {
      throw new Error("Workspace not found");
    }
    if (!workspace.gitSyncEnabled) {
      throw new Error("Workspace is not Git-connected");
    }

    const defaultBranch = await ctx.runQuery(internal.vcs.getDefaultBranchInternal, {
      workspaceId: args.workspaceId,
    });
    if (!defaultBranch) {
      throw new Error("Workspace default branch not found");
    }

    return {
      sourceKind: "gitCommit",
      branchId: defaultBranch._id,
      commitId: defaultBranch.commitId,
      gitCommitSha: args.source.commitSha,
      gitRepoRef: args.source.repoRef,
      gitBranch: args.source.branch,
      gitSubdir: args.source.subdir,
    };
  }

  const branchState = await ctx.runQuery(internal.branchStates.getInternal, {
    branchStateId: args.source.branchStateId,
  });
  if (!branchState || branchState.workspaceId !== args.workspaceId) {
    throw new Error("Branch state not found or does not belong to workspace");
  }

  const branch = await ctx.runQuery(internal.vcs.getBranchInternal, {
    branchId: branchState.backingBranchId,
  });
  if (!branch || branch.workspaceId !== args.workspaceId) {
    throw new Error("Branch backing branch not found or does not belong to workspace");
  }

  let sourceSnapshotHash = args.source.sourceSnapshotHash;
  if (sourceSnapshotHash === undefined) {
    const workingChanges = await ctx.runQuery(internal.fs.working.getChangesForBranchState, {
      branchStateId: branchState._id,
    });
    sourceSnapshotHash = workingChanges.length > 0 ? computeWorkingStateHash(workingChanges) : undefined;
  }

  return {
    sourceKind: "branchState",
    branchId: branch._id,
    branchStateId: branchState._id,
    commitId: branch.commitId,
    sourceSnapshotHash,
  };
}
