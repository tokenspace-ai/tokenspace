/**
 * Version Control System operations for workspace filesystem.
 * Handles commits, branches, and history.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requireAuthenticatedUser, requireWorkspaceAdmin, requireWorkspaceMember } from "./authz";

const REMOTE_CONTENT_FETCH_TIMEOUT_MS = 10_000;

// ============================================================================
// Commit Operations
// ============================================================================

/**
 * Create a new commit from working directory changes
 */
export const createCommit = action({
  args: {
    workspaceId: v.id("workspaces"),
    branchId: v.id("branches"),
    message: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"commits">> => {
    const { user } = await requireWorkspaceAdmin(ctx, args.workspaceId);

    return await createCommitHandler(ctx, {
      workspaceId: args.workspaceId,
      branchId: args.branchId,
      authorId: user.subject,
      workingOwnerId: user.subject,
      message: args.message,
    });
  },
});

export const createCommitInternal = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    branchId: v.id("branches"),
    userId: v.string(),
    message: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"commits">> => {
    return await createCommitHandler(ctx, {
      workspaceId: args.workspaceId,
      branchId: args.branchId,
      authorId: args.userId,
      workingOwnerId: args.userId,
      message: args.message,
    });
  },
});

export const createCommitForOwnerInternal = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    branchId: v.id("branches"),
    authorId: v.string(),
    workingOwnerId: v.string(),
    message: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"commits">> => {
    return await createCommitHandler(ctx, args);
  },
});

async function createCommitHandler(
  ctx: any,
  args: {
    workspaceId: Id<"workspaces">;
    branchId: Id<"branches">;
    authorId: string;
    workingOwnerId: string;
    message: string;
  },
): Promise<Id<"commits">> {
  const branch = await ctx.runQuery(internal.vcs.getBranchInternal, { branchId: args.branchId });
  if (!branch) {
    throw new Error("Branch not found");
  }
  if (branch.workspaceId !== args.workspaceId) {
    throw new Error("Branch does not belong to this workspace");
  }

  const currentCommit = await ctx.runQuery(internal.vcs.getCommitInternal, { commitId: branch.commitId });
  if (!currentCommit) {
    throw new Error("Current commit not found");
  }

  const changes: Array<{
    path: string;
    content?: string;
    blobId?: Id<"blobs">;
    downloadUrl?: string;
    isDeleted: boolean;
  }> = await ctx.runQuery(internal.fs.working.getChanges, {
    branchId: args.branchId,
    userId: args.workingOwnerId,
  });

  if (changes.length === 0) {
    throw new Error("No changes to commit");
  }

  const normalizedChanges = [];
  for (const change of changes) {
    if (change.isDeleted) {
      normalizedChanges.push({ path: change.path, isDeleted: true });
      continue;
    }
    if (change.blobId) {
      normalizedChanges.push({ path: change.path, blobId: change.blobId, isDeleted: false });
      continue;
    }
    if (change.content !== undefined) {
      normalizedChanges.push({ path: change.path, content: change.content, isDeleted: false });
      continue;
    }
    if (change.downloadUrl) {
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), REMOTE_CONTENT_FETCH_TIMEOUT_MS);
      try {
        const response = await fetch(change.downloadUrl, { signal: abortController.signal });
        if (!response.ok) {
          throw new Error(`Failed to download file content (${response.status})`);
        }
        const content = await response.text();
        normalizedChanges.push({ path: change.path, content, isDeleted: false });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`Timed out downloading file content after ${REMOTE_CONTENT_FETCH_TIMEOUT_MS}ms`);
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
      continue;
    }
    throw new Error(`Cannot commit file "${change.path}": no content available (missing blob or inline content)`);
  }

  const newTreeId: Id<"trees"> = await ctx.runAction(internal.content.buildTreeFromChanges, {
    workspaceId: args.workspaceId,
    baseTreeId: currentCommit.treeId,
    changes: normalizedChanges,
  });

  const commitId: Id<"commits"> = await ctx.runMutation(internal.vcs.createCommitRecord, {
    workspaceId: args.workspaceId,
    branchId: args.branchId,
    userId: args.authorId,
    message: args.message,
    treeId: newTreeId,
    parentId: branch.commitId,
  });

  await ctx.runMutation(internal.fs.working.clear, {
    branchId: args.branchId,
    userId: args.workingOwnerId,
  });

  return commitId;
}

