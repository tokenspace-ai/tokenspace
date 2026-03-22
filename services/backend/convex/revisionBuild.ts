import { getSystemContentFiles } from "@tokenspace/system-content";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalAction } from "./_generated/server";
import { requireWorkspaceAdmin } from "./authz";
import { type ResolvedRevisionBuildSource, resolveRevisionBuildSource, vRevisionBuildSource } from "./revisionSource";
import { extractPromptMetadataFromEntries, getDefaultWorkspaceModels } from "./workspaceMetadata";

type ArtifactName = "revisionFs" | "bundle" | "metadata" | "diagnostics" | "deps";

type BuildManifestSummary = {
  schemaVersion: number;
  compilerVersion: string;
  sourceFingerprint: string;
  mode: "local" | "server";
  artifacts: {
    revisionFs: { hash: string; size: number };
    bundle: { hash: string; size: number };
    metadata: { hash: string; size: number };
    diagnostics: { hash: string; size: number };
    deps?: { hash: string; size: number };
  };
};

type ArtifactReference =
  | { blobId: Id<"blobs">; hash: string; size: number }
  | { storageId: Id<"_storage">; hash: string; size: number };

type PrepareResult =
  | { kind: "existing"; revisionId: Id<"revisions"> }
  | {
      kind: "upload";
      commitId: Id<"commits">;
      artifactFingerprint: string;
      upload: {
        revisionFs: { kind: "existing"; blobId: Id<"blobs"> } | { kind: "upload"; uploadUrl: string };
        bundle: { kind: "existing"; blobId: Id<"blobs"> } | { kind: "upload"; uploadUrl: string };
        metadata: { kind: "existing"; blobId: Id<"blobs"> } | { kind: "upload"; uploadUrl: string };
        diagnostics: { kind: "existing"; blobId: Id<"blobs"> } | { kind: "upload"; uploadUrl: string };
        deps?: { kind: "existing"; blobId: Id<"blobs"> } | { kind: "upload"; uploadUrl: string };
      };
    };

type CommitResult = { revisionId: Id<"revisions">; created: boolean };

type ParsedRevisionFsArtifact = {
  declarations: Array<{ fileName: string; content: string }>;
  files: Array<{ path: string; content: string; binary?: boolean }>;
  system: Array<{ path: string; content: string }>;
  builtins: string;
};

const vBuildArtifact = v.object({
  hash: v.string(),
  size: v.number(),
});

const SUPPORTED_BUILD_SCHEMA_VERSION = 1;

const vBuildManifestSummary = v.object({
  schemaVersion: v.number(),
  compilerVersion: v.string(),
  sourceFingerprint: v.string(),
  mode: v.union(v.literal("local"), v.literal("server")),
  artifacts: v.object({
    revisionFs: vBuildArtifact,
    bundle: vBuildArtifact,
    metadata: vBuildArtifact,
    diagnostics: vBuildArtifact,
    deps: v.optional(vBuildArtifact),
  }),
});

const vUploadInstruction = v.union(
  v.object({ kind: v.literal("existing"), blobId: v.id("blobs") }),
  v.object({ kind: v.literal("upload"), uploadUrl: v.string() }),
);

const vArtifactReference = v.union(
  v.object({
    blobId: v.id("blobs"),
    hash: v.string(),
    size: v.number(),
  }),
  v.object({
    storageId: v.id("_storage"),
    hash: v.string(),
    size: v.number(),
  }),
);

function makeArtifactFingerprint(args: {
  revisionFsHash: string;
  bundleHash: string;
  metadataHash: string;
  diagnosticsHash: string;
  depsHash?: string;
}): string {
  return [args.revisionFsHash, args.bundleHash, args.metadataHash, args.diagnosticsHash, args.depsHash ?? ""].join(":");
}

function isStorageRef(ref: ArtifactReference): ref is { storageId: Id<"_storage">; hash: string; size: number } {
  return "storageId" in ref;
}

