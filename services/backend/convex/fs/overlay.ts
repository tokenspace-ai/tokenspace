/**
 * Session-scoped overlay filesystem
 *
 * This module provides a copy-on-write overlay for the revision filesystem.
 * Each session gets its own isolated view of the filesystem, shared by all
 * threads in that session (parent and sub-agents):
 * - Reads check the session overlay first, then fall back to base revisionFiles
 * - Writes go to the session overlay, never modifying the base revisionFiles
 * - Deletes are tracked in the overlay as "deleted" markers
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "../_generated/server";
import {
  INLINE_CONTENT_MAX_CHARS,
  loadFileContent,
  resolveFileDownloadUrl,
  resolveFileSize,
  resolveInlineContent,
  storeFileContent,
} from "./fileBlobs";
import { type OverlayFile, parsePath } from "./index";

// ============================================================================
// Internal Operations
// ============================================================================

/**
 * Read a file from the overlayed filesystem (session overlay + base revision filesystem)
 */
export const read = internalQuery({
  args: {
    sessionId: v.id("sessions"),
    revisionId: v.id("revisions"),
    parent: v.optional(v.string()),
    name: v.string(),
  },
  handler: async (ctx, args): Promise<OverlayFile | null> => {
    // First check the session overlay
    const overlayFile = await ctx.db
      .query("sessionOverlayFiles")
      .withIndex("by_session_path", (q) =>
        q
          .eq("sessionId", args.sessionId)
          .eq("parent", args.parent || undefined)
          .eq("name", args.name),
      )
      .first();

    if (overlayFile) {
      // File exists in overlay
      if (overlayFile.isDeleted) {
        return null; // File was deleted in this session
      }
      const content = await resolveInlineContent(overlayFile);
      const downloadUrl = content === undefined ? await resolveFileDownloadUrl(ctx, overlayFile) : undefined;
      return {
        name: overlayFile.name,
        parent: overlayFile.parent,
        content,
        blobId: overlayFile.blobId,
        downloadUrl,
        binary: overlayFile.binary,
        isDeleted: false,
        isFromOverlay: true,
      };
    }

    // Fall back to base revisionFiles
    const baseFile = await ctx.db
      .query("revisionFiles")
      .withIndex("by_revision_path", (q) =>
        q
          .eq("revisionId", args.revisionId)
          .eq("parent", args.parent || undefined)
          .eq("name", args.name),
      )
      .first();

    if (!baseFile) {
      return null;
    }

    const content = await resolveInlineContent(baseFile);
    const downloadUrl = content === undefined ? await resolveFileDownloadUrl(ctx, baseFile) : undefined;
    return {
      name: baseFile.name,
      parent: baseFile.parent,
      content,
      blobId: baseFile.blobId,
      downloadUrl,
      binary: baseFile.binary,
      isDeleted: false,
      isFromOverlay: false,
    };
  },
});

/**
 * Write a file record to the session overlay (no storage access)
 */
