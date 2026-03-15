import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { type BuildManifestSummary, commitRevisionFromBuild, prepareRevisionFromBuild } from "../client.js";

type BuildManifestFile = BuildManifestSummary & {
  artifacts: BuildManifestSummary["artifacts"] & {
    revisionFs: BuildManifestSummary["artifacts"]["revisionFs"] & { path: string };
    bundle: BuildManifestSummary["artifacts"]["bundle"] & { path: string };
    metadata: BuildManifestSummary["artifacts"]["metadata"] & { path: string };
    diagnostics: BuildManifestSummary["artifacts"]["diagnostics"] & { path: string };
    deps?: BuildManifestSummary["artifacts"]["deps"] & { path: string };
  };
};

async function uploadToStorage(uploadUrl: string, data: Uint8Array, binary: boolean): Promise<Id<"_storage">> {
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Type": binary ? "application/octet-stream" : "text/plain; charset=utf-8",
    },
    body: data,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Failed to upload artifact (${response.status})`);
  }
  const payload = (await response.json()) as { storageId?: string };
  if (!payload.storageId) {
    throw new Error("Upload response missing storageId");
  }
  return payload.storageId as Id<"_storage">;
}

function resolveArtifactPath(buildDir: string, relativePath: string): string {
  if (!relativePath || typeof relativePath !== "string") {
    throw new Error("Artifact path must be a non-empty string");
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Artifact path must be relative: ${relativePath}`);
  }

  const baseDir = path.resolve(buildDir);
  const fullPath = path.resolve(baseDir, relativePath);
  const rel = path.relative(baseDir, fullPath);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Artifact path escapes build directory: ${relativePath}`);
  }

  return fullPath;
}

async function readBuildArtifactBytes(buildDir: string, relativePath: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(resolveArtifactPath(buildDir, relativePath)));
}

export async function readBuildManifest(buildDir: string): Promise<BuildManifestFile> {
  const manifestPath = path.resolve(buildDir, "manifest.json");
  return JSON.parse(await readFile(manifestPath, "utf8")) as BuildManifestFile;
}

export function toBuildManifestSummary(manifest: BuildManifestFile): BuildManifestSummary {
  return {
    schemaVersion: manifest.schemaVersion,
    compilerVersion: manifest.compilerVersion,
    sourceFingerprint: manifest.sourceFingerprint,
    mode: manifest.mode,
    artifacts: {
      revisionFs: {
        hash: manifest.artifacts.revisionFs.hash,
        size: manifest.artifacts.revisionFs.size,
      },
      bundle: {
        hash: manifest.artifacts.bundle.hash,
        size: manifest.artifacts.bundle.size,
      },
      metadata: {
        hash: manifest.artifacts.metadata.hash,
        size: manifest.artifacts.metadata.size,
      },
      diagnostics: {
        hash: manifest.artifacts.diagnostics.hash,
        size: manifest.artifacts.diagnostics.size,
      },
      deps: manifest.artifacts.deps
        ? {
            hash: manifest.artifacts.deps.hash,
            size: manifest.artifacts.deps.size,
          }
        : undefined,
    },
  };
}

export async function pushRevisionArtifacts(args: {
  workspaceId: Id<"workspaces">;
  branchId: Id<"branches">;
  buildDir: string;
  workingStateHash?: string;
}): Promise<{ revisionId: Id<"revisions">; created: boolean }> {
  const buildDir = path.resolve(args.buildDir);
  const manifest = await readBuildManifest(buildDir);
  const manifestSummary = toBuildManifestSummary(manifest);

  const prepare = await prepareRevisionFromBuild(
    args.workspaceId,
    args.branchId,
    manifestSummary,
    args.workingStateHash,
  );
  if (prepare.kind === "existing") {
    return { revisionId: prepare.revisionId, created: false };
  }

  const uploadArtifact = async (
    instruction: { kind: "existing"; blobId: Id<"blobs"> } | { kind: "upload"; uploadUrl: string },
    artifactPath: string,
    hash: string,
    size: number,
  ) => {
    if (instruction.kind === "existing") {
      return { blobId: instruction.blobId, hash, size } as const;
    }
    const bytes = await readBuildArtifactBytes(buildDir, artifactPath);
    const storageId = await uploadToStorage(instruction.uploadUrl, bytes, false);
    return { storageId, hash, size } as const;
  };

  const artifacts = {
    revisionFs: await uploadArtifact(
      prepare.upload.revisionFs,
      manifest.artifacts.revisionFs.path,
      manifest.artifacts.revisionFs.hash,
      manifest.artifacts.revisionFs.size,
    ),
    bundle: await uploadArtifact(
      prepare.upload.bundle,
      manifest.artifacts.bundle.path,
      manifest.artifacts.bundle.hash,
      manifest.artifacts.bundle.size,
    ),
    metadata: await uploadArtifact(
      prepare.upload.metadata,
      manifest.artifacts.metadata.path,
      manifest.artifacts.metadata.hash,
      manifest.artifacts.metadata.size,
    ),
    diagnostics: await uploadArtifact(
      prepare.upload.diagnostics,
      manifest.artifacts.diagnostics.path,
      manifest.artifacts.diagnostics.hash,
      manifest.artifacts.diagnostics.size,
    ),
    deps:
      manifest.artifacts.deps && prepare.upload.deps
        ? await uploadArtifact(
            prepare.upload.deps,
            manifest.artifacts.deps.path,
            manifest.artifacts.deps.hash,
            manifest.artifacts.deps.size,
          )
        : undefined,
  };

  return await commitRevisionFromBuild(
    args.workspaceId,
    args.branchId,
    prepare.commitId,
    args.workingStateHash,
    prepare.artifactFingerprint,
    manifestSummary,
    artifacts,
  );
}
