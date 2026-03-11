/**
 * Seed functions for initializing workspaces with example data.
 * These are internal functions that can only be called with adminKey.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";

const SEED_WORKSPACE_ADMIN_USER_ID = process.env.TOKENSPACE_SEED_WORKSPACE_ADMIN_USER_ID?.trim() || undefined;

/**
 * Check if a workspace exists by slug
 */
export const workspaceExists = internalQuery({
  args: {
    slug: v.string(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
    return workspace !== null;
  },
});

/**
 * Get a workspace by slug (internal)
 */
export const getWorkspaceBySlugInternal = internalQuery({
  args: {
    slug: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("workspaces")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
  },
});

/**
 * Delete a workspace by slug (for re-seeding)
 */
export const deleteWorkspace = internalMutation({
  args: {
    slug: v.string(),
  },
  handler: async (ctx, args): Promise<{ deleted: boolean }> => {
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();

    if (!workspace) {
      return { deleted: false };
    }

    // Delete all related data
    // Delete working files
    const workingFiles = await ctx.db
      .query("workingFiles")
      .filter((q) => q.eq(q.field("workspaceId"), workspace._id))
      .collect();
    for (const file of workingFiles) {
      await ctx.db.delete(file._id);
    }

    // Delete branches
    const branches = await ctx.db
      .query("branches")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
      .collect();
    for (const branch of branches) {
      await ctx.db.delete(branch._id);
    }

    // Delete commits
    const commits = await ctx.db
      .query("commits")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
      .collect();
    for (const commit of commits) {
      await ctx.db.delete(commit._id);
    }

    // Delete trees
    const trees = await ctx.db
      .query("trees")
      .filter((q) => q.eq(q.field("workspaceId"), workspace._id))
      .collect();
    for (const tree of trees) {
      await ctx.db.delete(tree._id);
    }

    // Delete blobs
    const blobs = await ctx.db
      .query("blobs")
      .filter((q) => q.eq(q.field("workspaceId"), workspace._id))
      .collect();
    for (const blob of blobs) {
      await ctx.db.delete(blob._id);
    }

    // Delete revisions
    const revisions = await ctx.db
      .query("revisions")
      .filter((q) => q.eq(q.field("workspaceId"), workspace._id))
      .collect();
    for (const revision of revisions) {
      await ctx.db.delete(revision._id);
    }

    // Delete workspace memberships
    const memberships = await ctx.db
      .query("workspaceMemberships")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
      .collect();
    for (const membership of memberships) {
      await ctx.db.delete(membership._id);
    }

    // Delete workspace invitations
    const invitations = await ctx.db
      .query("workspaceInvitations")
      .withIndex("by_workspace_status", (q) => q.eq("workspaceId", workspace._id))
      .collect();
    for (const invitation of invitations) {
      await ctx.db.delete(invitation._id);
    }

    // Finally delete the workspace
    await ctx.db.delete(workspace._id);

    return { deleted: true };
  },
});

/**
 * Create workspace record (internal)
 */
export const createWorkspaceRecord = internalMutation({
  args: {
    slug: v.string(),
    name: v.string(),
    createdAt: v.number(),
  },
  handler: async (ctx, args): Promise<Id<"workspaces">> => {
    return await ctx.db.insert("workspaces", {
      name: args.name,
      slug: args.slug,
      createdAt: args.createdAt,
      updatedAt: args.createdAt,
    });
  },
});

/**
 * Create initial commit record (internal)
 */
export const createCommitRecord = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    treeId: v.id("trees"),
    message: v.string(),
    authorId: v.string(),
    createdAt: v.number(),
  },
  handler: async (ctx, args): Promise<Id<"commits">> => {
    return await ctx.db.insert("commits", {
      workspaceId: args.workspaceId,
      treeId: args.treeId,
      message: args.message,
      authorId: args.authorId,
      createdAt: args.createdAt,
    });
  },
});

/**
 * Create branch record (internal)
 */
export const createBranchRecord = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    name: v.string(),
    commitId: v.id("commits"),
    isDefault: v.boolean(),
  },
  handler: async (ctx, args): Promise<Id<"branches">> => {
    return await ctx.db.insert("branches", {
      workspaceId: args.workspaceId,
      name: args.name,
      commitId: args.commitId,
      isDefault: args.isDefault,
    });
  },
});

/**
 * Set active commit for workspace (internal)
 */
export const setActiveCommitRecord = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    commitId: v.id("commits"),
  },
  handler: async (ctx, args): Promise<void> => {
    await ctx.db.patch(args.workspaceId, {
      activeCommitId: args.commitId,
    });
  },
});

/**
 * Seed a workspace with files.
 * If workspace already exists, returns early (idempotent).
 */