export const writeRecord = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    parent: v.optional(v.string()),
    name: v.string(),
    content: v.optional(v.string()),
    blobId: v.optional(v.id("blobs")),
    binary: v.boolean(),
  },
  handler: async (ctx, args): Promise<Id<"sessionOverlayFiles">> => {
    // Check if file already exists in overlay
    const existing = await ctx.db
      .query("sessionOverlayFiles")
      .withIndex("by_session_path", (q) =>
        q
          .eq("sessionId", args.sessionId)
          .eq("parent", args.parent || undefined)
          .eq("name", args.name),
      )
      .first();

    if (existing) {
      // Update existing overlay entry
      await ctx.db.patch(existing._id, {
        content: args.content,
        blobId: args.blobId,
        binary: args.binary,
        isDeleted: false,
        updatedAt: Date.now(),
      });
      return existing._id;
    }

    // Create new overlay entry
    return await ctx.db.insert("sessionOverlayFiles", {
      sessionId: args.sessionId,
      name: args.name,
      parent: args.parent,
      content: args.content,
      blobId: args.blobId,
      binary: args.binary,
      isDeleted: false,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Write a file to the session overlay (does not modify base revisionFiles)
 */
export const write = internalAction({
  args: {
    sessionId: v.id("sessions"),
    parent: v.optional(v.string()),
    name: v.string(),
    content: v.optional(v.string()),
    blobId: v.optional(v.id("blobs")),
    storageId: v.optional(v.id("_storage")),
    hash: v.optional(v.string()),
    size: v.optional(v.number()),
    binary: v.boolean(),
  },
  handler: async (ctx, args): Promise<Id<"sessionOverlayFiles">> => {
    const session = await ctx.runQuery(internal.sessions.getSession, { sessionId: args.sessionId });
    if (!session) {
      throw new Error(`Session ${args.sessionId} not found`);
    }
    const revision = await ctx.runQuery(internal.revisions.getRevision, { revisionId: session.revisionId });
    if (!revision) {
      throw new Error("Revision not found");
    }

    let content = args.content;
    let blobId = args.blobId;

    if (!blobId && args.storageId) {
      if (!args.hash || args.size === undefined) {
        throw new Error("hash and size are required when providing storageId");
      }
      blobId = await ctx.runAction(internal.content.getOrCreateBlobFromStorage, {
        workspaceId: revision.workspaceId,
        hash: args.hash,
        storageId: args.storageId,
        size: args.size,
      });
    }

    if (!blobId && content !== undefined) {
      const stored = await storeFileContent(ctx, {
        workspaceId: revision.workspaceId,
        content,
        binary: args.binary,
      });
      content = stored.content;
      blobId = stored.blobId;
    }

    if (!blobId && content === undefined) {
      throw new Error("content, blobId, or storageId is required");
    }

    return await ctx.runMutation(internal.fs.overlay.writeRecord, {
      sessionId: args.sessionId,
      parent: args.parent,
      name: args.name,
      content,
      blobId,
      binary: args.binary,
    });
  },
});

/**
 * Delete a file in the session overlay (marks as deleted, doesn't remove from base)
 */
export const remove = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    parent: v.optional(v.string()),
    name: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"sessionOverlayFiles">> => {
    // Check if file already exists in overlay
    const existing = await ctx.db
      .query("sessionOverlayFiles")
      .withIndex("by_session_path", (q) =>
        q
          .eq("sessionId", args.sessionId)
          .eq("parent", args.parent || undefined)
          .eq("name", args.name),
      )
      .first();

    if (existing) {
      // Mark as deleted
      await ctx.db.patch(existing._id, {
        content: undefined,
        blobId: undefined,
        isDeleted: true,
        updatedAt: Date.now(),
      });
      return existing._id;
    }

    // Create deletion marker
    return await ctx.db.insert("sessionOverlayFiles", {
      sessionId: args.sessionId,
      name: args.name,
      parent: args.parent,
      content: undefined,
      blobId: undefined,
      binary: false,
      isDeleted: true,
      updatedAt: Date.now(),
    });
  },
});

/**
 * List all files in the overlayed filesystem (merges overlay with base)
 */
export const list = internalQuery({
  args: {
    sessionId: v.id("sessions"),
    revisionId: v.id("revisions"),
  },
  handler: async (ctx, args): Promise<string[]> => {
    // Get all base files
    const baseFiles = new Map<string, boolean>(); // path -> exists
    for await (const entry of ctx.db
      .query("revisionFiles")
      .withIndex("by_revision", (q) => q.eq("revisionId", args.revisionId))) {
      const path = entry.parent ? `${entry.parent}/${entry.name}` : entry.name;
      baseFiles.set(path, true);
    }

    // Apply overlay changes
    for await (const entry of ctx.db
      .query("sessionOverlayFiles")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))) {
      const path = entry.parent ? `${entry.parent}/${entry.name}` : entry.name;
      if (entry.isDeleted) {
        baseFiles.delete(path);
      } else {
        baseFiles.set(path, true);
      }
    }

    return Array.from(baseFiles.keys());
  },
});

/**
 * List files in a specific directory of the overlayed filesystem
 */