export const createCommitRecord = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    branchId: v.id("branches"),
    userId: v.string(),
    message: v.string(),
    treeId: v.id("trees"),
    parentId: v.id("commits"),
  },
  handler: async (ctx, args): Promise<Id<"commits">> => {
    const commitId: Id<"commits"> = await ctx.db.insert("commits", {
      workspaceId: args.workspaceId,
      parentId: args.parentId,
      treeId: args.treeId,
      message: args.message,
      authorId: args.userId,
      createdAt: Date.now(),
    });

    await ctx.db.patch(args.branchId, {
      commitId,
    });

    return commitId;
  },
});

/**
 * Get a commit by ID
 */
export const getCommit = query({
  args: {
    commitId: v.id("commits"),
  },
  handler: async (ctx, args) => {
    const commit = await ctx.db.get(args.commitId);
    if (!commit) {
      return null;
    }
    await requireWorkspaceMember(ctx, commit.workspaceId);
    return commit;
  },
});

/**
 * Get a commit by ID (internal)
 */
export const getCommitInternal = internalQuery({
  args: {
    commitId: v.id("commits"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.commitId);
  },
});

/**
 * Get commit history for a branch
 */
export const getHistory = query({
  args: {
    branchId: v.id("branches"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const branch = await ctx.db.get(args.branchId);
    if (!branch) {
      throw new Error("Branch not found");
    }
    await requireWorkspaceMember(ctx, branch.workspaceId);

    const limit = args.limit ?? 50;
    const commits: Doc<"commits">[] = [];
    let currentId: Id<"commits"> | undefined = branch.commitId;

    while (currentId && commits.length < limit) {
      const commit: Doc<"commits"> | null = await ctx.db.get(currentId);
      if (!commit) break;
      commits.push(commit);
      currentId = commit.parentId;
    }

    return commits;
  },
});

/**
 * Get commits for a workspace
 */
export const listCommits = query({
  args: {
    workspaceId: v.id("workspaces"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceMember(ctx, args.workspaceId);
    const limit = args.limit ?? 100;
    return await ctx.db
      .query("commits")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .order("desc")
      .take(limit);
  },
});

// ============================================================================
// Branch Operations
// ============================================================================

function getInvalidBranchNameReason(name: string): string | null {
  if (name.includes(":")) {
    return "Branch names cannot contain ':'. Reserved delimiters ':' and '@' are used for branch and revision URLs.";
  }
  if (name.includes("@")) {
    return "Branch names cannot contain '@'. Reserved delimiters ':' and '@' are used for branch and revision URLs.";
  }
  return null;
}

/**
 * Create a new branch from a commit
 */
export const createBranch = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    name: v.string(),
    fromCommitId: v.optional(v.id("commits")),
    fromBranchId: v.optional(v.id("branches")),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAdmin(ctx, args.workspaceId);
    const invalidBranchReason = getInvalidBranchNameReason(args.name);
    if (invalidBranchReason) {
      throw new Error(invalidBranchReason);
    }
    // Check if branch name already exists
    const existing = await ctx.db
      .query("branches")
      .withIndex("by_name", (q) => q.eq("workspaceId", args.workspaceId).eq("name", args.name))
      .first();

    if (existing) {
      throw new Error(`Branch "${args.name}" already exists`);
    }

    // Determine the commit to branch from
    let commitId: Id<"commits">;

    if (args.fromCommitId) {
      const commit = await ctx.db.get(args.fromCommitId);
      if (!commit || commit.workspaceId !== args.workspaceId) {
        throw new Error("Commit not found or does not belong to workspace");
      }
      commitId = args.fromCommitId;
    } else if (args.fromBranchId) {
      const branch = await ctx.db.get(args.fromBranchId);
      if (!branch || branch.workspaceId !== args.workspaceId) {
        throw new Error("Branch not found or does not belong to workspace");
      }
      commitId = branch.commitId;
    } else {
      // Get default branch
      const defaultBranch = await ctx.db
        .query("branches")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
        .filter((q) => q.eq(q.field("isDefault"), true))
        .first();

      if (!defaultBranch) {
        throw new Error("No source commit or branch specified and no default branch exists");
      }
      commitId = defaultBranch.commitId;
    }

    // Create the branch
    const branchId = await ctx.db.insert("branches", {
      workspaceId: args.workspaceId,
      name: args.name,
      commitId,
      isDefault: false,
    });

    return branchId;
  },
});

