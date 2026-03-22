/**
 * Compilation pipeline for workspace filesystem.
 * Compiles workspace source files into bundles and revision filesystem artifacts.
 * Creates revisions that store compiled artifacts in file storage.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalAction, internalQuery, query } from "./_generated/server";
import { requireWorkspaceMember } from "./authz";
import { type CompileSource, vCompileSource } from "./compileSource";
import { computeWorkingStateHash } from "./workingStateHash";

type CompileSnapshotArtifact = {
  files: Array<{ path: string; content: string; binary?: boolean }>;
};

type PublicCompileJobStatus = {
  status: "pending" | "running" | "completed" | "failed" | "canceled";
  compileJobId: Id<"compileJobs">;
  revisionId?: Id<"revisions">;
  revisionFs?: {
    declarationCount?: number;
    fileCount?: number;
    systemCount?: number;
  };
  compilerVersion?: string;
  sourceFingerprint?: string;
  artifactFingerprint?: string;
  error?: string;
};

type PublicRevisionBuildDetails = {
  revisionId: Id<"revisions">;
  compileMode?: "local" | "server";
  compilerVersion?: string;
  sourceFingerprint?: string;
  artifactFingerprint?: string;
  manifest?: {
    schemaVersion: number;
    compilerVersion: string;
    sourceFingerprint: string;
    mode: "local" | "server";
    createdAt?: string;
    artifactFingerprint?: string;
    artifacts: {
      revisionFs: { path?: string; hash: string; size: number };
      bundle: { path?: string; hash: string; size: number };
      metadata: { path?: string; hash: string; size: number };
      diagnostics: { path?: string; hash: string; size: number };
      deps?: { path?: string; hash: string; size: number };
    };
  };
  diagnostics?: {
    declarationDiagnostics: Array<{ file?: string; message: string; line?: number; column?: number; code: number }>;
    timingsMs: Record<string, number>;
    warnings: string[];
  };
};

async function enqueueRevisionCompileJob(
  ctx: any,
  args: {
    workspaceId: Id<"workspaces">;
    branchId: Id<"branches">;
    source: CompileSource;
    checkExistingRevision: boolean;
  },
): Promise<{
  existingRevisionId?: Id<"revisions">;
  compileJobId?: Id<"compileJobs">;
  commitId: Id<"commits">;
  workingStateHash?: string;
}> {
  const branch = await ctx.runQuery(internal.vcs.getBranchInternal, {
    branchId: args.branchId,
  });
  if (!branch) {
    throw new Error("Branch not found");
  }
  if (branch.workspaceId !== args.workspaceId) {
    throw new Error("Branch does not belong to workspace");
  }

  const commit = await ctx.runQuery(internal.vcs.getCommitInternal, { commitId: branch.commitId });
  if (!commit) {
    throw new Error("Commit not found");
  }

  const rawFiles: Array<{ path: string; content?: string; downloadUrl?: string; size: number }> = await ctx.runQuery(
    internal.trees.getAllFiles,
    { treeId: commit.treeId },
  );
  const files = await resolveFilesWithContent(rawFiles);

  let workingChanges: Array<{
    path: string;
    content?: string;
    blobId?: Id<"blobs">;
    downloadUrl?: string;
    isDeleted: boolean;
  }> = [];
  let workingStateHash: string | undefined;
  let branchStateId: Id<"branchStates"> | undefined;
  let userId: string | undefined;

  if (args.source.kind === "branch") {
    workingStateHash = args.source.workingStateHash;
    userId = args.source.userId;
    if (args.source.includeWorkingState && !args.source.userId) {
      throw new Error("userId is required when includeWorkingState is true");
    }
    if (args.source.includeWorkingState && args.source.userId) {
      workingChanges = await ctx.runQuery(internal.fs.working.getChanges, {
        branchId: args.branchId,
        userId: args.source.userId,
      });

      if (workingChanges.length > 0) {
        workingStateHash = computeWorkingStateHash(workingChanges);
      }
    }
  } else {
    const branchState = await ctx.runQuery(internal.branchStates.getInternal, {
      branchStateId: args.source.branchStateId,
    });
    if (!branchState || branchState.workspaceId !== args.workspaceId) {
      throw new Error("Branch state not found or does not belong to workspace");
    }
    if (branchState.backingBranchId !== args.branchId) {
      throw new Error("Branch state does not belong to the requested branch");
    }
    branchStateId = branchState._id;
    workingChanges = await ctx.runQuery(internal.fs.working.getChangesForBranchState, {
      branchStateId: branchState._id,
    });
    if (workingChanges.length > 0) {
      workingStateHash = computeWorkingStateHash(workingChanges);
    }
  }

  if (workingChanges.length > 0) {
    const fileMap = new Map(files.map((f) => [f.path, f]));
    for (const change of workingChanges) {
      const binary = isBinaryPath(change.path);
      if (change.isDeleted) {
        fileMap.delete(change.path);
      } else if (change.content !== undefined) {
        fileMap.set(change.path, {
          path: change.path,
          content: change.content,
          size: change.content.length,
          binary,
        });
      } else if (change.downloadUrl) {
        const content = binary
          ? await fetchBinaryFromUrl(change.downloadUrl)
          : await fetchTextFromUrl(change.downloadUrl);
        fileMap.set(change.path, {
          path: change.path,
          content,
          size: content.length,
          binary,
        });
      } else {
        throw new Error(`Cannot compile file "${change.path}": no content available (missing blob or inline content)`);
      }
    }
    files.length = 0;
    files.push(...fileMap.values());
  }

  if (
    args.source.kind === "branch" &&
    args.source.workingStateHash &&
    workingStateHash !== args.source.workingStateHash
  ) {
    throw new Error("Working state hash mismatch");
  }

  if (args.checkExistingRevision) {
    const existingRevision = await ctx.runQuery(internal.revisions.findRevision, {
      branchId: args.branchId,
      branchStateId,
      commitId: branch.commitId,
      workingStateHash,
    });
    if (existingRevision) {
      return {
        existingRevisionId: existingRevision._id,
        commitId: branch.commitId,
        workingStateHash,
      };
    }
  }

  const snapshotStorageId = await ctx.storage.store(
    new Blob(
      [
        JSON.stringify({
          files: files.map((file) => ({
            path: file.path,
            content: file.content,
            binary: file.binary,
          })),
        } satisfies CompileSnapshotArtifact),
      ],
      { type: "application/json" },
    ),
  );

  const compileJobId = await ctx.runMutation(internal.compileJobs.createCompileJob, {
    workspaceId: args.workspaceId,
    sourceKind: args.source.kind,
    branchId: args.branchId,
    branchStateId,
    commitId: branch.commitId,
    workingStateHash,
    userId,
    snapshotStorageId,
  });

  return {
    compileJobId,
    commitId: branch.commitId,
    workingStateHash,
  };
}

function normalizeCompileSource(args: {
  source?: CompileSource;
  branchStateId?: Id<"branchStates">;
  includeWorkingState?: boolean;
  workingStateHash?: string;
  userId?: string;
}): CompileSource {
  if (args.source) {
    return args.source;
  }
  if (args.branchStateId) {
    return {
      kind: "branchState",
      branchStateId: args.branchStateId,
    };
  }
  return {
    kind: "branch",
    includeWorkingState: args.includeWorkingState,
    workingStateHash: args.workingStateHash,
    userId: args.userId,
  };
}

// ============================================================================
// Compilation Types
// ============================================================================

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".pdf",
  ".zip",
  ".lockb",
]);

function isBinaryPath(path: string): boolean {
  const match = path.toLowerCase().match(/\.[^./]+$/);
  if (!match) {
    return false;
  }
  return BINARY_EXTENSIONS.has(match[0]);
}

export type RevisionFilesystemArtifact = {
  /** Compiled .d.ts files (paths already have src/ stripped) */
  declarations: Array<{ fileName: string; content: string }>;
  /** All passthrough files (docs/, memory/, skills/, TOKENSPACE.md, CAPABILITY.md, etc.) */
  files: Array<{ path: string; content: string; binary?: boolean }>;
  /** Platform-injected system content */
  system: Array<{ path: string; content: string }>;
  /** Builtins declaration content */
  builtins: string;
};