export const listDir = internalQuery({
  args: {
    sessionId: v.id("sessions"),
    revisionId: v.id("revisions"),
    parent: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<string[]> => {
    const files = new Map<string, boolean>(); // name -> exists

    // Get base files in directory
    for await (const entry of ctx.db
      .query("revisionFiles")
      .withIndex("by_revision_path", (q) =>
        q.eq("revisionId", args.revisionId).eq("parent", args.parent || undefined),
      )) {
      files.set(entry.name, true);
    }

    // Apply overlay changes for this directory
    for await (const entry of ctx.db
      .query("sessionOverlayFiles")
      .withIndex("by_session_path", (q) => q.eq("sessionId", args.sessionId).eq("parent", args.parent || undefined))) {
      if (entry.isDeleted) {
        files.delete(entry.name);
      } else {
        files.set(entry.name, true);
      }
    }

    return Array.from(files.keys());
  },
});

/**
 * Clear all overlay files for a session
 */
export const clear = internalMutation({
  args: {
    sessionId: v.id("sessions"),
  },
  handler: async (ctx, args): Promise<number> => {
    const files = await ctx.db
      .query("sessionOverlayFiles")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();

    for (const file of files) {
      await ctx.db.delete(file._id);
    }

    return files.length;
  },
});

/**
 * Get all overlay changes for a session (for inspection/debugging)
 */
export const getChanges = internalQuery({
  args: {
    sessionId: v.id("sessions"),
  },
  handler: async (ctx, args) => {
    const changes = await ctx.db
      .query("sessionOverlayFiles")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();

    return changes.map((c) => ({
      path: c.parent ? `${c.parent}/${c.name}` : c.name,
      isDeleted: c.isDeleted,
      hasContent: c.content !== undefined || c.blobId !== undefined,
      updatedAt: c.updatedAt,
    }));
  },
});

/**
 * List overlay entries for snapshot building (internal)
 */
export const listOverlayEntriesForSnapshot = internalQuery({
  args: {
    sessionId: v.id("sessions"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("sessionOverlayFiles")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
  },
});

/**
 * List revision filesystem entries for snapshot building (internal)
 */
export const listRevisionEntriesForSnapshot = internalQuery({
  args: {
    revisionId: v.id("revisions"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("revisionFiles")
      .withIndex("by_revision", (q) => q.eq("revisionId", args.revisionId))
      .collect();
  },
});

/**
 * Build a complete filesystem snapshot for a session (for just-bash integration)
 * Returns a map of path -> content for all files visible to the session
 */
export const buildSnapshot = internalAction({
  args: {
    sessionId: v.id("sessions"),
    revisionId: v.id("revisions"),
  },
  handler: async (ctx, args): Promise<Record<string, string>> => {
    const snapshot: Record<string, string> = {};
    const deletedPaths = new Set<string>();

    // First, collect all overlay changes
    const overlayEntries = await ctx.runQuery(internal.fs.overlay.listOverlayEntriesForSnapshot, {
      sessionId: args.sessionId,
    });
    for (const entry of overlayEntries) {
      const path = entry.parent ? `${entry.parent}/${entry.name}` : entry.name;
      if (entry.isDeleted) {
        deletedPaths.add(path);
      } else {
        const content = await loadFileContent(ctx, entry, { binary: entry.binary });
        if (content !== undefined) {
          snapshot[`/${path}`] = content;
        }
      }
    }

    // Then add base files that aren't deleted or overwritten
    const revisionEntries = await ctx.runQuery(internal.fs.overlay.listRevisionEntriesForSnapshot, {
      revisionId: args.revisionId,
    });
    for (const entry of revisionEntries) {
      const path = entry.parent ? `${entry.parent}/${entry.name}` : entry.name;
      const fullPath = `/${path}`;
      if (!deletedPaths.has(path) && !(fullPath in snapshot)) {
        const content = await loadFileContent(ctx, entry, { binary: entry.binary });
        if (content !== undefined) {
          snapshot[fullPath] = content;
        }
      }
    }

    return snapshot;
  },
});

// ============================================================================
// Public Queries/Mutations for ConvexFs client
// ============================================================================

/**
 * Read a file from the overlayed filesystem (public API for ConvexFs)
 */
export const readFile = query({
  args: {
    sessionId: v.id("sessions"),
    path: v.string(),
  },
  handler: async (ctx, args): Promise<{ content?: string; downloadUrl?: string; binary: boolean } | null> => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error(`Session ${args.sessionId} not found`);
    }
    const { parent, name } = parsePath(args.path);

    // First check the session overlay
    const overlayFile = await ctx.db
      .query("sessionOverlayFiles")
      .withIndex("by_session_path", (q) => q.eq("sessionId", args.sessionId).eq("parent", parent).eq("name", name))
      .first();

    if (overlayFile) {
      if (overlayFile.isDeleted) {
        return null;
      }
      const content = await resolveInlineContent(overlayFile);
      const downloadUrl = content === undefined ? await resolveFileDownloadUrl(ctx, overlayFile) : undefined;
      if (content === undefined && !downloadUrl) {
        return null;
      }
      return {
        content,
        binary: overlayFile.binary,
        downloadUrl,
      };
    }

    // Fall back to base revisionFiles
    const baseFile = await ctx.db
      .query("revisionFiles")
      .withIndex("by_revision_path", (q) =>
        q.eq("revisionId", session.revisionId).eq("parent", parent).eq("name", name),
      )
      .first();

    if (!baseFile) {
      return null;
    }

    const content = await resolveInlineContent(baseFile);
    const downloadUrl = content === undefined ? await resolveFileDownloadUrl(ctx, baseFile) : undefined;
    if (content === undefined && !downloadUrl) {
      return null;
    }
    return {
      content,
      binary: baseFile.binary,
      downloadUrl,
    };
  },
});

/**
 * Get upload metadata for a file write (public API for ConvexFs)
 */
export const getUploadMetadata = action({
  args: {
    sessionId: v.id("sessions"),
    hash: v.string(),
    size: v.number(),
    binary: v.boolean(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    { kind: "inline" } | { kind: "existing"; blobId: Id<"blobs"> } | { kind: "upload"; uploadUrl: string }
  > => {
    const session: Doc<"sessions"> | null = await ctx.runQuery(internal.sessions.getSession, {
      sessionId: args.sessionId,
    });
    if (!session) {
      throw new Error(`Session ${args.sessionId} not found`);
    }
    const revision: Doc<"revisions"> | null = await ctx.runQuery(internal.revisions.getRevision, {
      revisionId: session.revisionId,
    });
    if (!revision) {
      throw new Error("Revision not found");
    }

    const existing: Doc<"blobs"> | null = await ctx.runQuery(internal.content.getBlobByHash, {
      workspaceId: revision.workspaceId,
      hash: args.hash,
    });

    if (existing) {
      return { kind: "existing" as const, blobId: existing._id };
    }

    if (!args.binary && args.size <= INLINE_CONTENT_MAX_CHARS) {
      return { kind: "inline" as const };
    }

    const uploadUrl = await ctx.storage.generateUploadUrl();
    return { kind: "upload" as const, uploadUrl };
  },
});

/**
 * Check if a file exists in the overlayed filesystem (public API for ConvexFs)
 */
export const fileExists = query({
  args: {
    sessionId: v.id("sessions"),
    path: v.string(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error(`Session ${args.sessionId} not found`);
    }
    const { parent, name } = parsePath(args.path);

    // First check the session overlay
    const overlayFile = await ctx.db
      .query("sessionOverlayFiles")
      .withIndex("by_session_path", (q) => q.eq("sessionId", args.sessionId).eq("parent", parent).eq("name", name))
      .first();

    if (overlayFile) {
      return !overlayFile.isDeleted;
    }

    // Fall back to base revisionFiles
    const baseFile = await ctx.db
      .query("revisionFiles")
      .withIndex("by_revision_path", (q) =>
        q.eq("revisionId", session.revisionId).eq("parent", parent).eq("name", name),
      )
      .first();

    return baseFile !== null;
  },
});

/**
 * Get file stat information (public API for ConvexFs)
 */
export const fileStat = query({
  args: {
    sessionId: v.id("sessions"),
    path: v.string(),
  },
  handler: async (ctx, args): Promise<{ isFile: boolean; isDirectory: boolean; size: number } | null> => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error(`Session ${args.sessionId} not found`);
    }
    const { parent, name } = parsePath(args.path);

    // First check the session overlay
    const overlayFile = await ctx.db
      .query("sessionOverlayFiles")
      .withIndex("by_session_path", (q) => q.eq("sessionId", args.sessionId).eq("parent", parent).eq("name", name))
      .first();

    if (overlayFile) {
      if (overlayFile.isDeleted) {
        return null;
      }
      return {
        isFile: true,
        isDirectory: false,
        size: await resolveFileSize(ctx, overlayFile),
      };
    }

    // Fall back to base revisionFiles
    const baseFile = await ctx.db
      .query("revisionFiles")
      .withIndex("by_revision_path", (q) =>
        q.eq("revisionId", session.revisionId).eq("parent", parent).eq("name", name),
      )
      .first();

    if (!baseFile) {
      // Check if it's a directory by looking for files with this path as parent
      const childInOverlay = await ctx.db
        .query("sessionOverlayFiles")
        .withIndex("by_session_path", (q) => q.eq("sessionId", args.sessionId).eq("parent", args.path))
        .first();

      const childInBase = await ctx.db
        .query("revisionFiles")
        .withIndex("by_revision_path", (q) => q.eq("revisionId", session.revisionId).eq("parent", args.path))
        .first();

      if (childInOverlay || childInBase) {
        return {
          isFile: false,
          isDirectory: true,
          size: 0,
        };
      }

      return null;
    }

    return {
      isFile: true,
      isDirectory: false,
      size: await resolveFileSize(ctx, baseFile),
    };
  },
});

/**
 * List all files in the overlayed filesystem (public API for ConvexFs)
 */
export const listAllFiles = query({
  args: {
    sessionId: v.id("sessions"),
  },
  handler: async (ctx, args): Promise<string[]> => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error(`Session ${args.sessionId} not found`);
    }

    // Get all base files
    const baseFiles = new Map<string, boolean>();
    for await (const entry of ctx.db
      .query("revisionFiles")
      .withIndex("by_revision", (q) => q.eq("revisionId", session.revisionId))) {
      const path = entry.parent ? `${entry.parent}/${entry.name}` : entry.name;
      baseFiles.set(path, true);
    }

    // Apply overlay changes
    for await (const entry of ctx.db
      .query("sessionOverlayFiles")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))) {
      const path = entry.parent ? `${entry.parent}/${entry.name}` : entry.name;
      if (entry.isDeleted) {
        baseFiles.delete(path);
      } else {
        baseFiles.set(path, true);
      }
    }

    return Array.from(baseFiles.keys());
  },
});