export const seedWorkspace = internalAction({
  args: {
    slug: v.string(),
    name: v.string(),
    files: v.array(
      v.object({
        path: v.string(),
        content: v.string(),
        binary: v.optional(v.boolean()),
      }),
    ),
  },
  handler: async (ctx, args): Promise<{ workspaceId: Id<"workspaces">; status: "created" | "exists" }> => {
    // Check if workspace already exists
    const existing = await ctx.runQuery(internal.seed.getWorkspaceBySlugInternal, { slug: args.slug });

    if (existing) {
      return { workspaceId: existing._id, status: "exists" };
    }

    // 1. Create workspace
    const now = Date.now();
    const workspaceId = await ctx.runMutation(internal.seed.createWorkspaceRecord, {
      name: args.name,
      slug: args.slug,
      createdAt: now,
    });

    if (SEED_WORKSPACE_ADMIN_USER_ID) {
      await ctx.runMutation(internal.workspace.upsertMembershipInternal, {
        workspaceId,
        userId: SEED_WORKSPACE_ADMIN_USER_ID,
        role: "workspace_admin",
      });
    }

    // 2. Build tree from files
    const changes = args.files.map((f) => ({
      path: f.path,
      content: f.content,
      binary: f.binary,
      isDeleted: false,
    }));

    const treeId: Id<"trees"> = await ctx.runAction(internal.content.buildTreeFromChanges, {
      workspaceId,
      baseTreeId: undefined,
      changes,
    });

    // 3. Create initial commit with files
    const commitId: Id<"commits"> = await ctx.runMutation(internal.seed.createCommitRecord, {
      workspaceId,
      treeId,
      message: "Initial seed",
      authorId: "seed-script",
      createdAt: now,
    });

    // 4. Create main branch
    await ctx.runMutation(internal.seed.createBranchRecord, {
      workspaceId,
      name: "main",
      commitId,
      isDefault: true,
    });

    // 5. Set as active commit
    await ctx.runMutation(internal.seed.setActiveCommitRecord, {
      workspaceId,
      commitId,
    });

    return { workspaceId, status: "created" };
  },
});

/**
 * Update files in an existing workspace.
 * Creates a new commit with the updated files.
 */
export const updateWorkspace = internalAction({
  args: {
    slug: v.string(),
    files: v.array(
      v.object({
        path: v.string(),
        content: v.string(),
        binary: v.optional(v.boolean()),
      }),
    ),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ workspaceId: Id<"workspaces">; updatedFiles: number; deletedFiles: number }> => {
    // Get workspace
    const workspace = await ctx.runQuery(internal.seed.getWorkspaceBySlugInternal, { slug: args.slug });

    if (!workspace) {
      throw new Error(`Workspace '${args.slug}' not found`);
    }

    // Get current commit to find base tree
    const currentCommit = workspace.activeCommitId
      ? await ctx.runQuery(internal.vcs.getCommitInternal, { commitId: workspace.activeCommitId })
      : null;

    // Find files that exist in the current tree but not in the incoming files
    const incomingPaths = new Set<string>();
    const duplicatePaths = new Set<string>();
    for (const file of args.files) {
      if (incomingPaths.has(file.path)) {
        duplicatePaths.add(file.path);
      }
      incomingPaths.add(file.path);
    }
    if (duplicatePaths.size > 0) {
      const duplicates = [...duplicatePaths].sort().join(", ");
      throw new Error(`Duplicate file paths in update payload: ${duplicates}`);
    }
    let deletedFiles = 0;

    const changes: Array<{
      path: string;
      content?: string;
      binary?: boolean;
      isDeleted: boolean;
    }> = args.files.map((f) => ({
      path: f.path,
      content: f.content,
      binary: f.binary,
      isDeleted: false,
    }));

    if (currentCommit?.treeId) {
      const existingFiles = await ctx.runQuery(internal.trees.flattenTree, {
        treeId: currentCommit.treeId,
      });

      for (const file of existingFiles) {
        if (!incomingPaths.has(file.path)) {
          changes.push({ path: file.path, isDeleted: true });
          deletedFiles++;
        }
      }
    }

    const treeId: Id<"trees"> = await ctx.runAction(internal.content.buildTreeFromChanges, {
      workspaceId: workspace._id,
      baseTreeId: currentCommit?.treeId,
      changes,
    });

    // Create new commit
    const now = Date.now();
    const commitId: Id<"commits"> = await ctx.runMutation(internal.seed.createCommitRecord, {
      workspaceId: workspace._id,
      treeId,
      message: "Update from seed script",
      authorId: "seed-script",
      createdAt: now,
    });

    // Update main branch to point to new commit
    const mainBranch = await ctx.runQuery(internal.vcs.getBranchByNameInternal, {
      workspaceId: workspace._id,
      name: "main",
    });

    if (mainBranch) {
      await ctx.runMutation(internal.vcs.updateBranchCommit, {
        branchId: mainBranch._id,
        commitId,
      });
    }

    // Set as active commit
    await ctx.runMutation(internal.seed.setActiveCommitRecord, {
      workspaceId: workspace._id,
      commitId,
    });

    return { workspaceId: workspace._id, updatedFiles: args.files.length, deletedFiles };
  },
});
