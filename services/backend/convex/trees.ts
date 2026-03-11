/**
 * Tree operations for workspace filesystem.
 * Handles tree traversal, file listing, and materialization.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, query } from "./_generated/server";
import { requireWorkspaceMember } from "./authz";

export type TreeEntry = {
  name: string;
  type: "file" | "directory";
  blobId?: Id<"blobs">;
  treeId?: Id<"trees">;
};

export type FlatFile = {
  path: string;
  blobId: Id<"blobs">;
};

// ============================================================================
// Tree Queries
// ============================================================================

/**
 * Get a tree by ID
 */
export const getTree = query({
  args: {
    treeId: v.id("trees"),
  },
  handler: async (ctx, args) => {
    const tree = await ctx.db.get(args.treeId);
    if (!tree) {
      return null;
    }
    await requireWorkspaceMember(ctx, tree.workspaceId);
    return tree;
  },
});

/**
 * Get tree for a commit
 */
export const getTreeForCommit = query({
  args: {
    commitId: v.id("commits"),
  },
  handler: async (ctx, args) => {
    const commit = await ctx.db.get(args.commitId);
    if (!commit) {
      throw new Error("Commit not found");
    }
    await requireWorkspaceMember(ctx, commit.workspaceId);
    return await ctx.db.get(commit.treeId);
  },
});

/**
 * List entries in a directory within a tree
 */
export const listDirectory = query({
  args: {
    treeId: v.id("trees"),
    path: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let currentTree = await ctx.db.get(args.treeId);
    if (!currentTree) {
      throw new Error("Tree not found");
    }
    await requireWorkspaceMember(ctx, currentTree.workspaceId);

    // Navigate to the requested path
    if (args.path) {
      const parts = args.path.split("/").filter((p) => p.length > 0);

      for (const part of parts) {
        if (!currentTree) {
          throw new Error("Tree not found");
        }
        const entry: TreeEntry | undefined = currentTree.entries.find(
          (e: TreeEntry) => e.name === part && e.type === "directory",
        );
        if (!entry || !entry.treeId) {
          throw new Error(`Directory not found: ${args.path}`);
        }
        const nextTree: Doc<"trees"> | null = await ctx.db.get(entry.treeId);
        if (!nextTree) {
          throw new Error(`Tree not found for directory: ${part}`);
        }
        currentTree = nextTree;
      }
    }

    if (!currentTree) {
      throw new Error("Tree not found");
    }
    return currentTree.entries;
  },
});

/**
 * Flatten a tree into a list of all files with their paths (internal)
 */
export const flattenTree = internalQuery({
  args: {
    treeId: v.id("trees"),
  },
  handler: async (ctx, args): Promise<FlatFile[]> => {
    return await flattenTreeHandler(ctx, args.treeId);
  },
});

/**
 * Flatten a tree into a list of all files with their paths (public)
 */
export const getFlattenedTree = query({
  args: {
    treeId: v.id("trees"),
  },
  handler: async (ctx, args): Promise<FlatFile[]> => {
    const tree = await ctx.db.get(args.treeId);
    if (!tree) {
      throw new Error("Tree not found");
    }
    await requireWorkspaceMember(ctx, tree.workspaceId);
    return await flattenTreeHandler(ctx, args.treeId);
  },
});

// Shared handler for flattening trees
async function flattenTreeHandler(ctx: any, treeId: Id<"trees">): Promise<FlatFile[]> {
  const files: FlatFile[] = [];

  async function traverse(currentTreeId: Id<"trees">, prefix: string) {
    const tree = await ctx.db.get(currentTreeId);
    if (!tree) return;

    for (const entry of tree.entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.type === "file" && entry.blobId) {
        files.push({ path, blobId: entry.blobId });
      } else if (entry.type === "directory" && entry.treeId) {
        await traverse(entry.treeId, path);
      }
    }
  }

  await traverse(treeId, "");
  return files;
}

/**
 * Get file content from a tree by path
 */
