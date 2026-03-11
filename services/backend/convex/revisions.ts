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
    commitId: v.id("commits"),
    workingStateHash: v.optional(v.string()),
    artifactFingerprint: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const baseQuery = args.workingStateHash
      ? ctx.db
          .query("revisions")
          .withIndex("by_branch_working", (q) =>
            q.eq("branchId", args.branchId).eq("commitId", args.commitId).eq("workingStateHash", args.workingStateHash),
          )
      : ctx.db
          .query("revisions")
          .withIndex("by_branch_commit", (q) => q.eq("branchId", args.branchId).eq("commitId", args.commitId))
          .filter((q) => q.eq(q.field("workingStateHash"), undefined));

    if (args.artifactFingerprint) {
      return await baseQuery.filter((q) => q.eq(q.field("artifactFingerprint"), args.artifactFingerprint)).first();
    }
    return await baseQuery.first();
  },
});

/**
 * Create a new revision record
 */
export const createRevision = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    branchId: v.id("branches"),
    commitId: v.id("commits"),
    workingStateHash: v.optional(v.string()),
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
    // Check if revision already exists
    const baseQuery = args.workingStateHash
      ? ctx.db
          .query("revisions")
          .withIndex("by_branch_working", (q) =>
            q.eq("branchId", args.branchId).eq("commitId", args.commitId).eq("workingStateHash", args.workingStateHash),
          )
      : ctx.db
          .query("revisions")
          .withIndex("by_branch_commit", (q) => q.eq("branchId", args.branchId).eq("commitId", args.commitId))
          .filter((q) => q.eq(q.field("workingStateHash"), undefined));

    const existing = args.artifactFingerprint
      ? await baseQuery.filter((q) => q.eq(q.field("artifactFingerprint"), args.artifactFingerprint)).first()
      : await baseQuery.first();

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
      commitId: args.commitId,
      workingStateHash: args.workingStateHash,
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
