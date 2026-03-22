import { beforeAll, describe, expect, it } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildWorkspace } from "@tokenspace/compiler";
import { getSharedHarness, waitForSetup } from "./setup";
import { getFunctionName, internal, readFilesRecursively } from "./test-utils";

const REPO_ROOT = path.join(import.meta.dir, "../../..");

async function uploadToStorage(uploadUrl: string, bytes: Uint8Array): Promise<string> {
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
    },
    body: bytes,
  });
  if (!response.ok) {
    throw new Error(`Upload failed (${response.status})`);
  }
  const payload = (await response.json()) as { storageId?: string };
  if (!payload.storageId) {
    throw new Error("Upload response missing storageId");
  }
  return payload.storageId;
}

async function seedWorkspaceFromDir(
  slug: string,
  name: string,
  workspaceDir: string,
): Promise<{ workspaceId: string; branchId: string }> {
  const backend = getSharedHarness().getBackend();
  const exists = (await backend.runFunction(getFunctionName(internal.seed.workspaceExists), {
    slug,
  })) as boolean;

  if (exists) {
    await backend.runFunction(getFunctionName(internal.seed.deleteWorkspace), { slug });
  }

  const files = readFilesRecursively(workspaceDir);
  const seeded = (await backend.runFunction(getFunctionName(internal.seed.seedWorkspace), {
    slug,
    name,
    files,
  })) as { workspaceId: string };

  const branch = (await backend.runFunction(getFunctionName(internal.vcs.getDefaultBranchInternal), {
    workspaceId: seeded.workspaceId,
  })) as { _id: string };

  return {
    workspaceId: seeded.workspaceId,
    branchId: branch._id,
  };
}