/**
 * Initialize a workspace with an empty commit and main branch
 */
export const initializeWorkspace = mutation({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args): Promise<{ commitId: Id<"commits">; branchId: Id<"branches"> }> => {
    const { user } = await requireWorkspaceAdmin(ctx, args.workspaceId);
    return await initWorkspaceHandler(ctx, { workspaceId: args.workspaceId, userId: user.subject });
  },
});

/**
 * Initialize a workspace with an empty commit and main branch (internal)
 */
export const initializeWorkspaceInternal = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    userId: v.string(),
  },
  handler: async (ctx, args): Promise<{ commitId: Id<"commits">; branchId: Id<"branches"> }> => {
    return await initWorkspaceHandler(ctx, args);
  },
});

async function initWorkspaceHandler(
  ctx: any,
  args: { workspaceId: Id<"workspaces">; userId: string },
): Promise<{ commitId: Id<"commits">; branchId: Id<"branches"> }> {
  // Check if workspace already has branches
  const existingBranch = await ctx.db
    .query("branches")
    .withIndex("by_workspace", (q: any) => q.eq("workspaceId", args.workspaceId))
    .first();

  if (existingBranch) {
    throw new Error("Workspace already initialized");
  }

  // Create empty tree
  const emptyTreeId: Id<"trees"> = await ctx.runMutation(internal.content.createEmptyTree, {
    workspaceId: args.workspaceId,
  });

  // Create initial commit
  const commitId: Id<"commits"> = await ctx.db.insert("commits", {
    workspaceId: args.workspaceId,
    treeId: emptyTreeId,
    message: "Initial commit",
    authorId: args.userId,
    createdAt: Date.now(),
  });

  // Create main branch
  const branchId: Id<"branches"> = await ctx.db.insert("branches", {
    workspaceId: args.workspaceId,
    name: "main",
    commitId,
    isDefault: true,
  });

  // Set as active commit
  await ctx.db.patch(args.workspaceId, {
    activeCommitId: commitId,
  });

  return { commitId, branchId };
}

/**
 * Get a branch by ID
 */
export const getBranch = query({
  args: {
    branchId: v.id("branches"),
  },
  handler: async (ctx, args) => {
    const branch = await ctx.db.get(args.branchId);
    if (!branch) {
      return null;
    }
    await requireWorkspaceMember(ctx, branch.workspaceId);
    return branch;
  },
});

/**
 * Get a branch by ID (internal)
 */
export const getBranchInternal = internalQuery({
  args: {
    branchId: v.id("branches"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.branchId);
  },
});

/**
 * Get a branch by name
 */
export const getBranchByName = query({
  args: {
    workspaceId: v.id("workspaces"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceMember(ctx, args.workspaceId);
    return await ctx.db
      .query("branches")
      .withIndex("by_name", (q) => q.eq("workspaceId", args.workspaceId).eq("name", args.name))
      .first();
  },
});

/**
 * List all branches for a workspace
 */
export const listBranches = query({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceMember(ctx, args.workspaceId);
    return await ctx.db
      .query("branches")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
  },
});

/**
 * Get the default branch for a workspace
 */