function validateSystemContentPath(path: string): void {
  if (!path) throw new Error("System content path cannot be empty");
  if (path.startsWith("/")) throw new Error(`System content path must be relative: "${path}"`);
  if (path.includes("\\")) throw new Error(`System content path must use "/" separators: "${path}"`);
  if (path.startsWith("system/")) throw new Error(`System content path must be relative to system/: "${path}"`);
  if (path.includes("\0")) throw new Error(`System content path contains null byte: "${path}"`);

  const parts = path.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === "..") {
      throw new Error(`Invalid system content path segment in "${path}"`);
    }
  }
}

function loadSystemContent(): Array<{ path: string; content: string }> {
  const files = getSystemContentFiles();
  const byPath = new Map<string, string>();

  for (const file of files) {
    validateSystemContentPath(file.path);
    if (byPath.has(file.path)) {
      throw new Error(`Duplicate system content path: "${file.path}"`);
    }
    byPath.set(file.path, file.content);
  }

  return [...byPath.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => ({ path, content }));
}

function parseRevisionFsArtifact(text: string): ParsedRevisionFsArtifact {
  const parsed = JSON.parse(text) as {
    declarations?: unknown;
    files?: unknown;
    system?: unknown;
    builtins?: unknown;
  };

  if (!Array.isArray(parsed.declarations)) {
    throw new Error("Invalid revisionFs artifact: declarations must be an array");
  }
  if (!Array.isArray(parsed.files)) {
    throw new Error("Invalid revisionFs artifact: files must be an array");
  }
  if (typeof parsed.builtins !== "string") {
    throw new Error("Invalid revisionFs artifact: builtins must be a string");
  }

  const declarations = parsed.declarations.map((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Invalid revisionFs artifact: declarations[${i}] must be an object`);
    }
    const value = entry as Record<string, unknown>;
    if (typeof value.fileName !== "string" || typeof value.content !== "string") {
      throw new Error(`Invalid revisionFs artifact: declarations[${i}] must include string fileName/content`);
    }
    return {
      fileName: value.fileName,
      content: value.content,
    };
  });

  const files = parsed.files.map((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Invalid revisionFs artifact: files[${i}] must be an object`);
    }
    const value = entry as Record<string, unknown>;
    if (typeof value.path !== "string" || typeof value.content !== "string") {
      throw new Error(`Invalid revisionFs artifact: files[${i}] must include string path/content`);
    }
    if (value.binary !== undefined && typeof value.binary !== "boolean") {
      throw new Error(`Invalid revisionFs artifact: files[${i}].binary must be boolean when provided`);
    }
    return {
      path: value.path,
      content: value.content,
      binary: value.binary as boolean | undefined,
    };
  });

  let system: ParsedRevisionFsArtifact["system"] = [];
  if (parsed.system !== undefined) {
    if (!Array.isArray(parsed.system)) {
      throw new Error("Invalid revisionFs artifact: system must be an array when provided");
    }
    system = parsed.system.map((entry, i) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`Invalid revisionFs artifact: system[${i}] must be an object`);
      }
      const value = entry as Record<string, unknown>;
      if (typeof value.path !== "string" || typeof value.content !== "string") {
        throw new Error(`Invalid revisionFs artifact: system[${i}] must include string path/content`);
      }
      return { path: value.path, content: value.content };
    });
  }

  return {
    declarations,
    files,
    system,
    builtins: parsed.builtins,
  };
}

function assertArtifactReferenceMatchesManifest(
  name: ArtifactName,
  ref: ArtifactReference,
  manifestArtifact: { hash: string; size: number },
): void {
  if (ref.hash !== manifestArtifact.hash || ref.size !== manifestArtifact.size) {
    throw new Error(`Artifact mismatch for ${name}: does not match manifest hash/size`);
  }
}

function normalizeModels(models: unknown): ReturnType<typeof getDefaultWorkspaceModels> {
  if (!Array.isArray(models) || models.length === 0) {
    return getDefaultWorkspaceModels();
  }
  return models as ReturnType<typeof getDefaultWorkspaceModels>;
}