export type BundleArtifact = {
  /** Compiled JavaScript bundle code ready for runtime execution */
  code: string;
};

async function fetchTextFromUrl(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`Failed to download file content (${response.status})`);
  }
  return await response.text();
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

async function fetchBinaryFromUrl(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`Failed to download file content (${response.status})`);
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  return bytesToBase64(buffer);
}

async function resolveFilesWithContent(
  files: Array<{ path: string; content?: string; downloadUrl?: string; size: number }>,
): Promise<Array<{ path: string; content: string; size: number; binary?: boolean }>> {
  const resolved: Array<{ path: string; content: string; size: number; binary?: boolean }> = [];
  for (const file of files) {
    const binary = isBinaryPath(file.path);
    if (file.content !== undefined) {
      resolved.push({ path: file.path, content: file.content, size: file.size, binary });
      continue;
    }
    if (file.downloadUrl) {
      const content = binary ? await fetchBinaryFromUrl(file.downloadUrl) : await fetchTextFromUrl(file.downloadUrl);
      resolved.push({ path: file.path, content, size: file.size, binary });
    }
  }
  return resolved;
}

// export const getWorkingChanges = internalQuery({
//   args: {
//     branchId: v.id("branches"),
//     userId: v.string(),
//   },
//   returns: v.array(v.object({
//     path: v.string(),
//   })),
//   handler: async (ctx, args) => {
//     let workingChanges: Array<{ path: string; content?: string; isDeleted: boolean }> = [];

