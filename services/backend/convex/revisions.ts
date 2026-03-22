/**
 * Revision queries and mutations.
 * Revisions are immutable snapshots of compiled workspace states.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import {
  vCapabilitySummary,
  vCredentialRequirementSummary,
  vSkillSummary,
  vWorkspaceModelDefinition,
} from "./workspaceMetadata";

async function assertMatchingBranchState(
  ctx: any,
  args: {
    branchId: string;
    branchStateId?: string;
    workspaceId?: string;
  },
) {
  if (!args.branchStateId) {
    return;
  }

  const branchState = await ctx.db.get(args.branchStateId);
  if (!branchState) {
    throw new Error("Branch state not found");
  }
  if (branchState.backingBranchId !== args.branchId) {
    throw new Error("Branch state does not match branch");
  }
  if (args.workspaceId && branchState.workspaceId !== args.workspaceId) {
    throw new Error("Branch state does not match workspace");
  }
}

function queryRevisionIdentity(
  ctx: any,
  args: {
    branchId: string;
    branchStateId?: string;
    commitId: string;
    workingStateHash?: string;
    sourceSnapshotHash?: string;
  },
) {
  if (args.branchStateId) {
    return args.sourceSnapshotHash
      ? ctx.db
          .query("revisions")
          .withIndex("by_branch_state_snapshot", (q: any) =>
            q
              .eq("branchStateId", args.branchStateId)
              .eq("commitId", args.commitId)
              .eq("sourceSnapshotHash", args.sourceSnapshotHash),
          )
      : ctx.db
          .query("revisions")
          .withIndex("by_branch_state_commit", (q: any) =>
            q.eq("branchStateId", args.branchStateId).eq("commitId", args.commitId),
          )
          .filter((q: any) => q.eq(q.field("sourceSnapshotHash"), undefined));
  }

  const legacyQuery = args.workingStateHash
    ? ctx.db
        .query("revisions")
        .withIndex("by_branch_working", (q: any) =>
          q.eq("branchId", args.branchId).eq("commitId", args.commitId).eq("workingStateHash", args.workingStateHash),
        )
    : ctx.db
        .query("revisions")
        .withIndex("by_branch_commit", (q: any) => q.eq("branchId", args.branchId).eq("commitId", args.commitId))
        .filter((q: any) => q.eq(q.field("workingStateHash"), undefined));

  return legacyQuery.filter((q: any) => q.eq(q.field("branchStateId"), undefined));
}

/**
 * Get a revision by ID
 */
export const getRevision = internalQuery({
  args: {
    revisionId: v.id("revisions"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.revisionId);
  },
});

/**
 * Find an existing revision for a branch/commit/working state combination
 */
export const findRevision = internalQuery({
  args: {
    branchId: v.id("branches"),
    branchStateId: v.optional(v.id("branchStates")),
    commitId: v.id("commits"),
    workingStateHash: v.optional(v.string()),
    sourceSnapshotHash: v.optional(v.string()),
    artifactFingerprint: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await assertMatchingBranchState(ctx, args);
    let existing = args.artifactFingerprint
      ? await queryRevisionIdentity(ctx, args)
          .filter((q: any) => q.eq(q.field("artifactFingerprint"), args.artifactFingerprint))
          .first()
      : await queryRevisionIdentity(ctx, args).first();

    if (!existing && args.branchStateId && args.sourceSnapshotHash) {
      const fallbackQuery = ctx.db
        .query("revisions")
        .withIndex("by_branch_state_working", (q: any) =>
          q
            .eq("branchStateId", args.branchStateId)
            .eq("commitId", args.commitId)
            .eq("workingStateHash", args.sourceSnapshotHash),
        );
      existing = args.artifactFingerprint
        ? await fallbackQuery.filter((q: any) => q.eq(q.field("artifactFingerprint"), args.artifactFingerprint)).first()
        : await fallbackQuery.first();
    }
    return existing;
  },
});

/**
 * Create a new revision record
 */
