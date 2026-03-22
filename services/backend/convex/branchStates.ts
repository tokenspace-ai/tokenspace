import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from "./_generated/server";
import { requireWorkspaceAdmin, requireWorkspaceMember } from "./authz";
import { loadFileContent, resolveFileDownloadUrl, resolveInlineContent, storeFileContent } from "./fs/fileBlobs";
import { computeWorkingStateHash, type WorkingStateChange } from "./workingStateHash";
import {
  ensureValidWorkspaceModels,
  getDefaultWorkspaceModels,
  getWorkspaceModelId,
  parseWorkspaceModelsYaml,
  serializeWorkspaceModelsYaml,
  vWorkspaceModelDefinition,
  type WorkspaceModelDefinition,
} from "./workspaceMetadata";

const MODELS_FILE_PATH = "src/models.yaml";

type BranchStateDoc = Doc<"branchStates">;

function getInvalidBranchStateNameReason(name: string): string | null {
  if (name.includes(":")) {
    return "Branch state names cannot contain ':'. Reserved delimiters ':' and '@' are used for branch and revision URLs.";
  }
  if (name.includes("@")) {
    return "Branch state names cannot contain '@'. Reserved delimiters ':' and '@' are used for branch and revision URLs.";
  }
  return null;
}

function buildWorkingOwnerKey(backingBranchId: Id<"branches">): string {
  return `branch-state:${backingBranchId}`;
}

async function getBranchStateOrThrow(ctx: QueryCtx | MutationCtx | any, branchStateId: Id<"branchStates">) {
  const branchState = await ctx.db.get(branchStateId);
  if (!branchState) {
    throw new Error("Branch state not found");
  }
  return branchState;
}

async function getMainBranchStateInternal(ctx: QueryCtx | MutationCtx | any, workspaceId: Id<"workspaces">) {
  return await ctx.db
    .query("branchStates")
    .withIndex("by_workspace_main", (q: any) => q.eq("workspaceId", workspaceId).eq("isMain", true))
    .filter((q: any) => q.eq(q.field("archivedAt"), undefined))
    .first();
}

async function getBranchStateByNameInternal(
  ctx: QueryCtx | MutationCtx | any,
  workspaceId: Id<"workspaces">,
  name: string,
) {
  return await ctx.db
    .query("branchStates")
    .withIndex("by_name", (q: any) => q.eq("workspaceId", workspaceId).eq("name", name))
    .filter((q: any) => q.eq(q.field("archivedAt"), undefined))
    .first();
}

async function listBranchStatesInternal(ctx: QueryCtx | MutationCtx | any, workspaceId: Id<"workspaces">) {
  const branchStates: BranchStateDoc[] = await ctx.db
    .query("branchStates")
    .withIndex("by_workspace", (q: any) => q.eq("workspaceId", workspaceId))
    .filter((q: any) => q.eq(q.field("archivedAt"), undefined))
    .collect();

  return branchStates.sort((a: BranchStateDoc, b: BranchStateDoc) => {
    if (a.isMain && !b.isMain) return -1;
    if (!a.isMain && b.isMain) return 1;
    return a.name.localeCompare(b.name);
  });
}

async function ensureBranchStatesForWorkspaceHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; createdByUserId: string },
): Promise<BranchStateDoc[]> {
  const branches = await ctx.db
    .query("branches")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .collect();

  const existing = await ctx.db
    .query("branchStates")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .collect();

  const existingByBranchId = new Map(existing.map((branchState) => [branchState.backingBranchId, branchState]));
  const defaultBranchId = branches.find((branch) => branch.isDefault)?._id;
  const now = Date.now();

  for (const branch of branches) {
    const current = existingByBranchId.get(branch._id);
    const nextWorkingOwnerKey = buildWorkingOwnerKey(branch._id);
    const isMain = branch._id === defaultBranchId;

    if (current) {
      const shouldPatch =
        current.name !== branch.name ||
        current.isMain !== isMain ||
        current.workingOwnerKey !== nextWorkingOwnerKey ||
        current.archivedAt !== undefined;
      if (shouldPatch) {
        await ctx.db.patch(current._id, {
          name: branch.name,
          isMain,
          workingOwnerKey: nextWorkingOwnerKey,
          archivedAt: undefined,
          updatedAt: now,
        });
      }
      continue;
    }

    const branchStateId = await ctx.db.insert("branchStates", {
      workspaceId: args.workspaceId,
      name: branch.name,
      isMain,
      backingBranchId: branch._id,
      workingOwnerKey: nextWorkingOwnerKey,
      createdByUserId: args.createdByUserId,
      createdAt: now,
      updatedAt: now,
    });
    const inserted = await ctx.db.get(branchStateId);
    if (inserted) {
      existingByBranchId.set(branch._id, inserted);
    }
  }

  return await listBranchStatesInternal(ctx, args.workspaceId);
}