/**
 * List files in a specific directory (public API for ConvexFs)
 * Returns entries with type information for efficient directory listing
 */
export const listDirectory = query({
  args: {
    sessionId: v.id("sessions"),
    parent: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Array<{ name: string; type: "file" | "directory" }>> => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error(`Session ${args.sessionId} not found`);
    }
    const files = new Map<string, "file" | "directory">();

    // Get base files in directory
    for await (const entry of ctx.db
      .query("revisionFiles")
      .withIndex("by_revision_path", (q) => q.eq("revisionId", session.revisionId).eq("parent", args.parent))) {
      files.set(entry.name, "file");
    }

    // Apply overlay changes for this directory
    for await (const entry of ctx.db
      .query("sessionOverlayFiles")
      .withIndex("by_session_path", (q) => q.eq("sessionId", args.sessionId).eq("parent", args.parent))) {
      if (entry.isDeleted) {
        files.delete(entry.name);
      } else {
        files.set(entry.name, "file");
      }
    }

    // Find directories by looking for files with parent paths that start with current path
    const currentPath = args.parent ?? "";
    const prefix = currentPath ? `${currentPath}/` : "";

    // Check base files for subdirectories
    for await (const entry of ctx.db
      .query("revisionFiles")
      .withIndex("by_revision", (q) => q.eq("revisionId", session.revisionId))) {
      if (entry.parent?.startsWith(prefix)) {
        const rest = entry.parent.slice(prefix.length);
        const dirName = rest.split("/")[0];
        if (dirName && !files.has(dirName)) {
          files.set(dirName, "directory");
        }
      }
    }

    // Check overlay files for subdirectories
    for await (const entry of ctx.db
      .query("sessionOverlayFiles")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))) {
      if (entry.parent?.startsWith(prefix) && !entry.isDeleted) {
        const rest = entry.parent.slice(prefix.length);
        const dirName = rest.split("/")[0];
        if (dirName && !files.has(dirName)) {
          files.set(dirName, "directory");
        }
      }
    }

    return Array.from(files.entries())
      .map(([name, type]) => ({ name, type }))
      .sort((a, b) => {
        // Directories first, then alphabetically
        if (a.type === "directory" && b.type === "file") return -1;
        if (a.type === "file" && b.type === "directory") return 1;
        return a.name.localeCompare(b.name);
      });
  },
});

