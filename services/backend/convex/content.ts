/**
 * Content-addressed storage utilities for workspace filesystem.
 * Uses SHA-256 hashing for deduplication of blobs and trees.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";

// ============================================================================
// Hash Utilities
// ============================================================================

/**
 * Compute SHA-256 hash of content (browser/Node.js compatible)
 */
export async function hashContent(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Compute hash for a tree based on its sorted entries
 */
export async function hashTree(
  entries: Array<{
    name: string;
    type: "file" | "directory";
    blobId?: Id<"blobs">;
    treeId?: Id<"trees">;
  }>,
): Promise<string> {
  // Sort entries by name for consistent hashing
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));

  // Create a deterministic string representation
  const repr = sorted
    .map((e) => {
      const ref = e.type === "file" ? e.blobId : e.treeId;
      return `${e.type}:${e.name}:${ref}`;
    })
    .join("\n");

  return hashContent(repr);
}

// ============================================================================
// Blob Operations
// ============================================================================

export type TreeEntry = {
  name: string;
  type: "file" | "directory";
  blobId?: Id<"blobs">;
  treeId?: Id<"trees">;
};

const INLINE_BLOB_MAX_CHARS = 32_768;

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Get or create a blob with the given content.
 * Returns existing blob if content already exists (deduplication).
 */
export const getOrCreateBlob = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    content: v.string(),
    binary: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<Id<"blobs">> => {
    const hash = await hashContent(args.content);

    // Check if blob already exists
    const existing = await ctx.runQuery(internal.content.getBlobByHash, {
      workspaceId: args.workspaceId,
      hash,
    });

    if (existing) {
      return existing._id;
    }

    // Create new blob
    const bytes = args.binary ? base64ToBytes(args.content) : new TextEncoder().encode(args.content);
    const buffer = new Uint8Array(bytes).buffer;
    const blob = new Blob([buffer], {
      type: args.binary ? "application/octet-stream" : "text/plain; charset=utf-8",
    });
    const storageId = await ctx.storage.store(blob);
    const inlineContent = !args.binary && args.content.length <= INLINE_BLOB_MAX_CHARS ? args.content : undefined;

    const blobId: Id<"blobs"> = await ctx.runMutation(internal.content.insertBlobRecord, {
      workspaceId: args.workspaceId,
      hash,
      storageId,
      size: bytes.length,
      content: inlineContent,
    });
    return blobId;
  },
});

/**
 * Get or create a blob from an already uploaded storage object.
 * Returns existing blob if content already exists (deduplication).
 */
export const getOrCreateBlobFromStorage = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    hash: v.string(),
    storageId: v.id("_storage"),
    size: v.number(),
  },
  handler: async (ctx, args): Promise<Id<"blobs">> => {
    const existing = await ctx.runQuery(internal.content.getBlobByHash, {
      workspaceId: args.workspaceId,
      hash: args.hash,
    });

    if (existing) {
      return existing._id;
    }

    return await ctx.runMutation(internal.content.insertBlobRecord, {
      workspaceId: args.workspaceId,
      hash: args.hash,
      storageId: args.storageId,
      size: args.size,
      content: undefined,
    });
  },
});

export const insertBlobRecord = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    hash: v.string(),
    storageId: v.id("_storage"),
    size: v.number(),
    content: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"blobs">> => {
    return await ctx.db.insert("blobs", {
      workspaceId: args.workspaceId,
      hash: args.hash,
      storageId: args.storageId,
      size: args.size,
      content: args.content,
    });
  },
});

/**
 * Get a blob by ID
 */
export const getBlob = internalQuery({
  args: {
    blobId: v.id("blobs"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.blobId);
  },
});

/**
 * Get a blob by hash
 */
export const getBlobByHash = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    hash: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("blobs")
      .withIndex("by_hash", (q) => q.eq("workspaceId", args.workspaceId).eq("hash", args.hash))
      .first();
  },
});

// ============================================================================
// Tree Operations
// ============================================================================

/**
 * Get or create a tree with the given entries.
 * Returns existing tree if structure already exists (deduplication).
 */
export const getOrCreateTree = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    entries: v.array(
      v.object({
        name: v.string(),
        type: v.union(v.literal("file"), v.literal("directory")),
        blobId: v.optional(v.id("blobs")),
        treeId: v.optional(v.id("trees")),
      }),
    ),
  },
  handler: async (ctx, args): Promise<Id<"trees">> => {
    const hash = await hashTree(args.entries);

    // Check if tree already exists
    const existing = await ctx.db
      .query("trees")
      .withIndex("by_hash", (q) => q.eq("workspaceId", args.workspaceId).eq("hash", hash))
      .first();

    if (existing) {
      return existing._id;
    }

    // Create new tree with sorted entries
    const sortedEntries = [...args.entries].sort((a, b) => a.name.localeCompare(b.name));

    return await ctx.db.insert("trees", {
      workspaceId: args.workspaceId,
      hash,
      entries: sortedEntries,
    });
  },
});