async function resolveArtifactStorageId(
  ctx: any,
  args: {
    workspaceId: Id<"workspaces">;
    ref: ArtifactReference;
    name: ArtifactName;
  },
): Promise<Id<"_storage">> {
  if (!isStorageRef(args.ref)) {
    const blob = await ctx.runQuery(internal.content.getBlob, {
      blobId: args.ref.blobId,
    });
    if (!blob || blob.workspaceId !== args.workspaceId) {
      throw new Error(`Invalid blob reference for ${args.name}`);
    }
    if (blob.hash !== args.ref.hash) {
      throw new Error(`Hash mismatch for ${args.name}`);
    }
    if (!blob.storageId) {
      throw new Error(`Blob storage missing for ${args.name}`);
    }
    return blob.storageId;
  }

  const blobId = await ctx.runAction(internal.content.getOrCreateBlobFromStorage, {
    workspaceId: args.workspaceId,
    hash: args.ref.hash,
    storageId: args.ref.storageId,
    size: args.ref.size,
  });

  const blob = await ctx.runQuery(internal.content.getBlob, {
    blobId,
  });
  if (!blob?.storageId) {
    throw new Error(`Failed to resolve storage for ${args.name}`);
  }
  return blob.storageId;
}

async function readStorageText(ctx: any, storageId: Id<"_storage">, label: string): Promise<string> {
  const blob = await ctx.storage.get(storageId);
  if (!blob) {
    throw new Error(`${label} artifact not found in storage`);
  }
  return await blob.text();
}