export const getFileFromTree = query({
  args: {
    treeId: v.id("trees"),
    path: v.string(),
  },
  handler: async (ctx, args) => {
    const parts = args.path.split("/").filter((p) => p.length > 0);
    if (parts.length === 0) {
      throw new Error("Invalid path");
    }

    const fileName = parts[parts.length - 1];
    const dirParts = parts.slice(0, -1);

    // Navigate to parent directory
    let currentTree = await ctx.db.get(args.treeId);
    if (!currentTree) {
      throw new Error("Tree not found");
    }
    await requireWorkspaceMember(ctx, currentTree.workspaceId);

    for (const part of dirParts) {
      if (!currentTree) {
        return null;
      }
      const entry: TreeEntry | undefined = currentTree.entries.find(
        (e: TreeEntry) => e.name === part && e.type === "directory",
      );
      if (!entry || !entry.treeId) {
        return null; // Directory not found
      }
      const nextTree: Doc<"trees"> | null = await ctx.db.get(entry.treeId);
      if (!nextTree) {
        return null;
      }
      currentTree = nextTree;
    }

    if (!currentTree) {
      return null;
    }
    // Find the file
    const fileEntry: TreeEntry | undefined = currentTree.entries.find(
      (e: TreeEntry) => e.name === fileName && e.type === "file",
    );
    if (!fileEntry || !fileEntry.blobId) {
      return null;
    }

    // Get blob content or URL
    const blob = await ctx.db.get(fileEntry.blobId);
    if (!blob) {
      return null;
    }

    if (blob.content !== undefined) {
      return {
        path: args.path,
        content: blob.content,
        size: blob.size,
        blobId: fileEntry.blobId,
      };
    }

    if (!blob.storageId) {
      return null;
    }

    const downloadUrl = await ctx.storage.getUrl(blob.storageId);
    if (!downloadUrl) {
      return null;
    }

    return {
      path: args.path,
      content: undefined,
      size: blob.size,
      blobId: fileEntry.blobId,
      downloadUrl,
    };
  },
});

/**
 * Check if a path exists in a tree
 */
export const pathExists = query({
  args: {
    treeId: v.id("trees"),
    path: v.string(),
  },
  handler: async (ctx, args) => {
    const tree = await ctx.db.get(args.treeId);
    if (!tree) {
      return { exists: false, type: null };
    }
    await requireWorkspaceMember(ctx, tree.workspaceId);

    const parts = args.path.split("/").filter((p) => p.length > 0);
    if (parts.length === 0) {
      return { exists: true, type: "directory" as const };
    }

    let currentTree = tree;
    if (!currentTree) {
      return { exists: false, type: null };
    }

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;

      if (!currentTree) {
        return { exists: false, type: null };
      }

      const entry: TreeEntry | undefined = currentTree.entries.find((e: TreeEntry) => e.name === part);
      if (!entry) {
        return { exists: false, type: null };
      }

      if (isLast) {
        return { exists: true, type: entry.type };
      }

      if (entry.type !== "directory" || !entry.treeId) {
        return { exists: false, type: null };
      }

      const nextTree: Doc<"trees"> | null = await ctx.db.get(entry.treeId);
      if (!nextTree) {
        return { exists: false, type: null };
      }
      currentTree = nextTree;
    }

    return { exists: false, type: null };
  },
});

/**
 * Get all files in a tree as a flat list (for revision filesystem generation)
 */
export const getAllFiles = internalQuery({
  args: {
    treeId: v.id("trees"),
  },
  handler: async (ctx, args) => {
    const files: Array<{ path: string; content?: string; downloadUrl?: string; size: number }> = [];

    async function traverse(treeId: Id<"trees">, prefix: string) {
      const tree = await ctx.db.get(treeId);
      if (!tree) return;

      for (const entry of tree.entries) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;

        if (entry.type === "file" && entry.blobId) {
          const blob = await ctx.db.get(entry.blobId);
          if (!blob) continue;
          if (blob.content !== undefined) {
            files.push({ path, content: blob.content, size: blob.size });
            continue;
          }
          if (blob.storageId) {
            const downloadUrl = await ctx.storage.getUrl(blob.storageId);
            if (downloadUrl) {
              files.push({ path, downloadUrl, size: blob.size });
            }
          }
        } else if (entry.type === "directory" && entry.treeId) {
          await traverse(entry.treeId, path);
        }
      }
    }

    await traverse(args.treeId, "");
    return files;
  },
});

/**
 * Get file tree structure for UI display
 */
export const getFileTreeStructure = query({
  args: {
    treeId: v.id("trees"),
  },
  handler: async (ctx, args) => {
    const tree = await ctx.db.get(args.treeId);
    if (!tree) {
      throw new Error("Tree not found");
    }
    await requireWorkspaceMember(ctx, tree.workspaceId);

    type FileTreeNode = {
      name: string;
      path: string;
      type: "file" | "directory";
      children?: FileTreeNode[];
      blobId?: Id<"blobs">;
    };

    async function buildNode(treeId: Id<"trees">, prefix: string): Promise<FileTreeNode[]> {
      const tree = await ctx.db.get(treeId);
      if (!tree) return [];

      const nodes: FileTreeNode[] = [];

      for (const entry of tree.entries) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;

        if (entry.type === "file") {
          nodes.push({
            name: entry.name,
            path,
            type: "file",
            blobId: entry.blobId,
          });
        } else if (entry.type === "directory" && entry.treeId) {
          nodes.push({
            name: entry.name,
            path,
            type: "directory",
            children: await buildNode(entry.treeId, path),
          });
        }
      }

      // Sort: directories first, then files, both alphabetically
      return nodes.sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === "directory" ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
    }

    return await buildNode(args.treeId, "");
  },
});