async function pushBuildToRevision(args: {
  workspaceId: string;
  branchId: string;
  outDir: string;
  manifest: {
    schemaVersion: number;
    compilerVersion: string;
    sourceFingerprint: string;
    mode: "local" | "server";
    artifacts: {
      revisionFs: { path: string; hash: string; size: number };
      bundle: { path: string; hash: string; size: number };
      metadata: { path: string; hash: string; size: number };
      diagnostics: { path: string; hash: string; size: number };
      deps?: { path: string; hash: string; size: number };
    };
  };
}): Promise<{ revisionId: string; created: boolean }> {
  const backend = getSharedHarness().getBackend();

  const prepare = (await backend.runFunction(getFunctionName(internal.revisionBuild.prepareRevisionFromBuildInternal), {
    workspaceId: args.workspaceId,
    source: {
      kind: "branch",
      branchId: args.branchId,
      workingStateHash: args.manifest.sourceFingerprint,
    },
    manifest: {
      schemaVersion: args.manifest.schemaVersion,
      compilerVersion: args.manifest.compilerVersion,
      sourceFingerprint: args.manifest.sourceFingerprint,
      mode: args.manifest.mode,
      artifacts: {
        revisionFs: { hash: args.manifest.artifacts.revisionFs.hash, size: args.manifest.artifacts.revisionFs.size },
        bundle: { hash: args.manifest.artifacts.bundle.hash, size: args.manifest.artifacts.bundle.size },
        metadata: { hash: args.manifest.artifacts.metadata.hash, size: args.manifest.artifacts.metadata.size },
        diagnostics: { hash: args.manifest.artifacts.diagnostics.hash, size: args.manifest.artifacts.diagnostics.size },
        deps: args.manifest.artifacts.deps
          ? { hash: args.manifest.artifacts.deps.hash, size: args.manifest.artifacts.deps.size }
          : undefined,
      },
    },
  })) as
    | { kind: "existing"; revisionId: string }
    | {
        kind: "upload";
        commitId: string;
        artifactFingerprint: string;
        upload: {
          revisionFs: { kind: "existing"; blobId: string } | { kind: "upload"; uploadUrl: string };
          bundle: { kind: "existing"; blobId: string } | { kind: "upload"; uploadUrl: string };
          metadata: { kind: "existing"; blobId: string } | { kind: "upload"; uploadUrl: string };
          diagnostics: { kind: "existing"; blobId: string } | { kind: "upload"; uploadUrl: string };
          deps?: { kind: "existing"; blobId: string } | { kind: "upload"; uploadUrl: string };
        };
      };

  if (prepare.kind === "existing") {
    return { revisionId: prepare.revisionId, created: false };
  }

  const resolveRef = async (
    instruction: { kind: "existing"; blobId: string } | { kind: "upload"; uploadUrl: string },
    artifactPath: string,
    hash: string,
    size: number,
  ): Promise<{ blobId: string; hash: string; size: number } | { storageId: string; hash: string; size: number }> => {
    if (instruction.kind === "existing") {
      return { blobId: instruction.blobId, hash, size };
    }

    const bytes = new Uint8Array(await Bun.file(path.join(args.outDir, artifactPath)).arrayBuffer());
    const storageId = await uploadToStorage(instruction.uploadUrl, bytes);
    return { storageId, hash, size };
  };

  const artifacts = {
    revisionFs: await resolveRef(
      prepare.upload.revisionFs,
      args.manifest.artifacts.revisionFs.path,
      args.manifest.artifacts.revisionFs.hash,
      args.manifest.artifacts.revisionFs.size,
    ),
    bundle: await resolveRef(
      prepare.upload.bundle,
      args.manifest.artifacts.bundle.path,
      args.manifest.artifacts.bundle.hash,
      args.manifest.artifacts.bundle.size,
    ),
    metadata: await resolveRef(
      prepare.upload.metadata,
      args.manifest.artifacts.metadata.path,
      args.manifest.artifacts.metadata.hash,
      args.manifest.artifacts.metadata.size,
    ),
    diagnostics: await resolveRef(
      prepare.upload.diagnostics,
      args.manifest.artifacts.diagnostics.path,
      args.manifest.artifacts.diagnostics.hash,
      args.manifest.artifacts.diagnostics.size,
    ),
    deps:
      prepare.upload.deps && args.manifest.artifacts.deps
        ? await resolveRef(
            prepare.upload.deps,
            args.manifest.artifacts.deps.path,
            args.manifest.artifacts.deps.hash,
            args.manifest.artifacts.deps.size,
          )
        : undefined,
  };

  return (await backend.runFunction(getFunctionName(internal.revisionBuild.commitRevisionFromBuildInternal), {
    workspaceId: args.workspaceId,
    source: {
      kind: "branch",
      branchId: args.branchId,
      workingStateHash: args.manifest.sourceFingerprint,
    },
    commitId: prepare.commitId,
    artifactFingerprint: prepare.artifactFingerprint,
    manifest: {
      schemaVersion: args.manifest.schemaVersion,
      compilerVersion: args.manifest.compilerVersion,
      sourceFingerprint: args.manifest.sourceFingerprint,
      mode: args.manifest.mode,
      artifacts: {
        revisionFs: { hash: args.manifest.artifacts.revisionFs.hash, size: args.manifest.artifacts.revisionFs.size },
        bundle: { hash: args.manifest.artifacts.bundle.hash, size: args.manifest.artifacts.bundle.size },
        metadata: { hash: args.manifest.artifacts.metadata.hash, size: args.manifest.artifacts.metadata.size },
        diagnostics: { hash: args.manifest.artifacts.diagnostics.hash, size: args.manifest.artifacts.diagnostics.size },
        deps: args.manifest.artifacts.deps
          ? { hash: args.manifest.artifacts.deps.hash, size: args.manifest.artifacts.deps.size }
          : undefined,
      },
    },
    artifacts,
  })) as { revisionId: string; created: boolean };
}