/**
 * Get a tree by ID
 */
export const getTree = internalQuery({
  args: {
    treeId: v.id("trees"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.treeId);
  },
});

/**
 * Get a tree by hash
 */
export const getTreeByHash = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    hash: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("trees")
      .withIndex("by_hash", (q) => q.eq("workspaceId", args.workspaceId).eq("hash", args.hash))
      .first();
  },
});

/**
 * Create an empty tree (for new workspaces/branches)
 */
export const createEmptyTree = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args): Promise<Id<"trees">> => {
    const hash = await hashTree([]);

    // Check if empty tree already exists
    const existing = await ctx.db
      .query("trees")
      .withIndex("by_hash", (q) => q.eq("workspaceId", args.workspaceId).eq("hash", hash))
      .first();

    if (existing) {
      return existing._id;
    }

    return await ctx.db.insert("trees", {
      workspaceId: args.workspaceId,
      hash,
      entries: [],
    });
  },
});

// ============================================================================
// Tree Manipulation
// ============================================================================

/**
 * Build a new tree by applying file changes to an existing tree.
 * This is used when creating commits from working directory changes.
 */
export const buildTreeFromChanges = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    baseTreeId: v.optional(v.id("trees")),
    changes: v.array(
      v.object({
        path: v.string(), // e.g., "src/capabilities/splunk/capability.ts"
        content: v.optional(v.string()), // null/undefined means delete
        blobId: v.optional(v.id("blobs")),
        binary: v.optional(v.boolean()),
        isDeleted: v.boolean(),
      }),
    ),
  },
  handler: async (ctx, args): Promise<Id<"trees">> => {
    // Build a nested structure for easier manipulation
    type FileNode = { type: "file"; blobId: Id<"blobs"> };
    type DirNode = { type: "directory"; children: Map<string, FileNode | DirNode> };
    type Node = FileNode | DirNode;

    // Helper to recursively load tree structure
    async function loadTree(treeId: Id<"trees">): Promise<DirNode> {
      const tree = await ctx.runQuery(internal.content.getTree, { treeId });
      if (!tree) {
        return { type: "directory", children: new Map() };
      }

      const children = new Map<string, Node>();
      for (const entry of tree.entries) {
        if (entry.type === "file" && entry.blobId) {
          children.set(entry.name, { type: "file", blobId: entry.blobId });
        } else if (entry.type === "directory" && entry.treeId) {
          children.set(entry.name, await loadTree(entry.treeId));
        }
      }
      return { type: "directory", children };
    }

    // Load the base tree structure
    const root: DirNode = args.baseTreeId
      ? await loadTree(args.baseTreeId)
      : { type: "directory", children: new Map() };

    // Apply changes
    for (const change of args.changes) {
      const parts = change.path.split("/").filter((p) => p.length > 0);
      if (parts.length === 0) continue;

      if (change.isDeleted) {
        // Delete file/directory
        let current: DirNode = root;
        for (let i = 0; i < parts.length - 1; i++) {
          const child = current.children.get(parts[i]!);
          if (!child || child.type !== "directory") break;
          current = child;
        }
        current.children.delete(parts[parts.length - 1]!);
      } else if (change.blobId || change.content !== undefined) {
        // Create/update file
        const blobId: Id<"blobs"> = change.blobId
          ? change.blobId
          : await ctx.runAction(internal.content.getOrCreateBlob, {
              workspaceId: args.workspaceId,
              content: change.content ?? "",
              binary: change.binary,
            });

        // Ensure parent directories exist
        let current: DirNode = root;
        for (let i = 0; i < parts.length - 1; i++) {
          const dirName = parts[i]!;
          let child = current.children.get(dirName);
          if (!child || child.type !== "directory") {
            child = { type: "directory", children: new Map() };
            current.children.set(dirName, child);
          }
          current = child;
        }

        // Set the file
        current.children.set(parts[parts.length - 1]!, { type: "file", blobId });
      }
    }

    // Convert structure back to trees (bottom-up)
    async function saveTree(node: DirNode): Promise<Id<"trees">> {
      const entries: TreeEntry[] = [];

      for (const [name, child] of node.children) {
        if (child.type === "file") {
          entries.push({ name, type: "file", blobId: child.blobId });
        } else {
          const childTreeId = await saveTree(child);
          entries.push({ name, type: "directory", treeId: childTreeId });
        }
      }

      return await ctx.runMutation(internal.content.getOrCreateTree, {
        workspaceId: args.workspaceId,
        entries,
      });
    }

    return await saveTree(root);
  },
});