export const getDefaultBranch = query({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceMember(ctx, args.workspaceId);
    return await ctx.db
      .query("branches")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .filter((q) => q.eq(q.field("isDefault"), true))
      .first();
  },
});

/**
 * Get the default branch for a workspace (internal)
 */
export const getDefaultBranchInternal = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("branches")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .filter((q) => q.eq(q.field("isDefault"), true))
      .first();
  },
});

/**
 * Get a branch by name (internal)
 */
export const getBranchByNameInternal = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("branches")
      .withIndex("by_name", (q) => q.eq("workspaceId", args.workspaceId).eq("name", args.name))
      .first();
  },
});

/**
 * Update a branch's commit (internal)
 */
export const updateBranchCommit = internalMutation({
  args: {
    branchId: v.id("branches"),
    commitId: v.id("commits"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.branchId, {
      commitId: args.commitId,
    });
  },
});

/**
 * Set a branch as default
 */
export const setDefaultBranch = mutation({
  args: {
    branchId: v.id("branches"),
  },
  handler: async (ctx, args) => {
    const branch = await ctx.db.get(args.branchId);
    if (!branch) {
      throw new Error("Branch not found");
    }
    await requireWorkspaceAdmin(ctx, branch.workspaceId);

    // Unset current default
    const currentDefault = await ctx.db
      .query("branches")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", branch.workspaceId))
      .filter((q) => q.eq(q.field("isDefault"), true))
      .first();

    if (currentDefault) {
      await ctx.db.patch(currentDefault._id, { isDefault: false });
    }

    // Set new default
    await ctx.db.patch(args.branchId, { isDefault: true });
  },
});

/**
 * Delete a branch
 */
export const deleteBranch = mutation({
  args: {
    branchId: v.id("branches"),
  },
  handler: async (ctx, args) => {
    const branch = await ctx.db.get(args.branchId);
    if (!branch) {
      throw new Error("Branch not found");
    }
    await requireWorkspaceAdmin(ctx, branch.workspaceId);

    if (branch.isDefault) {
      throw new Error("Cannot delete default branch");
    }

    // Delete associated working files
    const workingFiles = await ctx.db
      .query("workingFiles")
      .withIndex("by_branch_user", (q) => q.eq("branchId", args.branchId))
      .collect();

    for (const file of workingFiles) {
      await ctx.db.delete(file._id);
    }

    await ctx.db.delete(args.branchId);
  },
});

/**
 * Merge a branch into another (fast-forward only for now)
 */
export const mergeBranch = mutation({
  args: {
    sourceBranchId: v.id("branches"),
    targetBranchId: v.id("branches"),
  },
  handler: async (ctx, args) => {
    const user = await requireAuthenticatedUser(ctx);
    return await mergeBranchesHandler(ctx, {
      sourceBranchId: args.sourceBranchId,
      targetBranchId: args.targetBranchId,
      authorId: user.subject,
      skipWorkspaceAdminCheck: false,
    });
  },
});

export const mergeBranchInternal = internalMutation({
  args: {
    sourceBranchId: v.id("branches"),
    targetBranchId: v.id("branches"),
    authorId: v.string(),
  },
  handler: async (ctx, args) => {
    return await mergeBranchesHandler(ctx, {
      ...args,
      skipWorkspaceAdminCheck: true,
    });
  },
});