async function prepareRevisionFromBuildImpl(
  ctx: any,
  args: {
    workspaceId: Id<"workspaces">;
    source: ResolvedRevisionBuildSource;
    manifest: BuildManifestSummary;
  },
): Promise<PrepareResult> {
  if (args.manifest.schemaVersion !== SUPPORTED_BUILD_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported build manifest schemaVersion ${args.manifest.schemaVersion}; expected ${SUPPORTED_BUILD_SCHEMA_VERSION}`,
    );
  }

  const artifactFingerprint = makeArtifactFingerprint({
    revisionFsHash: args.manifest.artifacts.revisionFs.hash,
    bundleHash: args.manifest.artifacts.bundle.hash,
    metadataHash: args.manifest.artifacts.metadata.hash,
    diagnosticsHash: args.manifest.artifacts.diagnostics.hash,
    depsHash: args.manifest.artifacts.deps?.hash,
  });

  const existingRevision = await ctx.runQuery(internal.revisions.findRevision, {
    branchId: args.source.branchId,
    branchStateId: args.source.branchStateId,
    commitId: args.source.commitId,
    workingStateHash: args.source.workingStateHash,
    sourceSnapshotHash: args.source.sourceSnapshotHash,
    artifactFingerprint,
  });

  if (existingRevision) {
    return {
      kind: "existing" as const,
      revisionId: existingRevision._id,
    };
  }

  const resolveUploadInstruction = async (artifact: {
    hash: string;
    size: number;
  }): Promise<{ kind: "existing"; blobId: Id<"blobs"> } | { kind: "upload"; uploadUrl: string }> => {
    const existingBlob = await ctx.runQuery(internal.content.getBlobByHash, {
      workspaceId: args.workspaceId,
      hash: artifact.hash,
    });

    if (existingBlob) {
      return { kind: "existing", blobId: existingBlob._id };
    }

    return {
      kind: "upload",
      uploadUrl: await ctx.storage.generateUploadUrl(),
    };
  };

  return {
    kind: "upload" as const,
    commitId: args.source.commitId,
    artifactFingerprint,
    upload: {
      revisionFs: await resolveUploadInstruction(args.manifest.artifacts.revisionFs),
      bundle: await resolveUploadInstruction(args.manifest.artifacts.bundle),
      metadata: await resolveUploadInstruction(args.manifest.artifacts.metadata),
      diagnostics: await resolveUploadInstruction(args.manifest.artifacts.diagnostics),
      deps: args.manifest.artifacts.deps ? await resolveUploadInstruction(args.manifest.artifacts.deps) : undefined,
    },
  };
}

async function commitRevisionFromBuildImpl(
  ctx: any,
  args: {
    workspaceId: Id<"workspaces">;
    source: ResolvedRevisionBuildSource;
    commitId: Id<"commits">;
    artifactFingerprint: string;
    manifest: BuildManifestSummary;
    artifacts: {
      revisionFs: ArtifactReference;
      bundle: ArtifactReference;
      metadata: ArtifactReference;
      diagnostics: ArtifactReference;
      deps?: ArtifactReference;
    };
  },
): Promise<CommitResult> {
  if (args.manifest.schemaVersion !== SUPPORTED_BUILD_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported build manifest schemaVersion ${args.manifest.schemaVersion}; expected ${SUPPORTED_BUILD_SCHEMA_VERSION}`,
    );
  }

  const expectedArtifactFingerprint = makeArtifactFingerprint({
    revisionFsHash: args.manifest.artifacts.revisionFs.hash,
    bundleHash: args.manifest.artifacts.bundle.hash,
    metadataHash: args.manifest.artifacts.metadata.hash,
    diagnosticsHash: args.manifest.artifacts.diagnostics.hash,
    depsHash: args.manifest.artifacts.deps?.hash,
  });
  if (expectedArtifactFingerprint !== args.artifactFingerprint) {
    throw new Error("artifactFingerprint does not match manifest");
  }

  assertArtifactReferenceMatchesManifest("revisionFs", args.artifacts.revisionFs, args.manifest.artifacts.revisionFs);
  assertArtifactReferenceMatchesManifest("bundle", args.artifacts.bundle, args.manifest.artifacts.bundle);
  assertArtifactReferenceMatchesManifest("metadata", args.artifacts.metadata, args.manifest.artifacts.metadata);
  assertArtifactReferenceMatchesManifest(
    "diagnostics",
    args.artifacts.diagnostics,
    args.manifest.artifacts.diagnostics,
  );
  if (args.manifest.artifacts.deps) {
    if (!args.artifacts.deps) {
      throw new Error("Artifact mismatch for deps: missing artifact reference");
    }
    assertArtifactReferenceMatchesManifest("deps", args.artifacts.deps, args.manifest.artifacts.deps);
  } else if (args.artifacts.deps) {
    throw new Error("Artifact mismatch for deps: unexpected artifact reference");
  }

  if (args.source.commitId !== args.commitId) {
    throw new Error("Commit mismatch: branch head changed before commit");
  }

  const uploadedRevisionFsStorageId = await resolveArtifactStorageId(ctx, {
    workspaceId: args.workspaceId,
    ref: args.artifacts.revisionFs,
    name: "revisionFs",
  });
  const bundleStorageId = await resolveArtifactStorageId(ctx, {
    workspaceId: args.workspaceId,
    ref: args.artifacts.bundle,
    name: "bundle",
  });
  const metadataStorageId = await resolveArtifactStorageId(ctx, {
    workspaceId: args.workspaceId,
    ref: args.artifacts.metadata,
    name: "metadata",
  });
  const diagnosticsStorageId = await resolveArtifactStorageId(ctx, {
    workspaceId: args.workspaceId,
    ref: args.artifacts.diagnostics,
    name: "diagnostics",
  });
  const depsStorageId = args.artifacts.deps
    ? await resolveArtifactStorageId(ctx, {
        workspaceId: args.workspaceId,
        ref: args.artifacts.deps,
        name: "deps",
      })
    : undefined;

  const metadataText = await readStorageText(ctx, metadataStorageId, "metadata");
  const metadata = JSON.parse(metadataText) as {
    capabilities?: unknown;
    skills?: unknown;
    tokenspaceMd?: unknown;
    credentialRequirements?: unknown;
    models?: unknown;
  };

  const diagnosticsText = await readStorageText(ctx, diagnosticsStorageId, "diagnostics");
  JSON.parse(diagnosticsText);

  const uploadedRevisionFsText = await readStorageText(ctx, uploadedRevisionFsStorageId, "revisionFs");
  const uploadedRevisionFs = parseRevisionFsArtifact(uploadedRevisionFsText);
  const revisionFs = {
    declarations: uploadedRevisionFs.declarations,
    files: uploadedRevisionFs.files,
    // Server is the source of truth for platform-provided system content.
    system: loadSystemContent(),
    builtins: uploadedRevisionFs.builtins,
  } satisfies ParsedRevisionFsArtifact;

  const revisionFsStorageId = await ctx.storage.store(
    new Blob([JSON.stringify(revisionFs)], { type: "application/json" }),
  );

  const promptMetadata = extractPromptMetadataFromEntries([
    ...revisionFs.files
      .filter((file) => !file.binary)
      .map((file) => ({
        path: file.path,
        content: file.content,
      })),
    ...revisionFs.system.map((file) => ({
      path: `system/${file.path}`,
      content: file.content,
    })),
  ]);
  const tokenspaceMdFromRevisionFs = revisionFs.files.find(
    (file) => file.path === "TOKENSPACE.md" && !file.binary,
  )?.content;

  const manifestStorageId = await ctx.storage.store(
    new Blob(
      [
        JSON.stringify({
          artifactFingerprint: args.artifactFingerprint,
          ...args.manifest,
        }),
      ],
      {
        type: "application/json",
      },
    ),
  );

  const previous = await ctx.runQuery(internal.revisions.findRevision, {
    branchId: args.source.branchId,
    branchStateId: args.source.branchStateId,
    commitId: args.commitId,
    workingStateHash: args.source.workingStateHash,
    sourceSnapshotHash: args.source.sourceSnapshotHash,
    artifactFingerprint: args.artifactFingerprint,
  });

  const revisionId = await ctx.runMutation(internal.revisions.createRevision, {
    workspaceId: args.workspaceId,
    branchId: args.source.branchId,
    branchStateId: args.source.branchStateId,
    commitId: args.commitId,
    workingStateHash: args.source.workingStateHash,
    sourceSnapshotHash: args.source.sourceSnapshotHash,
    artifactFingerprint: args.artifactFingerprint,
    revisionFsStorageId,
    bundleStorageId,
    depsStorageId,
    metadataStorageId,
    diagnosticsStorageId,
    manifestStorageId,
    compilerVersion: args.manifest.compilerVersion,
    sourceFingerprint: args.manifest.sourceFingerprint,
    compileMode: args.manifest.mode,
    capabilities:
      promptMetadata.capabilities.length > 0
        ? promptMetadata.capabilities
        : Array.isArray(metadata.capabilities)
          ? (metadata.capabilities as any[])
          : undefined,
    skills:
      promptMetadata.skills.length > 0
        ? promptMetadata.skills
        : Array.isArray(metadata.skills)
          ? (metadata.skills as any[])
          : undefined,
    tokenspaceMd:
      typeof tokenspaceMdFromRevisionFs === "string"
        ? tokenspaceMdFromRevisionFs
        : typeof metadata.tokenspaceMd === "string"
          ? metadata.tokenspaceMd
          : undefined,
    credentialRequirements: Array.isArray(metadata.credentialRequirements)
      ? (metadata.credentialRequirements as any[])
      : undefined,
    models: normalizeModels(metadata.models),
  });

  await ctx.runAction(internal.compile.materializeRevisionFiles, {
    revisionId,
  });

  return {
    revisionId,
    created: previous?._id !== revisionId,
  };
}