//     if (args.includeWorkingState && args.userId) {
//       workingChanges = await ctx.runQuery(internal.fs.working.getChanges, {
//         branchId: args.branchId,
//         userId: args.userId,
//       });

//       if (workingChanges.length > 0) {
//         workingStateHash = computeWorkingStateHash(workingChanges);
//       }
//     }

//   },
// });

export const getRevision = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    branchId: v.id("branches"),
    branchStateId: v.optional(v.id("branchStates")),
    workingStateHash: v.optional(v.string()),
  },
  returns: v.union(v.id("revisions"), v.null()),
  handler: async (ctx, args): Promise<Id<"revisions"> | null> => {
    // Get branch to find its commit
    const branch = await ctx.runQuery(internal.vcs.getBranchInternal, {
      branchId: args.branchId,
    });
    if (!branch) {
      throw new Error("Branch not found");
    }
    if (branch.workspaceId !== args.workspaceId) {
      throw new Error("Branch does not belong to workspace");
    }

    // Check if revision already exists
    const existingRevision = await ctx.runQuery(internal.revisions.findRevision, {
      branchId: args.branchId,
      branchStateId: args.branchStateId,
      commitId: branch.commitId,
      workingStateHash: args.workingStateHash,
    });

    return existingRevision?._id ?? null;
  },
});

/**
 * Get revision filesystem artifact from a revision
 */
export const getRevisionFsFromRevision = internalAction({
  args: {
    revisionId: v.id("revisions"),
  },
  handler: async (ctx, args): Promise<RevisionFilesystemArtifact> => {
    const revision = await ctx.runQuery(internal.revisions.getRevision, {
      revisionId: args.revisionId,
    });

    if (!revision) {
      throw new Error("Revision not found");
    }

    if (!revision.revisionFsStorageId) {
      throw new Error("Revision has no filesystem artifact");
    }

    const blob = await ctx.storage.get(revision.revisionFsStorageId);
    if (!blob) {
      throw new Error("Revision filesystem artifact not found in storage");
    }

    const text = await blob.text();
    return JSON.parse(text) as RevisionFilesystemArtifact;
  },
});

/**
 * Get bundle artifact from a revision
 */
export const getBundleFromRevision = internalAction({
  args: {
    revisionId: v.id("revisions"),
  },
  handler: async (ctx, args): Promise<BundleArtifact> => {
    const revision = await ctx.runQuery(internal.revisions.getRevision, {
      revisionId: args.revisionId,
    });

    if (!revision) {
      throw new Error("Revision not found");
    }

    const blob = await ctx.storage.get(revision.bundleStorageId);
    if (!blob) {
      throw new Error("Bundle artifact not found in storage");
    }

    const code = await blob.text();
    return { code };
  },
});