/**
 * Write a file to the session overlay (public API for ConvexFs)
 */
export const writeFile = action({
  args: {
    sessionId: v.id("sessions"),
    path: v.string(),
    content: v.optional(v.string()),
    blobId: v.optional(v.id("blobs")),
    storageId: v.optional(v.id("_storage")),
    hash: v.optional(v.string()),
    size: v.optional(v.number()),
    binary: v.boolean(),
  },
  handler: async (ctx, args): Promise<Id<"sessionOverlayFiles">> => {
    const { parent, name } = parsePath(args.path);
    return await ctx.runAction(internal.fs.overlay.write, {
      sessionId: args.sessionId,
      parent,
      name,
      content: args.content,
      blobId: args.blobId,
      storageId: args.storageId,
      hash: args.hash,
      size: args.size,
      binary: args.binary,
    });
  },
});

/**
 * Delete a file in the session overlay (public API for ConvexFs)
 */
export const deleteFile = mutation({
  args: {
    sessionId: v.id("sessions"),
    path: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error(`Session ${args.sessionId} not found`);
    }
    const { parent, name } = parsePath(args.path);

    // Check if file already exists in overlay
    const existing = await ctx.db
      .query("sessionOverlayFiles")
      .withIndex("by_session_path", (q) => q.eq("sessionId", args.sessionId).eq("parent", parent).eq("name", name))
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

    // Create deletion marker
    return await ctx.db.insert("sessionOverlayFiles", {
      sessionId: args.sessionId,
      name,
      parent,
      content: undefined,
      blobId: undefined,
      binary: false,
      isDeleted: true,
      updatedAt: Date.now(),
    });
  },
});