export const prepareRevisionFromBuild = action({
  args: {
    workspaceId: v.id("workspaces"),
    source: vRevisionBuildSource,
    manifest: vBuildManifestSummary,
  },
  returns: v.union(
    v.object({ kind: v.literal("existing"), revisionId: v.id("revisions") }),
    v.object({
      kind: v.literal("upload"),
      commitId: v.id("commits"),
      artifactFingerprint: v.string(),
      upload: v.object({
        revisionFs: vUploadInstruction,
        bundle: vUploadInstruction,
        metadata: vUploadInstruction,
        diagnostics: vUploadInstruction,
        deps: v.optional(vUploadInstruction),
      }),
    }),
  ),
  handler: async (ctx, args): Promise<PrepareResult> => {
    const { user } = await requireWorkspaceAdmin(ctx, args.workspaceId);
    const source = await resolveRevisionBuildSource(ctx, {
      workspaceId: args.workspaceId,
      source: args.source,
      userId: user.subject,
    });
    return await prepareRevisionFromBuildImpl(ctx, {
      workspaceId: args.workspaceId,
      source,
      manifest: args.manifest,
    });
  },
});

export const prepareRevisionFromBuildInternal = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    source: vRevisionBuildSource,
    manifest: vBuildManifestSummary,
  },
  returns: v.union(
    v.object({ kind: v.literal("existing"), revisionId: v.id("revisions") }),
    v.object({
      kind: v.literal("upload"),
      commitId: v.id("commits"),
      artifactFingerprint: v.string(),
      upload: v.object({
        revisionFs: vUploadInstruction,
        bundle: vUploadInstruction,
        metadata: vUploadInstruction,
        diagnostics: vUploadInstruction,
        deps: v.optional(vUploadInstruction),
      }),
    }),
  ),
  handler: async (ctx, args): Promise<PrepareResult> => {
    const source = await resolveRevisionBuildSource(ctx, {
      workspaceId: args.workspaceId,
      source: args.source,
    });
    return await prepareRevisionFromBuildImpl(ctx, {
      workspaceId: args.workspaceId,
      source,
      manifest: args.manifest,
    });
  },
});