/**
 * Get file content from a specific commit by path (for diff comparison)
 */
export const getFileContentForDiff = query({
  args: {
    commitId: v.id("commits"),
    path: v.string(),
  },
  handler: async (ctx, args) => {
    const commit = await ctx.db.get(args.commitId);
    if (!commit) {
      return null;
    }
    await requireWorkspaceMember(ctx, commit.workspaceId);

    const parts = args.path.split("/").filter((p) => p.length > 0);
    if (parts.length === 0) {
      return null;
    }

    const fileName = parts[parts.length - 1];
    const dirParts = parts.slice(0, -1);

    // Navigate to parent directory
    let currentTree = await ctx.db.get(commit.treeId);
    if (!currentTree) {
      return null;
    }

    for (const part of dirParts) {
      if (!currentTree) {
        return null;
      }
      const entry: TreeEntry | undefined = currentTree.entries.find(
        (e: TreeEntry) => e.name === part && e.type === "directory",
      );
      if (!entry || !entry.treeId) {
        return null;
      }
      const nextTree: Doc<"trees"> | null = await ctx.db.get(entry.treeId);
      if (!nextTree) {
        return null;
      }
      currentTree = nextTree;
    }

    if (!currentTree) {
      return null;
    }

    // Find the file
    const fileEntry: TreeEntry | undefined = currentTree.entries.find(
      (e: TreeEntry) => e.name === fileName && e.type === "file",
    );
    if (!fileEntry || !fileEntry.blobId) {
      return null;
    }

    // Get blob content or URL
    const blob = await ctx.db.get(fileEntry.blobId);
    if (!blob) {
      return null;
    }

    if (blob.content !== undefined) {
      return { content: blob.content };
    }

    if (!blob.storageId) {
      return null;
    }

    const downloadUrl = await ctx.storage.getUrl(blob.storageId);
    if (!downloadUrl) {
      return null;
    }

    return { content: undefined, downloadUrl };
  },
});

/**
 * Get file tree structure including working directory changes
 */
export const getFileTreeWithChanges = query({
  args: {
    branchId: v.id("branches"),
  },
  handler: async (ctx, args) => {
    const branch = await ctx.db.get(args.branchId);
    if (!branch) {
      throw new Error("Branch not found");
    }
    const { user } = await requireWorkspaceMember(ctx, branch.workspaceId);

    const commit = await ctx.db.get(branch.commitId);
    if (!commit) {
      throw new Error("Commit not found");
    }

    // Get base tree files
    const baseFiles = await ctx.runQuery(internal.trees.flattenTree, {
      treeId: commit.treeId,
    });

    // Get working directory changes
    const workingFiles = await ctx.db
      .query("workingFiles")
      .withIndex("by_branch_user", (q) => q.eq("branchId", args.branchId).eq("userId", user.subject))
      .collect();

    // Build combined file list
    const fileMap = new Map<string, { path: string; status: "unchanged" | "modified" | "added" | "deleted" }>();

    // Add base files
    for (const file of baseFiles) {
      fileMap.set(file.path, { path: file.path, status: "unchanged" });
    }

    // Apply working changes
    for (const change of workingFiles) {
      if (change.isDeleted) {
        if (fileMap.has(change.path)) {
          fileMap.set(change.path, { path: change.path, status: "deleted" });
        }
      } else {
        const existing = fileMap.get(change.path);
        if (existing) {
          fileMap.set(change.path, { path: change.path, status: "modified" });
        } else {
          fileMap.set(change.path, { path: change.path, status: "added" });
        }
      }
    }

    // Build tree structure
    type FileTreeNode = {
      name: string;
      path: string;
      type: "file" | "directory";
      status?: "unchanged" | "modified" | "added" | "deleted";
      children?: FileTreeNode[];
    };

    const root: FileTreeNode = { name: "", path: "", type: "directory", children: [] };

    for (const [path, file] of fileMap) {
      if (file.status === "deleted") continue; // Don't show deleted files

      const parts = path.split("/");
      let current = root;

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        const isLast = i === parts.length - 1;
        const currentPath = parts.slice(0, i + 1).join("/");

        if (!current.children) {
          current.children = [];
        }

        let child = current.children.find((c) => c.name === part);
        if (!child) {
          child = {
            name: part,
            path: currentPath,
            type: isLast ? "file" : "directory",
            status: isLast ? file.status : undefined,
            children: isLast ? undefined : [],
          };
          current.children.push(child);
        }

        if (!isLast) {
          current = child!;
        } else {
          child!.status = file.status;
        }
      }
    }

    // Sort function
    function sortTree(node: FileTreeNode) {
      if (node.children) {
        node.children.sort((a, b) => {
          if (a.type !== b.type) {
            return a.type === "directory" ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        });
        for (const child of node.children) {
          sortTree(child);
        }
      }
    }

    sortTree(root);
    return root.children ?? [];
  },
});