// ============================================================================
// Revision Filesystem Materialization
// ============================================================================

/**
 * Helper to parse a file path into parent directory and name
 */
function parsePath(path: string): { parent: string | undefined; name: string } {
  const parts = path.split("/");
  return { parent: parts.slice(0, -1).join("/") || undefined, name: parts[parts.length - 1]! };
}

/**
 * Materialize revision filesystem files from a revision's stored artifact.
 * This populates the revisionFiles table from the revision's file storage.
 */
export const materializeRevisionFiles = internalAction({
  args: {
    revisionId: v.id("revisions"),
  },
  handler: async (ctx, args): Promise<{ fileCount: number }> => {
    // Check if already materialized
    const hasRevisionFs = await ctx.runQuery(internal.fs.revision.exists, {
      revisionId: args.revisionId,
    });

    if (hasRevisionFs) {
      // Already materialized
      const files = await ctx.runQuery(internal.fs.revision.list, {
        revisionId: args.revisionId,
      });
      return { fileCount: files.length };
    }

    // Get revision filesystem artifact from storage
    const revisionFsArtifact = await ctx.runAction(internal.compile.getRevisionFsFromRevision, {
      revisionId: args.revisionId,
    });

    let fileCount = 0;

    // Write declarations (paths already have src/ stripped)
    // e.g., capabilities/github/capability.d.ts
    for (const decl of revisionFsArtifact.declarations) {
      const { parent, name } = parsePath(decl.fileName);
      await ctx.runAction(internal.fs.revision.write, {
        revisionId: args.revisionId,
        parent,
        name,
        content: decl.content,
        binary: false,
      });
      fileCount++;
    }

    // Write passthrough files (docs/, memory/, skills/, TOKENSPACE.md, CAPABILITY.md, etc.)
    for (const file of revisionFsArtifact.files) {
      const { parent, name } = parsePath(file.path);
      await ctx.runAction(internal.fs.revision.write, {
        revisionId: args.revisionId,
        parent,
        name,
        content: file.content,
        binary: file.binary ?? false,
      });
      fileCount++;
    }

    // Write system content (platform-injected)
    for (const file of revisionFsArtifact.system) {
      const { parent, name } = parsePath(`system/${file.path}`);
      await ctx.runAction(internal.fs.revision.write, {
        revisionId: args.revisionId,
        parent,
        name,
        content: file.content,
        binary: false,
      });
      fileCount++;
    }

    // Write builtins.d.ts at root
    await ctx.runAction(internal.fs.revision.write, {
      revisionId: args.revisionId,
      parent: undefined,
      name: "builtins.d.ts",
      content: revisionFsArtifact.builtins,
      binary: false,
    });
    fileCount++;

    return { fileCount };
  },
});

/**
 * Delete materialized revision filesystem files for a revision.
 * The revision's stored artifact remains in file storage.
 */
export const dematerializeRevisionFiles = internalAction({
  args: {
    revisionId: v.id("revisions"),
  },
  handler: async (ctx, args): Promise<{ deletedCount: number }> => {
    const deletedCount = await ctx.runMutation(internal.fs.revision.clear, {
      revisionId: args.revisionId,
    });

    return { deletedCount };
  },
});

export const enqueueBranchCompile = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    branchId: v.id("branches"),
    source: v.optional(vCompileSource),
    branchStateId: v.optional(v.id("branchStates")),
    includeWorkingState: v.optional(v.boolean()),
    workingStateHash: v.optional(v.string()),
    userId: v.optional(v.string()),
    checkExistingRevision: v.optional(v.boolean()),
  },
  returns: v.object({
    compileJobId: v.optional(v.id("compileJobs")),
    existingRevisionId: v.optional(v.id("revisions")),
  }),
  handler: async (ctx, args) => {
    const result = await enqueueRevisionCompileJob(ctx, {
      workspaceId: args.workspaceId,
      branchId: args.branchId,
      source: normalizeCompileSource(args),
      checkExistingRevision: args.checkExistingRevision ?? false,
    });
    return {
      compileJobId: result.compileJobId,
      existingRevisionId: result.existingRevisionId,
    };
  },
});