export const commitRevisionFromBuild = action({
  args: {
    workspaceId: v.id("workspaces"),
    source: vRevisionBuildSource,
    commitId: v.id("commits"),
    artifactFingerprint: v.string(),
    manifest: vBuildManifestSummary,
    artifacts: v.object({
      revisionFs: vArtifactReference,
      bundle: vArtifactReference,
      metadata: vArtifactReference,
      diagnostics: vArtifactReference,
      deps: v.optional(vArtifactReference),
    }),
  },
  returns: v.object({
    revisionId: v.id("revisions"),
    created: v.boolean(),
  }),
  handler: async (ctx, args): Promise<CommitResult> => {
    const { user } = await requireWorkspaceAdmin(ctx, args.workspaceId);
    const source = await resolveRevisionBuildSource(ctx, {
      workspaceId: args.workspaceId,
      source: args.source,
      userId: user.subject,
    });
    return await commitRevisionFromBuildImpl(ctx, {
      workspaceId: args.workspaceId,
      source,
      commitId: args.commitId,
      artifactFingerprint: args.artifactFingerprint,
      manifest: args.manifest,
      artifacts: args.artifacts,
    });
  },
});

export const commitRevisionFromBuildInternal = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    source: vRevisionBuildSource,
    commitId: v.id("commits"),
    artifactFingerprint: v.string(),
    manifest: vBuildManifestSummary,
    artifacts: v.object({
      revisionFs: vArtifactReference,
      bundle: vArtifactReference,
      metadata: vArtifactReference,
      diagnostics: vArtifactReference,
      deps: v.optional(vArtifactReference),
    }),
  },
  returns: v.object({
    revisionId: v.id("revisions"),
    created: v.boolean(),
  }),
  handler: async (ctx, args): Promise<CommitResult> => {
    const source = await resolveRevisionBuildSource(ctx, {
      workspaceId: args.workspaceId,
      source: args.source,
    });
    return await commitRevisionFromBuildImpl(ctx, {
      workspaceId: args.workspaceId,
      source,
      commitId: args.commitId,
      artifactFingerprint: args.artifactFingerprint,
      manifest: args.manifest,
      artifacts: args.artifacts,
    });
  },
});