async function mergeBranchesHandler(
  ctx: any,
  args: {
    sourceBranchId: Id<"branches">;
    targetBranchId: Id<"branches">;
    authorId: string;
    skipWorkspaceAdminCheck: boolean;
  },
) {
  const sourceBranch = await ctx.db.get(args.sourceBranchId);
  const targetBranch = await ctx.db.get(args.targetBranchId);

  if (!sourceBranch || !targetBranch) {
    throw new Error("Branch not found");
  }

  if (sourceBranch.workspaceId !== targetBranch.workspaceId) {
    throw new Error("Branches must be in the same workspace");
  }
  if (!args.skipWorkspaceAdminCheck) {
    await requireWorkspaceAdmin(ctx, sourceBranch.workspaceId);
  }

  // Check if source is ahead of target (can fast-forward)
  const sourceCommit = await ctx.db.get(sourceBranch.commitId);
  const targetCommit = await ctx.db.get(targetBranch.commitId);

  if (!sourceCommit || !targetCommit) {
    throw new Error("Commit not found");
  }

  // Check if target commit is an ancestor of source commit
  let current: Id<"commits"> | undefined = sourceBranch.commitId;
  let canFastForward = false;

  while (current) {
    if (current === targetBranch.commitId) {
      canFastForward = true;
      break;
    }
    const commit: Doc<"commits"> | null = await ctx.db.get(current);
    if (!commit) break;
    current = commit.parentId;
  }

  if (canFastForward) {
    // Fast-forward merge
    await ctx.db.patch(args.targetBranchId, {
      commitId: sourceBranch.commitId,
    });
    return { type: "fast-forward" as const, commitId: sourceBranch.commitId };
  }

  // For non-fast-forward merges, create a merge commit
  // This is a simplified version - real merge would need conflict resolution
  const mergeTreeId = sourceCommit.treeId; // Use source tree for now

  const mergeCommitId = await ctx.db.insert("commits", {
    workspaceId: targetBranch.workspaceId,
    parentId: targetBranch.commitId,
    treeId: mergeTreeId,
    message: `Merge branch '${sourceBranch.name}' into '${targetBranch.name}'`,
    authorId: args.authorId,
    createdAt: Date.now(),
  });

  await ctx.db.patch(args.targetBranchId, {
    commitId: mergeCommitId,
  });

  return { type: "merge-commit" as const, commitId: mergeCommitId };
}

// ============================================================================
// Diff Operations
// ============================================================================

type FlatFile = { path: string; blobId: Id<"blobs"> };

/**
 * Compare two commits and return the differences
 */
export const diffCommits = query({
  args: {
    baseCommitId: v.id("commits"),
    headCommitId: v.id("commits"),
  },
  handler: async (ctx, args) => {
    const baseCommit = await ctx.db.get(args.baseCommitId);
    const headCommit = await ctx.db.get(args.headCommitId);

    if (!baseCommit || !headCommit) {
      throw new Error("Commit not found");
    }
    await requireWorkspaceMember(ctx, baseCommit.workspaceId);
    if (baseCommit.workspaceId !== headCommit.workspaceId) {
      throw new Error("Commits must be in the same workspace");
    }

    // Get all files from both trees
    const baseFiles: FlatFile[] = await ctx.runQuery(internal.trees.flattenTree, {
      treeId: baseCommit.treeId,
    });
    const headFiles: FlatFile[] = await ctx.runQuery(internal.trees.flattenTree, {
      treeId: headCommit.treeId,
    });

    const baseMap = new Map<string, FlatFile>(baseFiles.map((f: FlatFile) => [f.path, f]));
    const headMap = new Map<string, FlatFile>(headFiles.map((f: FlatFile) => [f.path, f]));

    const changes: Array<{
      path: string;
      type: "added" | "modified" | "deleted";
      baseBlobId?: Id<"blobs">;
      headBlobId?: Id<"blobs">;
    }> = [];

    // Find added and modified files
    for (const [path, file] of headMap) {
      const baseFile = baseMap.get(path);
      if (!baseFile) {
        changes.push({ path, type: "added", headBlobId: file.blobId });
      } else if (baseFile.blobId !== file.blobId) {
        changes.push({
          path,
          type: "modified",
          baseBlobId: baseFile.blobId,
          headBlobId: file.blobId,
        });
      }
    }

    // Find deleted files
    for (const [path, file] of baseMap) {
      if (!headMap.has(path)) {
        changes.push({ path, type: "deleted", baseBlobId: file.blobId });
      }
    }

    return changes.sort((a, b) => a.path.localeCompare(b.path));
  },
});