// ============================================================================
// Public Actions
// ============================================================================

/**
 * Compile and create a revision for a workspace's default branch
 */
export const compileDefaultBranch = action({
  args: {
    workspaceId: v.id("workspaces"),
  },
  returns: v.object({
    compileJobId: v.id("compileJobs"),
  }),
  handler: async (ctx, args): Promise<{ compileJobId: Id<"compileJobs"> }> => {
    const { user } = await requireWorkspaceMember(ctx, args.workspaceId);
    // Get default branch
    const branch = await ctx.runQuery(internal.vcs.getDefaultBranchInternal, {
      workspaceId: args.workspaceId,
    });

    if (!branch) {
      throw new Error("No default branch found for workspace");
    }

    const queued = await ctx.runAction(internal.compile.enqueueBranchCompile, {
      workspaceId: args.workspaceId,
      branchId: branch._id,
      source: {
        kind: "branch",
        includeWorkingState: false,
        userId: user.subject,
      },
      checkExistingRevision: false,
    });
    if (!queued.compileJobId) {
      throw new Error("Compile job was not created");
    }
    return { compileJobId: queued.compileJobId };
  },
});

/**
 * Compile and create a revision for a specific branch
 */
export const compileBranch = action({
  args: {
    workspaceId: v.id("workspaces"),
    branchId: v.id("branches"),
    includeWorkingState: v.optional(v.boolean()),
  },
  returns: v.object({
    compileJobId: v.id("compileJobs"),
  }),
  handler: async (ctx, args): Promise<{ compileJobId: Id<"compileJobs"> }> => {
    const { user } = await requireWorkspaceMember(ctx, args.workspaceId);

    const queued = await ctx.runAction(internal.compile.enqueueBranchCompile, {
      workspaceId: args.workspaceId,
      branchId: args.branchId,
      source: {
        kind: "branch",
        includeWorkingState: args.includeWorkingState,
        userId: user.subject,
      },
      checkExistingRevision: false,
    });
    if (!queued.compileJobId) {
      throw new Error("Compile job was not created");
    }
    return { compileJobId: queued.compileJobId };
  },
});

export const getCompileJob = query({
  args: {
    workspaceId: v.id("workspaces"),
    compileJobId: v.id("compileJobs"),
  },
  returns: v.object({
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("canceled"),
    ),
    compileJobId: v.id("compileJobs"),
    revisionId: v.optional(v.id("revisions")),
    revisionFs: v.optional(
      v.object({
        declarationCount: v.optional(v.number()),
        fileCount: v.optional(v.number()),
        systemCount: v.optional(v.number()),
      }),
    ),
    compilerVersion: v.optional(v.string()),
    sourceFingerprint: v.optional(v.string()),
    artifactFingerprint: v.optional(v.string()),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args): Promise<PublicCompileJobStatus> => {
    await requireWorkspaceMember(ctx, args.workspaceId);
    const job = (await ctx.runQuery(internal.compileJobs.getCompileJob, {
      compileJobId: args.compileJobId,
    })) as Doc<"compileJobs"> | null;
    if (!job || job.workspaceId !== args.workspaceId) {
      throw new Error("Compile job not found");
    }

    if (job.status === "completed") {
      if (!job.revisionId) {
        throw new Error("Compile job completed without revisionId");
      }
      return {
        status: "completed" as const,
        compileJobId: job._id,
        revisionId: job.revisionId,
        revisionFs: {
          declarationCount: job.revisionFsDeclarationCount,
          fileCount: job.revisionFsFileCount,
          systemCount: job.revisionFsSystemCount,
        },
        compilerVersion: job.compilerVersion,
        sourceFingerprint: job.sourceFingerprint,
        artifactFingerprint: job.artifactFingerprint,
      };
    }

    if (job.status === "failed") {
      return {
        status: "failed" as const,
        compileJobId: job._id,
        error: job.error?.message ?? "Compile job failed",
      };
    }

    if (job.status === "canceled") {
      return {
        status: "canceled" as const,
        compileJobId: job._id,
        error: job.error?.message ?? "Compile job canceled",
      };
    }

    return {
      status: job.status,
      compileJobId: job._id,
    };
  },
});

