/**
 * Working directory filesystem operations
 *
 * Manages uncommitted changes per user/branch.
 * These are staged changes that can be committed to create new versions.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { action, internalMutation, internalQuery, mutation, query } from "../_generated/server";
import { requireAuthenticatedUser, requireWorkspaceAdmin, requireWorkspaceMember } from "../authz";
import { resolveFileDownloadUrl, resolveInlineContent, storeFileContent } from "./fileBlobs";

// ============================================================================
// Internal Operations
// ============================================================================

/**
 * Write a file to the working directory
 */
export const write = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    branchId: v.id("branches"),
    userId: v.string(),
    path: v.string(),
    content: v.optional(v.string()),
    blobId: v.optional(v.id("blobs")),
  },
  handler: async (ctx, args): Promise<Id<"workingFiles">> => {
    // Check if file already exists in working directory
    const existing = await ctx.db
      .query("workingFiles")
      .withIndex("by_path", (q) => q.eq("branchId", args.branchId).eq("userId", args.userId).eq("path", args.path))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        content: args.content,
        blobId: args.blobId,
        isDeleted: false,
        updatedAt: Date.now(),
      });
      return existing._id;
    }

    return await ctx.db.insert("workingFiles", {
      workspaceId: args.workspaceId,
      branchId: args.branchId,
      userId: args.userId,
      path: args.path,
      content: args.content,
      blobId: args.blobId,
      isDeleted: false,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Read a file from the working directory
 */
export const read = internalQuery({
  args: {
    branchId: v.id("branches"),
    userId: v.string(),
    path: v.string(),
  },
  handler: async (ctx, args): Promise<(Doc<"workingFiles"> & { content?: string; downloadUrl?: string }) | null> => {
    const file = await ctx.db
      .query("workingFiles")
      .withIndex("by_path", (q) => q.eq("branchId", args.branchId).eq("userId", args.userId).eq("path", args.path))
      .first();
    if (!file) {
      return null;
    }
    const content = await resolveInlineContent(file);
    const downloadUrl = content === undefined ? await resolveFileDownloadUrl(ctx, file) : undefined;
    return { ...file, content, downloadUrl };
  },
});

/**
 * Delete a file in the working directory (marks as deleted)
 */
export const remove = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    branchId: v.id("branches"),
    userId: v.string(),
    path: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"workingFiles">> => {
    // Check if file exists in working directory
    const existing = await ctx.db
      .query("workingFiles")
      .withIndex("by_path", (q) => q.eq("branchId", args.branchId).eq("userId", args.userId).eq("path", args.path))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        content: undefined,
        blobId: undefined,
        isDeleted: true,
        updatedAt: Date.now(),
      });
      return existing._id;
    }

    // Create a deletion marker
    return await ctx.db.insert("workingFiles", {
      workspaceId: args.workspaceId,
      branchId: args.branchId,
      userId: args.userId,
      path: args.path,
      content: undefined,
      blobId: undefined,
      isDeleted: true,
      updatedAt: Date.now(),
    });
  },
});

/**
 * List all working files for a branch/user
 */
export const list = internalQuery({
  args: {
    branchId: v.id("branches"),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("workingFiles")
      .withIndex("by_branch_user", (q) => q.eq("branchId", args.branchId).eq("userId", args.userId))
      .collect();
  },
});

/**
 * Clear working directory after commit
 */
export const clear = internalMutation({
  args: {
    branchId: v.id("branches"),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const files = await ctx.db
      .query("workingFiles")
      .withIndex("by_branch_user", (q) => q.eq("branchId", args.branchId).eq("userId", args.userId))
      .collect();

    for (const file of files) {
      await ctx.db.delete(file._id);
    }

    return files.length;
  },
});

/**
 * Discard a specific working file change
 */
export const discard = internalMutation({
  args: {
    branchId: v.id("branches"),
    userId: v.string(),
    path: v.string(),
  },
  handler: async (ctx, args) => {
    const file = await ctx.db
      .query("workingFiles")
      .withIndex("by_path", (q) => q.eq("branchId", args.branchId).eq("userId", args.userId).eq("path", args.path))
      .first();

    if (file) {
      await ctx.db.delete(file._id);
      return true;
    }
    return false;
  },
});

/**
 * Get working directory changes (for committing)
 */
export const getChanges = internalQuery({
  args: {
    branchId: v.id("branches"),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const files = await ctx.db
      .query("workingFiles")
      .withIndex("by_branch_user", (q) => q.eq("branchId", args.branchId).eq("userId", args.userId))
      .collect();

    const changes = [];
    for (const file of files) {
      if (file.isDeleted) {
        changes.push({
          path: file.path,
          content: undefined,
          downloadUrl: undefined,
          blobId: file.blobId,
          isDeleted: true,
        });
        continue;
      }
      const content = await resolveInlineContent(file);
      const downloadUrl = content === undefined ? await resolveFileDownloadUrl(ctx, file) : undefined;
      changes.push({
        path: file.path,
        content,
        downloadUrl,
        blobId: file.blobId,
        isDeleted: false,
      });
    }
    return changes;
  },
});