describe("Revision build push", () => {
  beforeAll(async () => {
    await waitForSetup();
  });

  it("builds and pushes revisions for examples/testing", async () => {
    const workspaceCases = [
      {
        slug: "build-push-testing",
        name: "Build Push Testing",
        dir: path.join(REPO_ROOT, "examples/testing"),
      },
      {
        slug: "build-push-demo",
        name: "Build Push Demo",
        dir: path.join(REPO_ROOT, "examples/demo"),
      },
    ];

    for (const workspaceCase of workspaceCases) {
      const seeded = await seedWorkspaceFromDir(workspaceCase.slug, workspaceCase.name, workspaceCase.dir);
      const outDir = await mkdtemp(path.join(tmpdir(), `tokenspace-build-${workspaceCase.slug}-`));

      try {
        const buildResult = await buildWorkspace({
          workspaceDir: workspaceCase.dir,
          outDir,
          mode: "local",
        });
        const expectedTokenspaceMd = await readFile(path.join(workspaceCase.dir, "TOKENSPACE.md"), "utf8");
        expect(buildResult.metadata.tokenspaceMd).toBe(expectedTokenspaceMd);

        const pushed = await pushBuildToRevision({
          workspaceId: seeded.workspaceId,
          branchId: seeded.branchId,
          outDir,
          manifest: buildResult.manifest,
        });

        expect(pushed.revisionId).toBeDefined();

        const backend = getSharedHarness().getBackend();
        const revision = (await backend.runFunction(getFunctionName(internal.revisions.getRevision), {
          revisionId: pushed.revisionId,
        })) as {
          compileMode?: string;
          sourceFingerprint?: string;
          diagnosticsStorageId?: string;
          metadataStorageId?: string;
          compilerVersion?: string;
          tokenspaceMd?: string;
          credentialRequirements?: unknown[];
        };

        expect(revision.compileMode).toBe("local");
        expect(revision.sourceFingerprint).toBe(buildResult.manifest.sourceFingerprint);
        expect(revision.diagnosticsStorageId).toBeDefined();
        expect(revision.metadataStorageId).toBeDefined();
        expect(revision.compilerVersion).toBe(buildResult.manifest.compilerVersion);
        expect(revision.tokenspaceMd).toBe(expectedTokenspaceMd);
        expect(revision.credentialRequirements).toEqual(buildResult.metadata.credentialRequirements);

        const dynamicSystemPrompt = (await backend.runFunction(
          getFunctionName(internal.ai.agent.generateDynamicSystemPrompt),
          {
            revision: pushed.revisionId,
          },
        )) as string | null;
        expect(dynamicSystemPrompt).toContain(expectedTokenspaceMd);

        if (workspaceCase.slug === "build-push-demo") {
          expect(buildResult.metadata.credentialRequirements.length).toBeGreaterThan(0);
        } else {
          expect(buildResult.metadata.credentialRequirements).toEqual([]);
        }

        const revisionFs = (await backend.runFunction(getFunctionName(internal.compile.getRevisionFsFromRevision), {
          revisionId: pushed.revisionId,
        })) as { system?: Array<{ path: string; content: string }> };
        expect((revisionFs.system ?? []).length).toBeGreaterThan(0);
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    }
  }, 180000);

  it("allows creating a revision from uncommitted local state", async () => {
    const sourceDir = path.join(REPO_ROOT, "examples/testing");
    const seeded = await seedWorkspaceFromDir("build-push-uncommitted", "Build Push Uncommitted", sourceDir);

    const workspaceCopyDir = await mkdtemp(path.join(tmpdir(), "tokenspace-workspace-copy-"));
    const outDir = await mkdtemp(path.join(tmpdir(), "tokenspace-build-uncommitted-"));

    try {
      await cp(sourceDir, workspaceCopyDir, { recursive: true, dereference: true });

      const tokenSpacePath = path.join(workspaceCopyDir, "TOKENSPACE.md");
      const originalTokenSpace = await readFile(tokenSpacePath, "utf8");
      await writeFile(
        tokenSpacePath,
        `${originalTokenSpace}\n\nLocal uncommitted change for revision push test.\n`,
        "utf8",
      );

      const buildResult = await buildWorkspace({
        workspaceDir: workspaceCopyDir,
        outDir,
        mode: "local",
      });

      const pushed = await pushBuildToRevision({
        workspaceId: seeded.workspaceId,
        branchId: seeded.branchId,
        outDir,
        manifest: buildResult.manifest,
      });

      expect(pushed.created).toBe(true);

      const backend = getSharedHarness().getBackend();
      const revision = (await backend.runFunction(getFunctionName(internal.revisions.getRevision), {
        revisionId: pushed.revisionId,
      })) as { workingStateHash?: string; sourceFingerprint?: string; tokenspaceMd?: string };

      expect(revision.workingStateHash).toBe(buildResult.manifest.sourceFingerprint);
      expect(revision.sourceFingerprint).toBe(buildResult.manifest.sourceFingerprint);
      expect(buildResult.metadata.tokenspaceMd).toContain("Local uncommitted change for revision push test.");
      expect(revision.tokenspaceMd).toContain("Local uncommitted change for revision push test.");

      const dynamicSystemPrompt = (await backend.runFunction(
        getFunctionName(internal.ai.agent.generateDynamicSystemPrompt),
        {
          revision: pushed.revisionId,
        },
      )) as string | null;
      expect(dynamicSystemPrompt).toContain("Local uncommitted change for revision push test.");
    } finally {
      await rm(workspaceCopyDir, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  }, 120000);
});