async function createDraftBranchStateFromMain(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    mainBranchState: BranchStateDoc;
    createdByUserId: string;
  },
): Promise<BranchStateDoc> {
  const sourceBranch = await ctx.db.get(args.mainBranchState.backingBranchId);
  if (!sourceBranch) {
    throw new Error("Main backing branch not found");
  }

  let name = "";
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = `draft-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const invalidReason = getInvalidBranchStateNameReason(candidate);
    if (invalidReason) {
      continue;
    }

    const existingBranchState = await getBranchStateByNameInternal(ctx, args.workspaceId, candidate);
    const existingBranch = await ctx.db
      .query("branches")
      .withIndex("by_name", (q) => q.eq("workspaceId", args.workspaceId).eq("name", candidate))
      .first();
    if (!existingBranchState && !existingBranch) {
      name = candidate;
      break;
    }
  }

  if (!name) {
    throw new Error("Unable to generate a unique draft branch state name");
  }

  const now = Date.now();
  const backingBranchId = await ctx.db.insert("branches", {
    workspaceId: args.workspaceId,
    name,
    commitId: sourceBranch.commitId,
    isDefault: false,
  });

  const branchStateId = await ctx.db.insert("branchStates", {
    workspaceId: args.workspaceId,
    name,
    isMain: false,
    backingBranchId,
    workingOwnerKey: buildWorkingOwnerKey(backingBranchId),
    createdByUserId: args.createdByUserId,
    createdAt: now,
    updatedAt: now,
  });

  const branchState = await ctx.db.get(branchStateId);
  if (!branchState) {
    throw new Error("Draft branch state was not created");
  }
  return branchState;
}

async function ensureWritableBranchStateHandler(
  ctx: MutationCtx,
  args: {
    branchStateId: Id<"branchStates">;
    createdByUserId: string;
  },
): Promise<BranchStateDoc> {
  const branchState = await getBranchStateOrThrow(ctx, args.branchStateId);
  if (!branchState.isMain) {
    return branchState;
  }

  return await createDraftBranchStateFromMain(ctx, {
    workspaceId: branchState.workspaceId,
    mainBranchState: branchState,
    createdByUserId: args.createdByUserId,
  });
}

async function clearWorkingFilesForOwner(
  ctx: MutationCtx,
  args: { branchId: Id<"branches">; workingOwnerKey: string },
): Promise<number> {
  const files = await ctx.db
    .query("workingFiles")
    .withIndex("by_branch_user", (q) => q.eq("branchId", args.branchId).eq("userId", args.workingOwnerKey))
    .collect();

  for (const file of files) {
    await ctx.db.delete(file._id);
  }

  return files.length;
}

async function getResolvedWorkingFiles(
  ctx: QueryCtx | MutationCtx | any,
  args: { branchId: Id<"branches">; workingOwnerKey: string },
) {
  const files = await ctx.db
    .query("workingFiles")
    .withIndex("by_branch_user", (q: any) => q.eq("branchId", args.branchId).eq("userId", args.workingOwnerKey))
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
}

async function computeBranchStateWorkingStateHash(
  ctx: QueryCtx | MutationCtx | any,
  branchState: BranchStateDoc,
): Promise<string | undefined> {
  const workingChanges: WorkingStateChange[] = await ctx.runQuery(internal.fs.working.getChanges, {
    branchId: branchState.backingBranchId,
    userId: branchState.workingOwnerKey,
  });

  if (workingChanges.length === 0) {
    return undefined;
  }

  return computeWorkingStateHash(workingChanges);
}

function normalizeProviderOptionsForMutation(
  providerOptions: unknown,
  args: { allowNull: boolean },
): Record<string, unknown> | undefined {
  if (providerOptions === undefined) {
    return undefined;
  }
  if (providerOptions === null) {
    if (args.allowNull) {
      return undefined;
    }
    throw new Error("providerOptions must be a JSON object");
  }
  if (!providerOptions || typeof providerOptions !== "object" || Array.isArray(providerOptions)) {
    throw new Error("providerOptions must be a JSON object");
  }
  return providerOptions as Record<string, unknown>;
}

async function loadModelsFromBranchState(ctx: QueryCtx | MutationCtx | any, branchState: BranchStateDoc) {
  const workingFile = await ctx.runQuery(internal.fs.working.read, {
    branchId: branchState.backingBranchId,
    userId: branchState.workingOwnerKey,
    path: MODELS_FILE_PATH,
  });

  if (workingFile) {
    if (workingFile.isDeleted) {
      return getDefaultWorkspaceModels();
    }
    const content = await loadFileContent(
      ctx,
      { content: workingFile.content, blobId: workingFile.blobId },
      { binary: false },
    );
    if (content === undefined) {
      return getDefaultWorkspaceModels();
    }
    return parseWorkspaceModelsYaml(content, MODELS_FILE_PATH);
  }

  const branch = await ctx.runQuery(internal.vcs.getBranchInternal, {
    branchId: branchState.backingBranchId,
  });
  if (!branch) {
    throw new Error("Backing branch not found");
  }
  const commit = await ctx.runQuery(internal.vcs.getCommitInternal, {
    commitId: branch.commitId,
  });
  if (!commit) {
    throw new Error("Commit not found");
  }

  const committedFile: { content?: string; blobId?: Id<"blobs"> } | null = await ctx.runQuery(
    api.trees.getFileFromTree,
    {
      treeId: commit.treeId,
      path: MODELS_FILE_PATH,
    },
  );
  const content = await loadFileContent(
    ctx,
    { content: committedFile?.content, blobId: committedFile?.blobId },
    { binary: false },
  );
  if (content === undefined) {
    return getDefaultWorkspaceModels();
  }
  return parseWorkspaceModelsYaml(content, MODELS_FILE_PATH);
}

async function writeModelsToBranchState(
  ctx: MutationCtx,
  args: {
    branchState: BranchStateDoc;
    models: WorkspaceModelDefinition[];
  },
) {
  const models = ensureValidWorkspaceModels(args.models, MODELS_FILE_PATH);
  const content = serializeWorkspaceModelsYaml(models);
  await ctx.runMutation(internal.fs.working.write, {
    workspaceId: args.branchState.workspaceId,
    branchId: args.branchState.backingBranchId,
    userId: args.branchState.workingOwnerKey,
    path: MODELS_FILE_PATH,
    content,
    blobId: undefined,
  });
  await ctx.db.patch(args.branchState._id, {
    updatedAt: Date.now(),
    lastCompiledRevisionId: undefined,
  });
  return models;
}

export const getInternal = internalQuery({
  args: {
    branchStateId: v.id("branchStates"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.branchStateId);
  },
});

export const getByNameInternal = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    return await getBranchStateByNameInternal(ctx, args.workspaceId, args.name);
  },
});

export const getMainInternal = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    return await getMainBranchStateInternal(ctx, args.workspaceId);
  },
});

export const ensureInitializedInternal = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    createdByUserId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ensureBranchStatesForWorkspaceHandler(ctx, args);
  },
});

export const ensureWritableBranchStateInternal = internalMutation({
  args: {
    branchStateId: v.id("branchStates"),
    createdByUserId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ensureWritableBranchStateHandler(ctx, args);
  },
});

export const setLastCompiledRevisionInternal = internalMutation({
  args: {
    branchStateId: v.id("branchStates"),
    revisionId: v.id("revisions"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.branchStateId, {
      lastCompiledRevisionId: args.revisionId,
      updatedAt: Date.now(),
    });
  },
});

export const ensureInitialized = mutation({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireWorkspaceAdmin(ctx, args.workspaceId);
    return await ensureBranchStatesForWorkspaceHandler(ctx, {
      workspaceId: args.workspaceId,
      createdByUserId: user.subject,
    });
  },
});

export const list = query({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAdmin(ctx, args.workspaceId);
    return await listBranchStatesInternal(ctx, args.workspaceId);
  },
});

export const get = query({
  args: {
    branchStateId: v.id("branchStates"),
  },
  handler: async (ctx, args) => {
    const branchState = await getBranchStateOrThrow(ctx, args.branchStateId);
    await requireWorkspaceAdmin(ctx, branchState.workspaceId);
    return branchState;
  },
});

export const getByName = query({
  args: {
    workspaceId: v.id("workspaces"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAdmin(ctx, args.workspaceId);
    return await getBranchStateByNameInternal(ctx, args.workspaceId, args.name);
  },
});

export const ensureDraftFromMain = mutation({
  args: {
    workspaceId: v.id("workspaces"),
  },
  returns: v.object({
    branchStateId: v.id("branchStates"),
    branchStateName: v.string(),
  }),
  handler: async (ctx, args) => {
    const { user } = await requireWorkspaceAdmin(ctx, args.workspaceId);
    await ensureBranchStatesForWorkspaceHandler(ctx, {
      workspaceId: args.workspaceId,
      createdByUserId: user.subject,
    });
    const mainBranchState = await getMainBranchStateInternal(ctx, args.workspaceId);
    if (!mainBranchState) {
      throw new Error("Main branch state not found");
    }
    const draft = await ensureWritableBranchStateHandler(ctx, {
      branchStateId: mainBranchState._id,
      createdByUserId: user.subject,
    });
    return {
      branchStateId: draft._id,
      branchStateName: draft.name,
    };
  },
});

export const getWorkingFiles = query({
  args: {
    branchStateId: v.id("branchStates"),
  },
  handler: async (ctx, args) => {
    const branchState = await getBranchStateOrThrow(ctx, args.branchStateId);
    await requireWorkspaceAdmin(ctx, branchState.workspaceId);
    return await getResolvedWorkingFiles(ctx, {
      branchId: branchState.backingBranchId,
      workingOwnerKey: branchState.workingOwnerKey,
    });
  },
});

export const saveFile = action({
  args: {
    branchStateId: v.id("branchStates"),
    path: v.string(),
    content: v.string(),
  },
  returns: v.object({
    branchStateId: v.id("branchStates"),
    branchStateName: v.string(),
    redirected: v.boolean(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ branchStateId: Id<"branchStates">; branchStateName: string; redirected: boolean }> => {
    const branchState: BranchStateDoc | null = await ctx.runQuery(internal.branchStates.getInternal, {
      branchStateId: args.branchStateId,
    });
    if (!branchState) {
      throw new Error("Branch state not found");
    }
    const { user } = await requireWorkspaceAdmin(ctx, branchState.workspaceId);
    const effectiveBranchState: BranchStateDoc = await ctx.runMutation(
      internal.branchStates.ensureWritableBranchStateInternal,
      {
        branchStateId: args.branchStateId,
        createdByUserId: user.subject,
      },
    );
    const stored = await storeFileContent(ctx, {
      workspaceId: effectiveBranchState.workspaceId,
      content: args.content,
      binary: false,
    });
    await ctx.runMutation(internal.fs.working.write, {
      workspaceId: effectiveBranchState.workspaceId,
      branchId: effectiveBranchState.backingBranchId,
      userId: effectiveBranchState.workingOwnerKey,
      path: args.path,
      content: stored.content,
      blobId: stored.blobId,
    });
    await ctx.runMutation(internal.branchStates.touchBranchStateInternal, {
      branchStateId: effectiveBranchState._id,
      clearLastCompiledRevisionId: true,
    });
    return {
      branchStateId: effectiveBranchState._id,
      branchStateName: effectiveBranchState.name,
      redirected: effectiveBranchState._id !== args.branchStateId,
    };
  },
});

export const touchBranchStateInternal = internalMutation({
  args: {
    branchStateId: v.id("branchStates"),
    clearLastCompiledRevisionId: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.branchStateId, {
      updatedAt: Date.now(),
      ...(args.clearLastCompiledRevisionId ? { lastCompiledRevisionId: undefined } : {}),
    });
  },
});

export const discardFile = mutation({
  args: {
    branchStateId: v.id("branchStates"),
    path: v.string(),
  },
  returns: v.object({
    discarded: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const branchState = await getBranchStateOrThrow(ctx, args.branchStateId);
    await requireWorkspaceAdmin(ctx, branchState.workspaceId);
    if (branchState.isMain) {
      return { discarded: false };
    }
    const file = await ctx.db
      .query("workingFiles")
      .withIndex("by_path", (q) =>
        q.eq("branchId", branchState.backingBranchId).eq("userId", branchState.workingOwnerKey).eq("path", args.path),
      )
      .first();

    if (file) {
      await ctx.db.delete(file._id);
      await ctx.db.patch(branchState._id, {
        updatedAt: Date.now(),
        lastCompiledRevisionId: undefined,
      });
      return { discarded: true };
    }

    return { discarded: false };
  },
});

export const discardAll = mutation({
  args: {
    branchStateId: v.id("branchStates"),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const branchState = await getBranchStateOrThrow(ctx, args.branchStateId);
    await requireWorkspaceAdmin(ctx, branchState.workspaceId);
    if (branchState.isMain) {
      return 0;
    }
    const count = await clearWorkingFilesForOwner(ctx, {
      branchId: branchState.backingBranchId,
      workingOwnerKey: branchState.workingOwnerKey,
    });
    if (count > 0) {
      await ctx.db.patch(branchState._id, {
        updatedAt: Date.now(),
        lastCompiledRevisionId: undefined,
      });
    }
    return count;
  },
});

export const createCommit = action({
  args: {
    branchStateId: v.id("branchStates"),
    message: v.string(),
  },
  returns: v.object({
    branchStateId: v.id("branchStates"),
    branchStateName: v.string(),
    commitId: v.id("commits"),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ branchStateId: Id<"branchStates">; branchStateName: string; commitId: Id<"commits"> }> => {
    const branchState: BranchStateDoc | null = await ctx.runQuery(internal.branchStates.getInternal, {
      branchStateId: args.branchStateId,
    });
    if (!branchState) {
      throw new Error("Branch state not found");
    }
    const { user } = await requireWorkspaceAdmin(ctx, branchState.workspaceId);
    const commitId: Id<"commits"> = await ctx.runAction(internal.vcs.createCommitForOwnerInternal, {
      workspaceId: branchState.workspaceId,
      branchId: branchState.backingBranchId,
      authorId: user.subject,
      workingOwnerId: branchState.workingOwnerKey,
      message: args.message,
    });
    await ctx.runMutation(internal.branchStates.touchBranchStateInternal, {
      branchStateId: branchState._id,
      clearLastCompiledRevisionId: true,
    });
    return {
      branchStateId: branchState._id,
      branchStateName: branchState.name,
      commitId,
    };
  },
});

export const compile = action({
  args: {
    branchStateId: v.id("branchStates"),
  },
  returns: v.object({
    compileJobId: v.id("compileJobs"),
  }),
  handler: async (ctx, args): Promise<{ compileJobId: Id<"compileJobs"> }> => {
    const branchState: BranchStateDoc | null = await ctx.runQuery(internal.branchStates.getInternal, {
      branchStateId: args.branchStateId,
    });
    if (!branchState) {
      throw new Error("Branch state not found");
    }
    await requireWorkspaceAdmin(ctx, branchState.workspaceId);
    const queued: { compileJobId?: Id<"compileJobs">; existingRevisionId?: Id<"revisions"> } = await ctx.runAction(
      internal.compile.enqueueBranchCompile,
      {
        workspaceId: branchState.workspaceId,
        branchId: branchState.backingBranchId,
        branchStateId: branchState._id,
        includeWorkingState: true,
        userId: branchState.workingOwnerKey,
        checkExistingRevision: false,
      },
    );
    if (!queued.compileJobId) {
      throw new Error("Compile job was not created");
    }
    return {
      compileJobId: queued.compileJobId,
    };
  },
});

export const mergeIntoMain = mutation({
  args: {
    branchStateId: v.id("branchStates"),
  },
  returns: v.object({
    type: v.union(v.literal("fast-forward"), v.literal("merge-commit")),
    commitId: v.id("commits"),
  }),
  handler: async (ctx, args): Promise<{ type: "fast-forward" | "merge-commit"; commitId: Id<"commits"> }> => {
    const branchState = await getBranchStateOrThrow(ctx, args.branchStateId);
    const { user } = await requireWorkspaceAdmin(ctx, branchState.workspaceId);
    if (branchState.isMain) {
      throw new Error("Cannot merge the main branch state into itself");
    }
    const mainBranchState = await getMainBranchStateInternal(ctx, branchState.workspaceId);
    if (!mainBranchState) {
      throw new Error("Main branch state not found");
    }
    const result: { type: "fast-forward" | "merge-commit"; commitId: Id<"commits"> } = await ctx.runMutation(
      internal.vcs.mergeBranchInternal,
      {
        authorId: user.subject,
        sourceBranchId: branchState.backingBranchId,
        targetBranchId: mainBranchState.backingBranchId,
      },
    );
    await ctx.db.patch(branchState._id, {
      updatedAt: Date.now(),
      lastCompiledRevisionId: undefined,
    });
    await ctx.db.patch(mainBranchState._id, {
      updatedAt: Date.now(),
      lastCompiledRevisionId: undefined,
    });
    return result;
  },
});

export const deleteBranchState = mutation({
  args: {
    branchStateId: v.id("branchStates"),
  },
  returns: v.object({
    deleted: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const branchState = await getBranchStateOrThrow(ctx, args.branchStateId);
    await requireWorkspaceAdmin(ctx, branchState.workspaceId);
    if (branchState.isMain) {
      throw new Error("Cannot delete the main branch state");
    }

    await clearWorkingFilesForOwner(ctx, {
      branchId: branchState.backingBranchId,
      workingOwnerKey: branchState.workingOwnerKey,
    });

    await ctx.db.delete(branchState.backingBranchId);
    await ctx.db.delete(branchState._id);

    return { deleted: true };
  },
});

export const getCurrentRevision = query({
  args: {
    branchStateId: v.id("branchStates"),
  },
  handler: async (ctx, args): Promise<Doc<"revisions"> | null> => {
    const branchState = await getBranchStateOrThrow(ctx, args.branchStateId);
    await requireWorkspaceMember(ctx, branchState.workspaceId);

    if (branchState.lastCompiledRevisionId) {
      return await ctx.runQuery(internal.revisions.getRevision, {
        revisionId: branchState.lastCompiledRevisionId,
      });
    }

    const workingStateHash: string | undefined = await computeBranchStateWorkingStateHash(ctx, branchState);
    const revisionId: Id<"revisions"> | null = await ctx.runQuery(internal.compile.getRevision, {
      workspaceId: branchState.workspaceId,
      branchId: branchState.backingBranchId,
      workingStateHash,
      userId: branchState.workingOwnerKey,
    });
    if (!revisionId) {
      return null;
    }
    return await ctx.db.get(revisionId);
  },
});

export const getModels = query({
  args: {
    branchStateId: v.id("branchStates"),
  },
  returns: v.array(vWorkspaceModelDefinition),
  handler: async (ctx, args) => {
    const branchState = await getBranchStateOrThrow(ctx, args.branchStateId);
    await requireWorkspaceAdmin(ctx, branchState.workspaceId);
    return await loadModelsFromBranchState(ctx, branchState);
  },
});

const vBranchStateModelMutationResult = v.object({
  branchStateId: v.id("branchStates"),
  branchStateName: v.string(),
  redirected: v.boolean(),
  models: v.array(vWorkspaceModelDefinition),
});

export const addModel = mutation({
  args: {
    branchStateId: v.id("branchStates"),
    modelId: v.string(),
    id: v.optional(v.string()),
    label: v.optional(v.string()),
    isDefault: v.optional(v.boolean()),
    systemPrompt: v.optional(v.string()),
    providerOptions: v.optional(v.any()),
  },
  returns: vBranchStateModelMutationResult,
  handler: async (ctx, args) => {
    const currentBranchState = await getBranchStateOrThrow(ctx, args.branchStateId);
    const { user } = await requireWorkspaceAdmin(ctx, currentBranchState.workspaceId);
    const branchState = await ensureWritableBranchStateHandler(ctx, {
      branchStateId: currentBranchState._id,
      createdByUserId: user.subject,
    });
    const models = await loadModelsFromBranchState(ctx, branchState);
    const modelId = args.modelId.trim();
    if (!modelId) {
      throw new Error("modelId is required");
    }
    const configuredId = args.id?.trim() || modelId;
    if (models.some((model) => getWorkspaceModelId(model) === configuredId)) {
      throw new Error(`Model id "${configuredId}" is already configured`);
    }

    const next = models.map((model) => ({ ...model }));
    if (args.isDefault) {
      for (const model of next) {
        model.isDefault = false;
      }
    }
    next.push({
      id: configuredId,
      modelId,
      label: args.label?.trim() || undefined,
      isDefault: args.isDefault ?? false,
      systemPrompt: args.systemPrompt?.trim() || undefined,
      providerOptions: normalizeProviderOptionsForMutation(args.providerOptions, { allowNull: true }),
    });
    if (!next.some((model) => model.isDefault)) {
      next[0]!.isDefault = true;
    }

    const saved = await writeModelsToBranchState(ctx, {
      branchState,
      models: next,
    });
    return {
      branchStateId: branchState._id,
      branchStateName: branchState.name,
      redirected: branchState._id !== currentBranchState._id,
      models: saved,
    };
  },
});

export const removeModel = mutation({
  args: {
    branchStateId: v.id("branchStates"),
    id: v.string(),
  },
  returns: vBranchStateModelMutationResult,
  handler: async (ctx, args) => {
    const currentBranchState = await getBranchStateOrThrow(ctx, args.branchStateId);
    const { user } = await requireWorkspaceAdmin(ctx, currentBranchState.workspaceId);
    const branchState = await ensureWritableBranchStateHandler(ctx, {
      branchStateId: currentBranchState._id,
      createdByUserId: user.subject,
    });
    const models = await loadModelsFromBranchState(ctx, branchState);
    if (models.length <= 1) {
      throw new Error("At least one model must remain configured");
    }
    const modelId = args.id.trim();
    const next = models.filter((model) => getWorkspaceModelId(model) !== modelId);
    if (next.length === models.length) {
      throw new Error(`Model "${modelId}" not found in workspace`);
    }
    if (!next.some((model) => model.isDefault)) {
      next[0]!.isDefault = true;
    }
    const saved = await writeModelsToBranchState(ctx, {
      branchState,
      models: next,
    });
    return {
      branchStateId: branchState._id,
      branchStateName: branchState.name,
      redirected: branchState._id !== currentBranchState._id,
      models: saved,
    };
  },
});

export const updateModel = mutation({
  args: {
    branchStateId: v.id("branchStates"),
    id: v.string(),
    nextId: v.optional(v.string()),
    label: v.optional(v.string()),
    isDefault: v.optional(v.boolean()),
    systemPrompt: v.optional(v.string()),
    providerOptions: v.optional(v.any()),
  },
  returns: vBranchStateModelMutationResult,
  handler: async (ctx, args) => {
    const currentBranchState = await getBranchStateOrThrow(ctx, args.branchStateId);
    const { user } = await requireWorkspaceAdmin(ctx, currentBranchState.workspaceId);
    const branchState = await ensureWritableBranchStateHandler(ctx, {
      branchStateId: currentBranchState._id,
      createdByUserId: user.subject,
    });
    const next = (await loadModelsFromBranchState(ctx, branchState)).map((model) => ({ ...model }));
    const currentId = args.id.trim();
    const modelIndex = next.findIndex((model) => getWorkspaceModelId(model) === currentId);
    if (modelIndex === -1) {
      throw new Error(`Model "${currentId}" not found in workspace`);
    }
    if (args.isDefault) {
      for (const model of next) {
        model.isDefault = false;
      }
    }
    const model = next[modelIndex]!;
    if (args.nextId !== undefined) {
      const nextId = args.nextId.trim() || model.modelId;
      if (
        next.some(
          (candidate, candidateIndex) => candidateIndex !== modelIndex && getWorkspaceModelId(candidate) === nextId,
        )
      ) {
        throw new Error(`Model id "${nextId}" is already configured`);
      }
      model.id = nextId;
    }
    if (args.label !== undefined) {
      model.label = args.label.trim() || undefined;
    }
    if (args.isDefault !== undefined) {
      model.isDefault = args.isDefault;
    }
    if (args.systemPrompt !== undefined) {
      model.systemPrompt = args.systemPrompt.trim() || undefined;
    }
    if (args.providerOptions !== undefined) {
      model.providerOptions = normalizeProviderOptionsForMutation(args.providerOptions, { allowNull: true });
    }
    if (!next.some((candidate) => candidate.isDefault)) {
      model.isDefault = true;
    }
    const saved = await writeModelsToBranchState(ctx, {
      branchState,
      models: next,
    });
    return {
      branchStateId: branchState._id,
      branchStateName: branchState.name,
      redirected: branchState._id !== currentBranchState._id,
      models: saved,
    };
  },
});

export const setDefaultModel = mutation({
  args: {
    branchStateId: v.id("branchStates"),
    id: v.string(),
  },
  returns: vBranchStateModelMutationResult,
  handler: async (ctx, args) => {
    const currentBranchState = await getBranchStateOrThrow(ctx, args.branchStateId);
    const { user } = await requireWorkspaceAdmin(ctx, currentBranchState.workspaceId);
    const branchState = await ensureWritableBranchStateHandler(ctx, {
      branchStateId: currentBranchState._id,
      createdByUserId: user.subject,
    });
    const next = (await loadModelsFromBranchState(ctx, branchState)).map((model) => ({ ...model, isDefault: false }));
    const modelId = args.id.trim();
    const target = next.find((model) => getWorkspaceModelId(model) === modelId);
    if (!target) {
      throw new Error(`Model "${modelId}" not found in workspace`);
    }
    target.isDefault = true;
    const saved = await writeModelsToBranchState(ctx, {
      branchState,
      models: next,
    });
    return {
      branchStateId: branchState._id,
      branchStateName: branchState.name,
      redirected: branchState._id !== currentBranchState._id,
      models: saved,
    };
  },
});