export const createRevision = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    branchId: v.id("branches"),
    branchStateId: v.optional(v.id("branchStates")),
    commitId: v.id("commits"),
    workingStateHash: v.optional(v.string()),
    sourceSnapshotHash: v.optional(v.string()),
    artifactFingerprint: v.optional(v.string()),
    revisionFsStorageId: v.id("_storage"),
    bundleStorageId: v.id("_storage"),
    depsStorageId: v.optional(v.id("_storage")),
    metadataStorageId: v.optional(v.id("_storage")),
    diagnosticsStorageId: v.optional(v.id("_storage")),
    manifestStorageId: v.optional(v.id("_storage")),
    compilerVersion: v.optional(v.string()),
    sourceFingerprint: v.optional(v.string()),
    compileMode: v.optional(v.union(v.literal("local"), v.literal("server"))),
    capabilities: v.optional(v.array(vCapabilitySummary)),
    skills: v.optional(v.array(vSkillSummary)),
    tokenspaceMd: v.optional(v.string()),
    credentialRequirements: v.optional(v.array(vCredentialRequirementSummary)),
    models: v.optional(v.array(vWorkspaceModelDefinition)),
  },
  handler: async (ctx, args) => {
    await assertMatchingBranchState(ctx, args);
    // Check if revision already exists
    let existing = args.artifactFingerprint
      ? await queryRevisionIdentity(ctx, args)
          .filter((q: any) => q.eq(q.field("artifactFingerprint"), args.artifactFingerprint))
          .first()
      : await queryRevisionIdentity(ctx, args).first();

    if (!existing && args.branchStateId && args.sourceSnapshotHash) {
      const fallbackQuery = ctx.db
        .query("revisions")
        .withIndex("by_branch_state_working", (q: any) =>
          q
            .eq("branchStateId", args.branchStateId)
            .eq("commitId", args.commitId)
            .eq("workingStateHash", args.sourceSnapshotHash),
        );
      existing = args.artifactFingerprint
        ? await fallbackQuery.filter((q: any) => q.eq(q.field("artifactFingerprint"), args.artifactFingerprint)).first()
        : await fallbackQuery.first();
    }

    if (existing) {
      const patch: {
        revisionFsStorageId?: typeof args.revisionFsStorageId;
        artifactFingerprint?: typeof args.artifactFingerprint;
        depsStorageId?: typeof args.depsStorageId;
        metadataStorageId?: typeof args.metadataStorageId;
        diagnosticsStorageId?: typeof args.diagnosticsStorageId;
        manifestStorageId?: typeof args.manifestStorageId;
        compilerVersion?: typeof args.compilerVersion;
        sourceFingerprint?: typeof args.sourceFingerprint;
        sourceSnapshotHash?: typeof args.sourceSnapshotHash;
        compileMode?: typeof args.compileMode;
        capabilities?: typeof args.capabilities;
        skills?: typeof args.skills;
        tokenspaceMd?: typeof args.tokenspaceMd;
        credentialRequirements?: typeof args.credentialRequirements;
        models?: typeof args.models;
      } = {};

      if (args.revisionFsStorageId && !existing.revisionFsStorageId) {
        patch.revisionFsStorageId = args.revisionFsStorageId;
      }
      if (args.artifactFingerprint && !existing.artifactFingerprint) {
        patch.artifactFingerprint = args.artifactFingerprint;
      }
      if (args.depsStorageId && !existing.depsStorageId) {
        patch.depsStorageId = args.depsStorageId;
      }
      if (args.metadataStorageId && !existing.metadataStorageId) {
        patch.metadataStorageId = args.metadataStorageId;
      }
      if (args.diagnosticsStorageId && !existing.diagnosticsStorageId) {
        patch.diagnosticsStorageId = args.diagnosticsStorageId;
      }
      if (args.manifestStorageId && !existing.manifestStorageId) {
        patch.manifestStorageId = args.manifestStorageId;
      }
      if (args.compilerVersion && !existing.compilerVersion) {
        patch.compilerVersion = args.compilerVersion;
      }
      if (args.sourceFingerprint && !existing.sourceFingerprint) {
        patch.sourceFingerprint = args.sourceFingerprint;
      }
      if (args.sourceSnapshotHash && !existing.sourceSnapshotHash) {
        patch.sourceSnapshotHash = args.sourceSnapshotHash;
      }
      if (args.compileMode && !existing.compileMode) {
        patch.compileMode = args.compileMode;
      }
      if (args.capabilities && !existing.capabilities) {
        patch.capabilities = args.capabilities;
      }
      if (args.skills && !existing.skills) {
        patch.skills = args.skills;
      }
      if (args.tokenspaceMd !== undefined && !existing.tokenspaceMd) {
        patch.tokenspaceMd = args.tokenspaceMd;
      }
      if (args.credentialRequirements && !existing.credentialRequirements) {
        patch.credentialRequirements = args.credentialRequirements;
      }
      if (args.models && !existing.models) {
        patch.models = args.models;
      }

      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(existing._id, patch);
      }
      return existing._id;
    }

    return await ctx.db.insert("revisions", {
      workspaceId: args.workspaceId,
      branchId: args.branchId,
      branchStateId: args.branchStateId,
      commitId: args.commitId,
      workingStateHash: args.workingStateHash,
      sourceSnapshotHash: args.sourceSnapshotHash,
      artifactFingerprint: args.artifactFingerprint,
      revisionFsStorageId: args.revisionFsStorageId,
      bundleStorageId: args.bundleStorageId,
      depsStorageId: args.depsStorageId,
      metadataStorageId: args.metadataStorageId,
      diagnosticsStorageId: args.diagnosticsStorageId,
      manifestStorageId: args.manifestStorageId,
      compilerVersion: args.compilerVersion,
      sourceFingerprint: args.sourceFingerprint,
      compileMode: args.compileMode,
      capabilities: args.capabilities,
      skills: args.skills,
      tokenspaceMd: args.tokenspaceMd,
      credentialRequirements: args.credentialRequirements,
      models: args.models,
      createdAt: Date.now(),
    });
  },
});
