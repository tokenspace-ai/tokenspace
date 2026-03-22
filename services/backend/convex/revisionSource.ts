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
    };

export type ResolvedRevisionBuildSource = {
  branchId: Id<"branches">;
  branchStateId?: Id<"branchStates">;
  commitId: Id<"commits">;
  workingStateHash?: string;
  sourceSnapshotHash?: string;
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
      branchId: branch._id,
      commitId: branch.commitId,
      workingStateHash,
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
    branchId: branch._id,
    branchStateId: branchState._id,
    commitId: branch.commitId,
    sourceSnapshotHash,
  };
}