// ============================================================================
// Public Operations
// ============================================================================

/**
 * Save a file to the working directory (public mutation)
 */
export const save = action({
  args: {
    workspaceId: v.id("workspaces"),
    branchId: v.id("branches"),
    path: v.string(),
    content: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"workingFiles">> => {
    const stored = await storeFileContent(ctx, {
      workspaceId: args.workspaceId,
      content: args.content,
      binary: false,
    });

    // Verify branch belongs to workspace
    const branch = await ctx.runQuery(internal.vcs.getBranchInternal, {
      branchId: args.branchId,
    });
    if (!branch || branch.workspaceId !== args.workspaceId) {
      throw new Error("Branch not found or does not belong to workspace");
    }
    const { user } = await requireWorkspaceAdmin(ctx, branch.workspaceId);

    return await ctx.runMutation(internal.fs.working.write, {
      workspaceId: args.workspaceId,
      branchId: args.branchId,
      userId: user.subject,
      path: args.path,
      content: stored.content,
      blobId: stored.blobId,
    });
  },
});

/**
 * Mark a file as deleted in the working directory (public mutation)
 */
export const markDeleted = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    branchId: v.id("branches"),
    path: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireAuthenticatedUser(ctx);

    // Verify branch belongs to workspace
    const branch = await ctx.db.get(args.branchId);
    if (!branch || branch.workspaceId !== args.workspaceId) {
      throw new Error("Branch not found or does not belong to workspace");
    }
    await requireWorkspaceAdmin(ctx, branch.workspaceId);

    // Check if file exists in working directory
    const existing = await ctx.db
      .query("workingFiles")
      .withIndex("by_path", (q) => q.eq("branchId", args.branchId).eq("userId", user.subject).eq("path", args.path))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        content: undefined,
        blobId: undefined,
        isDeleted: true,
        updatedAt: Date.now(),
      });
      return existing._id;
    }

    // Create a deletion marker
    return await ctx.db.insert("workingFiles", {
      workspaceId: args.workspaceId,
      branchId: args.branchId,
      userId: user.subject,
      path: args.path,
      content: undefined,
      blobId: undefined,
      isDeleted: true,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Get all working files for a branch/user (public query)
 */
export const getAll = query({
  args: {
    branchId: v.id("branches"),
  },
  handler: async (ctx, args) => {
    const branch = await ctx.db.get(args.branchId);
    if (!branch) {
      throw new Error("Branch not found");
    }
    const { user } = await requireWorkspaceMember(ctx, branch.workspaceId);

    const files = await ctx.db
      .query("workingFiles")
      .withIndex("by_branch_user", (q) => q.eq("branchId", args.branchId).eq("userId", user.subject))
      .collect();

    const resolved = [];
    for (const file of files) {
      if (file.isDeleted) {
        resolved.push({ ...file, content: undefined, downloadUrl: undefined });
        continue;
      }
      const content = await resolveInlineContent(file);
      const downloadUrl = content === undefined ? await resolveFileDownloadUrl(ctx, file) : undefined;
      resolved.push({ ...file, content, downloadUrl });
    }
    return resolved;
  },
});

/**
 * Discard a specific working file change (public mutation)
 */
export const discardChange = mutation({
  args: {
    branchId: v.id("branches"),
    path: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireAuthenticatedUser(ctx);
    const branch = await ctx.db.get(args.branchId);
    if (!branch) {
      throw new Error("Branch not found");
    }
    await requireWorkspaceAdmin(ctx, branch.workspaceId);

    const file = await ctx.db
      .query("workingFiles")
      .withIndex("by_path", (q) => q.eq("branchId", args.branchId).eq("userId", user.subject).eq("path", args.path))
      .first();

    if (file) {
      await ctx.db.delete(file._id);
      return true;
    }
    return false;
  },
});

/**
 * Discard all working file changes (public mutation)
 */
export const discardAll = mutation({
  args: {
    branchId: v.id("branches"),
  },
  handler: async (ctx, args) => {
    const user = await requireAuthenticatedUser(ctx);
    const branch = await ctx.db.get(args.branchId);
    if (!branch) {
      throw new Error("Branch not found");
    }
    await requireWorkspaceAdmin(ctx, branch.workspaceId);

    const files = await ctx.db
      .query("workingFiles")
      .withIndex("by_branch_user", (q) => q.eq("branchId", args.branchId).eq("userId", user.subject))
      .collect();

    for (const file of files) {
      await ctx.db.delete(file._id);
    }

    return files.length;
  },
});