const vRevisionBuildDetails = v.object({
  revisionId: v.id("revisions"),
  compileMode: v.optional(v.union(v.literal("local"), v.literal("server"))),
  compilerVersion: v.optional(v.string()),
  sourceFingerprint: v.optional(v.string()),
  artifactFingerprint: v.optional(v.string()),
  manifest: v.optional(
    v.object({
      schemaVersion: v.number(),
      compilerVersion: v.string(),
      sourceFingerprint: v.string(),
      mode: v.union(v.literal("local"), v.literal("server")),
      createdAt: v.optional(v.string()),
      artifactFingerprint: v.optional(v.string()),
      artifacts: v.object({
        revisionFs: v.object({
          path: v.optional(v.string()),
          hash: v.string(),
          size: v.number(),
        }),
        bundle: v.object({
          path: v.optional(v.string()),
          hash: v.string(),
          size: v.number(),
        }),
        metadata: v.object({
          path: v.optional(v.string()),
          hash: v.string(),
          size: v.number(),
        }),
        diagnostics: v.object({
          path: v.optional(v.string()),
          hash: v.string(),
          size: v.number(),
        }),
        deps: v.optional(
          v.object({
            path: v.optional(v.string()),
            hash: v.string(),
            size: v.number(),
          }),
        ),
      }),
    }),
  ),
  diagnostics: v.optional(
    v.object({
      declarationDiagnostics: v.array(
        v.object({
          file: v.optional(v.string()),
          message: v.string(),
          line: v.optional(v.number()),
          column: v.optional(v.number()),
          code: v.number(),
        }),
      ),
      timingsMs: v.record(v.string(), v.number()),
      warnings: v.array(v.string()),
    }),
  ),
});

async function loadRevisionBuildDetails(
  ctx: any,
  args: {
    workspaceId: Id<"workspaces">;
    revisionId: Id<"revisions">;
  },
): Promise<PublicRevisionBuildDetails> {
  const revision = await ctx.runQuery(internal.revisions.getRevision, {
    revisionId: args.revisionId,
  });
  if (!revision || revision.workspaceId !== args.workspaceId) {
    throw new Error("Revision not found");
  }

  let manifest: PublicRevisionBuildDetails["manifest"];
  if (revision.manifestStorageId) {
    const blob = await ctx.storage.get(revision.manifestStorageId);
    if (blob) {
      manifest = JSON.parse(await blob.text()) as PublicRevisionBuildDetails["manifest"];
    }
  }

  let diagnostics: PublicRevisionBuildDetails["diagnostics"];
  if (revision.diagnosticsStorageId) {
    const blob = await ctx.storage.get(revision.diagnosticsStorageId);
    if (blob) {
      diagnostics = JSON.parse(await blob.text()) as PublicRevisionBuildDetails["diagnostics"];
    }
  }

  return {
    revisionId: revision._id,
    compileMode: revision.compileMode,
    compilerVersion: revision.compilerVersion,
    sourceFingerprint: revision.sourceFingerprint,
    artifactFingerprint: revision.artifactFingerprint,
    manifest,
    diagnostics,
  };
}

export const getRevisionBuildDetails = action({
  args: {
    workspaceId: v.id("workspaces"),
    revisionId: v.id("revisions"),
  },
  returns: vRevisionBuildDetails,
  handler: async (ctx, args): Promise<PublicRevisionBuildDetails> => {
    await requireWorkspaceMember(ctx, args.workspaceId);
    return await loadRevisionBuildDetails(ctx, args);
  },
});

export const getRevisionBuildDetailsInternal = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    revisionId: v.id("revisions"),
  },
  returns: vRevisionBuildDetails,
  handler: async (ctx, args): Promise<PublicRevisionBuildDetails> => {
    return await loadRevisionBuildDetails(ctx, args);
  },
});
