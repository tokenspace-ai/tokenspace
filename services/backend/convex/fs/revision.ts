/**
 * Revision filesystem operations
 *
 * Base layer for materialized revision filesystem files from revisions.
 * These files are read-only snapshots compiled from workspace source code.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery, query } from "../_generated/server";
import { requireWorkspaceMember } from "../authz";
import { resolveFileDownloadUrl, resolveInlineContent, storeFileContent } from "./fileBlobs";
import { parsePath } from "./index";

// ============================================================================
// Internal Operations
// ============================================================================

/**
 * Write a file record to the revision filesystem (no storage access)
 */
export const writeRecord = internalMutation({
  args: {
    revisionId: v.id("revisions"),
    name: v.string(),
    parent: v.optional(v.string()),
    content: v.optional(v.string()),
    blobId: v.optional(v.id("blobs")),
    binary: v.boolean(),
  },
  handler: async (ctx, args): Promise<Id<"revisionFiles">> => {
    const existing = await ctx.db
      .query("revisionFiles")
      .withIndex("by_revision_path", (q) =>
        q.eq("revisionId", args.revisionId).eq("parent", args.parent).eq("name", args.name),
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        content: args.content,
        blobId: args.blobId,
        binary: args.binary,
        updatedAt: Date.now(),
      });

      return existing._id;
    }

    return await ctx.db.insert("revisionFiles", {
      revisionId: args.revisionId,
      name: args.name,
      parent: args.parent,
      content: args.content,
      blobId: args.blobId,
      binary: args.binary,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Write a file to the revision filesystem
 */
export const write = internalAction({
  args: {
    revisionId: v.id("revisions"),
    name: v.string(),
    parent: v.optional(v.string()),
    content: v.string(),
    binary: v.boolean(),
  },
  handler: async (ctx, args): Promise<Id<"revisionFiles">> => {
    const revision = await ctx.runQuery(internal.revisions.getRevision, { revisionId: args.revisionId });
    if (!revision) {
      throw new Error("Revision not found");
    }

    const stored = await storeFileContent(ctx, {
      workspaceId: revision.workspaceId,
      content: args.content,
      binary: args.binary,
    });

    return await ctx.runMutation(internal.fs.revision.writeRecord, {
      revisionId: args.revisionId,
      name: args.name,
      parent: args.parent,
      content: stored.content,
      blobId: stored.blobId,
      binary: args.binary,
    });
  },
});

/**
 * Read a file from the revision filesystem
 */
export const read = internalQuery({
  args: {
    revisionId: v.id("revisions"),
    parent: v.optional(v.string()),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const file = await ctx.db
      .query("revisionFiles")
      .withIndex("by_revision_path", (q) =>
        q
          .eq("revisionId", args.revisionId)
          .eq("parent", args.parent || undefined)
          .eq("name", args.name),
      )
      .unique();
    if (!file) {
      return null;
    }
    const content = await resolveInlineContent(file);
    const downloadUrl = content === undefined ? await resolveFileDownloadUrl(ctx, file) : undefined;
    return { ...file, content, downloadUrl };
  },
});

/**
 * Read a file from the revision filesystem
 */
export const readFileAtPath = internalQuery({
  args: {
    revisionId: v.id("revisions"),
    path: v.string(),
  },
  handler: async (ctx, args) => {
    const parts = (args.path.startsWith("/") ? args.path.slice(1) : args.path).split("/");
    const fileName = parts.pop();

    const file = await ctx.db
      .query("revisionFiles")
      .withIndex("by_revision_path", (q) =>
        q
          .eq("revisionId", args.revisionId)
          .eq("parent", parts.length ? parts.join("/") : undefined)
          .eq("name", fileName!),
      )
      .unique();
    if (!file) {
      return null;
    }
    const content = await resolveInlineContent(file);
    const downloadUrl = content === undefined ? await resolveFileDownloadUrl(ctx, file) : undefined;
    return { ...file, content, downloadUrl };
  },
});

/**
 * Delete a file from the revision filesystem
 */
export const remove = internalMutation({
  args: {
    revisionId: v.id("revisions"),
    parent: v.optional(v.string()),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("revisionFiles")
      .withIndex("by_revision_path", (q) =>
        q
          .eq("revisionId", args.revisionId)
          .eq("parent", args.parent || undefined)
          .eq("name", args.name),
      )
      .first();

    if (!existing) {
      const fullPath = args.parent ? `${args.parent}/${args.name}` : args.name;
      throw new Error(`Revision file ${fullPath} not found`);
    }

    await ctx.db.delete(existing._id);
  },
});

/**
 * List all files in the revision filesystem recursively
 */
export const list = internalQuery({
  args: {
    revisionId: v.id("revisions"),
  },
  handler: async (ctx, args): Promise<string[]> => {
    const result = [];
    for await (const entry of ctx.db
      .query("revisionFiles")
      .withIndex("by_revision", (q) => q.eq("revisionId", args.revisionId))) {
      result.push(entry.parent ? `${entry.parent}/${entry.name}` : entry.name);
    }
    return result;
  },
});

/**
 * List files in a specific directory
 */
export const listDir = internalQuery({
  args: {
    revisionId: v.id("revisions"),
    parent: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<string[]> => {
    const result = [];
    for await (const entry of ctx.db
      .query("revisionFiles")
      .withIndex("by_revision_path", (q) =>
        q.eq("revisionId", args.revisionId).eq("parent", args.parent || undefined),
      )) {
      result.push(entry.name);
    }
    return result;
  },
});

/**
 * Clear all files for a revision
 */
export const clear = internalMutation({
  args: {
    revisionId: v.id("revisions"),
  },
  handler: async (ctx, args) => {
    const files = await ctx.db
      .query("revisionFiles")
      .withIndex("by_revision", (q) => q.eq("revisionId", args.revisionId))
      .collect();

    for (const file of files) {
      await ctx.db.delete(file._id);
    }

    return files.length;
  },
});

/**
 * Check if revision files exist for a revision
 */
export const exists = internalQuery({
  args: {
    revisionId: v.id("revisions"),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const first = await ctx.db
      .query("revisionFiles")
      .withIndex("by_revision", (q) => q.eq("revisionId", args.revisionId))
      .first();
    return first !== null;
  },
});

// ============================================================================
// Public Queries
// ============================================================================

/**
 * Get all revision files for a revision as a tree structure
 */
export const getTree = query({
  args: {
    revisionId: v.id("revisions"),
  },
  handler: async (ctx, args) => {
    const files = await ctx.db
      .query("revisionFiles")
      .withIndex("by_revision", (q) => q.eq("revisionId", args.revisionId))
      .collect();

    // Build a tree structure
    type FileNode = {
      name: string;
      path: string;
      type: "file" | "directory";
      children?: FileNode[];
    };

    const root: FileNode[] = [];
    const dirMap = new Map<string, FileNode>();

    // Sort files by path for consistent ordering
    const sortedFiles = files.sort((a, b) => {
      const pathA = a.parent ? `${a.parent}/${a.name}` : a.name;
      const pathB = b.parent ? `${b.parent}/${b.name}` : b.name;
      return pathA.localeCompare(pathB);
    });

    for (const file of sortedFiles) {
      const fullPath = file.parent ? `${file.parent}/${file.name}` : file.name;

      // Ensure parent directories exist
      if (file.parent) {
        const parts = file.parent.split("/");
        let currentPath = "";
        let currentLevel = root;

        for (const part of parts) {
          currentPath = currentPath ? `${currentPath}/${part}` : part;

          let dir = dirMap.get(currentPath);
          if (!dir) {
            dir = {
              name: part,
              path: currentPath,
              type: "directory",
              children: [],
            };
            dirMap.set(currentPath, dir);
            currentLevel.push(dir);
            // Sort after adding
            currentLevel.sort((a, b) => {
              if (a.type === "directory" && b.type === "file") return -1;
              if (a.type === "file" && b.type === "directory") return 1;
              return a.name.localeCompare(b.name);
            });
          }
          currentLevel = dir.children!;
        }

        // Add file to its parent directory
        currentLevel.push({
          name: file.name,
          path: fullPath,
          type: "file",
        });
        // Sort after adding
        currentLevel.sort((a, b) => {
          if (a.type === "directory" && b.type === "file") return -1;
          if (a.type === "file" && b.type === "directory") return 1;
          return a.name.localeCompare(b.name);
        });
      } else {
        // Root level file
        root.push({
          name: file.name,
          path: fullPath,
          type: "file",
        });
        // Sort after adding
        root.sort((a, b) => {
          if (a.type === "directory" && b.type === "file") return -1;
          if (a.type === "file" && b.type === "directory") return 1;
          return a.name.localeCompare(b.name);
        });
      }
    }

    return root;
  },
});

/**
 * Read a revision file's content
 */
export const getContent = query({
  args: {
    revisionId: v.id("revisions"),
    path: v.string(),
  },
  handler: async (ctx, args) => {
    const parsed = parsePath(args.path);
    const file = await ctx.db
      .query("revisionFiles")
      .withIndex("by_revision_path", (q) =>
        q
          .eq("revisionId", args.revisionId)
          .eq("parent", parsed.parent || undefined)
          .eq("name", parsed.name),
      )
      .first();

    if (!file) {
      return null;
    }

    const content = await resolveInlineContent(file);
    if (content !== undefined) {
      return {
        path: args.path,
        content,
        binary: file.binary,
      };
    }

    const downloadUrl = await resolveFileDownloadUrl(ctx, file);
    if (!downloadUrl) {
      return null;
    }

    return {
      path: args.path,
      content: undefined,
      binary: file.binary,
      downloadUrl,
    };
  },
});

/**
 * Get the published revision for a workspace.
 */
export const getRevision = query({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get(args.workspaceId);
    if (!workspace) {
      throw new Error("Workspace not found");
    }

    if (!workspace.activeRevisionId) {
      return null;
    }

    return await ctx.db.get(workspace.activeRevisionId);
  },
});

/**
 * Get revision by branch and commit
 */
export const getRevisionByBranchCommit = query({
  args: {
    branchId: v.id("branches"),
    commitId: v.id("commits"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("revisions")
      .withIndex("by_branch_commit", (q) => q.eq("branchId", args.branchId).eq("commitId", args.commitId))
      .filter((q) => q.and(q.eq(q.field("workingStateHash"), undefined), q.eq(q.field("branchStateId"), undefined)))
      .first();
  },
});

export const getCurrentRevisionIdForBranch = query({
  args: {
    branchId: v.id("branches"),
    workingStateHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const branch = await ctx.db.get(args.branchId);
    if (!branch) {
      throw new Error("Branch not found");
    }

    await requireWorkspaceMember(ctx, branch.workspaceId);

    const revision = args.workingStateHash
      ? await ctx.db
          .query("revisions")
          .withIndex("by_branch_working", (q) =>
            q
              .eq("branchId", args.branchId)
              .eq("commitId", branch.commitId)
              .eq("workingStateHash", args.workingStateHash),
          )
          .filter((q) => q.eq(q.field("branchStateId"), undefined))
          .first()
      : await ctx.db
          .query("revisions")
          .withIndex("by_branch_commit", (q) => q.eq("branchId", args.branchId).eq("commitId", branch.commitId))
          .filter((q) => q.and(q.eq(q.field("workingStateHash"), undefined), q.eq(q.field("branchStateId"), undefined)))
          .first();

    return revision?._id ?? null;
  },
});
