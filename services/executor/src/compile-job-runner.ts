import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { buildWorkspace } from "@tokenspace/compiler";
import type { ConvexClient } from "convex/browser";
import type { ExecutorInstanceTokenSource } from "./executor-session";

type CompileJobId = Id<"compileJobs">;

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

type UploadInstruction = { kind: "existing"; blobId: Id<"blobs"> } | { kind: "upload"; uploadUrl: string };
type ArtifactReference =
  | { blobId: Id<"blobs">; hash: string; size: number }
  | { storageId: Id<"_storage">; hash: string; size: number };

const LEASE_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 5_000;
const BUN_INSTALL_TIMEOUT_MS = 5 * 60_000;
const NETWORK_TIMEOUT_MS = 60_000;
const WORKSPACE_DIRS = ["apps", "examples", "packages", "services"];

function toSerializableError(error: unknown): {
  message: string;
  stack?: string;
  details?: string;
  data?: Record<string, unknown>;
} {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
      details: (error as any).details,
      data: (error as any).data,
    };
  }
  return {
    message: String(error),
  };
}

function compileTmpRoot(): string {
  const configured = process.env.TOKENSPACE_COMPILE_TMP_ROOT?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  return tmpdir();
}

function monorepoRoot(): string {
  return path.join(import.meta.dir, "..", "..", "..");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findWorkspacePackage(packageName: string): Promise<string | null> {
  const root = monorepoRoot();
  for (const dir of WORKSPACE_DIRS) {
    const parentDir = path.join(root, dir);
    let entries: string[];
    try {
      entries = await readdir(parentDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const packageJsonPath = path.join(parentDir, entry, "package.json");
      try {
        const raw = await readFile(packageJsonPath, "utf8");
        const parsed = JSON.parse(raw) as { name?: string };
        if (parsed.name === packageName) {
          return path.join(parentDir, entry);
        }
      } catch {}
    }
  }
  return null;
}

async function resolveWorkspaceDeps(
  packageJsonPath: string,
): Promise<{ stripped: boolean; linkTargets: Array<{ name: string; target: string }> }> {
  const raw = await readFile(packageJsonPath, "utf8");
  const pkg = JSON.parse(raw) as Record<string, unknown>;
  const linkTargets: Array<{ name: string; target: string }> = [];
  let stripped = false;

  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const deps = pkg[field] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const [name, version] of Object.entries(deps)) {
      if (typeof version !== "string" || !version.startsWith("workspace:")) continue;
      const target = await findWorkspacePackage(name);
      if (!target) {
        throw new Error(`Unable to resolve workspace dependency "${name}" from monorepo root "${monorepoRoot()}"`);
      }
      linkTargets.push({ name, target });
      delete deps[name];
      stripped = true;
    }
    if (Object.keys(deps).length === 0) {
      delete pkg[field];
    }
  }

  if (stripped) {
    await writeFile(packageJsonPath, JSON.stringify(pkg, null, 2), "utf8");
  }

  return { stripped, linkTargets };
}

async function symlinkWorkspacePackages(
  workspaceDir: string,
  linkTargets: Array<{ name: string; target: string }>,
): Promise<void> {
  for (const { name, target } of linkTargets) {
    const parts = name.split("/");
    const linkDir =
      parts.length > 1
        ? path.join(workspaceDir, "node_modules", ...parts.slice(0, -1))
        : path.join(workspaceDir, "node_modules");
    await mkdir(linkDir, { recursive: true });
    const linkPath = path.join(workspaceDir, "node_modules", ...parts);
    if (await fileExists(linkPath)) {
      continue;
    }
    await symlink(target, linkPath);
  }
}

async function runBunInstall(workspaceDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("bun", ["install", "--ignore-scripts"], {
      cwd: workspaceDir,
      stdio: "pipe",
      env: {
        ...process.env,
        CI: process.env.CI ?? "1",
        HUSKY: process.env.HUSKY ?? "0",
      },
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`bun install timed out after ${BUN_INSTALL_TIMEOUT_MS}ms`));
    }, BUN_INSTALL_TIMEOUT_MS);

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if ((code ?? 1) !== 0) {
        reject(new Error(`bun install failed with exit code ${code ?? 1}`));
        return;
      }
      resolve();
    });
  });
}

async function prepareDependencies(workspaceDir: string): Promise<void> {
  const packageJsonPath = path.join(workspaceDir, "package.json");
  if (!(await fileExists(packageJsonPath))) {
    return;
  }

  const originalPackageJson = await readFile(packageJsonPath, "utf8");
  const { stripped, linkTargets } = await resolveWorkspaceDeps(packageJsonPath);
  try {
    await runBunInstall(workspaceDir);
    await symlinkWorkspacePackages(workspaceDir, linkTargets);
  } finally {
    if (stripped) {
      await writeFile(packageJsonPath, originalPackageJson, "utf8");
    }
  }
}

function assertPathInsideWorkspace(workspaceDir: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Snapshot file path must be relative: ${relativePath}`);
  }
  const resolved = path.resolve(workspaceDir, relativePath);
  const workspaceRoot = path.resolve(workspaceDir);
  if (resolved !== workspaceRoot && !resolved.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error(`Snapshot file path escapes workspace: ${relativePath}`);
  }
  return resolved;
}

async function uploadToStorage(uploadUrl: string, bytes: Uint8Array): Promise<Id<"_storage">> {
  const response = await fetch(uploadUrl, {
    method: "POST",
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/octet-stream",
    },
    body: bytes,
  });
  if (!response.ok) {
    throw new Error(`Artifact upload failed (${response.status})`);
  }
  const payload = (await response.json()) as { storageId?: string };
  if (!payload.storageId) {
    throw new Error("Upload response missing storageId");
  }
  return payload.storageId as Id<"_storage">;
}

export class CompileJobRunner {
  private readonly queue: CompileJobId[] = [];
  private readonly queued = new Set<string>();
  private running = false;
  private readonly workerId = `compile:${randomUUID()}`;

  constructor(
    private readonly convex: ConvexClient,
    private readonly tokenSource: ExecutorInstanceTokenSource,
  ) {}

  enqueue(jobId: CompileJobId): void {
    const key = String(jobId);
    if (this.queued.has(key)) {
      return;
    }
    this.queued.add(key);
    this.queue.push(jobId);
    if (!this.running) {
      void this.drain();
    }
  }

  private async drain(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const jobId = this.queue.shift()!;
        this.queued.delete(String(jobId));
        await this.runOne(jobId);
      }
    } finally {
      this.running = false;
    }
  }

  private async runOne(jobId: CompileJobId): Promise<void> {
    let tmpRoot: string | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    const startTime = Date.now();
    try {
      const claim = await this.convex.mutation(api.compileJobs.claimCompileJob, {
        compileJobId: jobId,
        workerId: this.workerId,
        leaseMs: LEASE_MS,
        instanceToken: this.tokenSource.getInstanceToken(),
      });
      if (claim.status !== "running") {
        return;
      }

      console.log(
        `Running compile job ${jobId} workspace=${claim.workspaceId} branch=${claim.branchId} commit=${claim.commitId} wsHash=${claim.workingStateHash} userId=${claim.userId}`,
      );

      heartbeatTimer = setInterval(() => {
        void this.convex
          .mutation(api.compileJobs.heartbeatCompileJob, {
            compileJobId: jobId,
            workerId: this.workerId,
            leaseMs: LEASE_MS,
            instanceToken: this.tokenSource.getInstanceToken(),
          })
          .catch((error) => {
            console.warn(`[executor] compile heartbeat failed for ${jobId}: ${String(error)}`);
          });
      }, HEARTBEAT_INTERVAL_MS);

      const snapshotInfo = await this.convex.query(api.compileJobs.getCompileJobSnapshot, {
        compileJobId: jobId,
        instanceToken: this.tokenSource.getInstanceToken(),
      });

      const snapshotResponse = await fetch(snapshotInfo.snapshotUrl, {
        signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      });
      if (!snapshotResponse.ok) {
        throw new Error(`Failed to fetch compile snapshot (${snapshotResponse.status})`);
      }
      const snapshot = (await snapshotResponse.json()) as {
        files: Array<{ path: string; content: string; binary?: boolean }>;
      };

      tmpRoot = await mkdtemp(path.join(compileTmpRoot(), "tokenspace-compile-"));
      const workspaceDir = path.join(tmpRoot, "workspace");
      const outDir = path.join(tmpRoot, "build", "tokenspace");
      await mkdir(workspaceDir, { recursive: true });

      for (const file of snapshot.files) {
        const targetPath = assertPathInsideWorkspace(workspaceDir, file.path);
        await mkdir(path.dirname(targetPath), { recursive: true });
        if (file.binary) {
          await writeFile(targetPath, Buffer.from(file.content, "base64"));
        } else {
          await writeFile(targetPath, file.content, "utf8");
        }
      }

      console.log(`Preparing dependencies for workspace at ${workspaceDir}`);
      await prepareDependencies(workspaceDir);

      const startTime = Date.now();
      const buildResult = await buildWorkspace({
        workspaceDir,
        outDir,
        mode: "server",
      });

      const manifestSummary: BuildManifestSummary = {
        schemaVersion: buildResult.manifest.schemaVersion,
        compilerVersion: buildResult.manifest.compilerVersion,
        sourceFingerprint: buildResult.manifest.sourceFingerprint,
        mode: buildResult.manifest.mode,
        artifacts: {
          revisionFs: {
            hash: buildResult.manifest.artifacts.revisionFs.hash,
            size: buildResult.manifest.artifacts.revisionFs.size,
          },
          bundle: {
            hash: buildResult.manifest.artifacts.bundle.hash,
            size: buildResult.manifest.artifacts.bundle.size,
          },
          metadata: {
            hash: buildResult.manifest.artifacts.metadata.hash,
            size: buildResult.manifest.artifacts.metadata.size,
          },
          diagnostics: {
            hash: buildResult.manifest.artifacts.diagnostics.hash,
            size: buildResult.manifest.artifacts.diagnostics.size,
          },
          ...(buildResult.manifest.artifacts.deps
            ? {
                deps: {
                  hash: buildResult.manifest.artifacts.deps.hash,
                  size: buildResult.manifest.artifacts.deps.size,
                },
              }
            : {}),
        },
      };

      console.log(`Compile job id=${jobId} completed in ${Date.now() - startTime}ms`);

      const prepare = await this.convex.action(api.compileJobs.prepareRevisionFromBuildForExecutor, {
        compileJobId: jobId,
        workerId: this.workerId,
        manifest: manifestSummary,
        instanceToken: this.tokenSource.getInstanceToken(),
      });

      if (prepare.kind === "existing") {
        await this.convex.mutation(api.compileJobs.completeCompileJob, {
          compileJobId: jobId,
          revisionId: prepare.revisionId,
          workerId: this.workerId,
          artifactFingerprint: undefined,
          instanceToken: this.tokenSource.getInstanceToken(),
        });
        return;
      }

      const uploadArtifact = async (
        instruction: UploadInstruction,
        artifactPath: string,
        hash: string,
        size: number,
      ): Promise<ArtifactReference> => {
        if (instruction.kind === "existing") {
          return { blobId: instruction.blobId, hash, size };
        }
        const bytes = new Uint8Array(await Bun.file(path.join(outDir, artifactPath)).arrayBuffer());
        const storageId = await uploadToStorage(instruction.uploadUrl, bytes);
        return { storageId, hash, size };
      };

      console.log("Uploading artifacts...");
      const artifacts = {
        revisionFs: await uploadArtifact(
          prepare.upload.revisionFs,
          buildResult.manifest.artifacts.revisionFs.path,
          buildResult.manifest.artifacts.revisionFs.hash,
          buildResult.manifest.artifacts.revisionFs.size,
        ),
        bundle: await uploadArtifact(
          prepare.upload.bundle,
          buildResult.manifest.artifacts.bundle.path,
          buildResult.manifest.artifacts.bundle.hash,
          buildResult.manifest.artifacts.bundle.size,
        ),
        metadata: await uploadArtifact(
          prepare.upload.metadata,
          buildResult.manifest.artifacts.metadata.path,
          buildResult.manifest.artifacts.metadata.hash,
          buildResult.manifest.artifacts.metadata.size,
        ),
        diagnostics: await uploadArtifact(
          prepare.upload.diagnostics,
          buildResult.manifest.artifacts.diagnostics.path,
          buildResult.manifest.artifacts.diagnostics.hash,
          buildResult.manifest.artifacts.diagnostics.size,
        ),
        deps:
          prepare.upload.deps && buildResult.manifest.artifacts.deps
            ? await uploadArtifact(
                prepare.upload.deps,
                buildResult.manifest.artifacts.deps.path,
                buildResult.manifest.artifacts.deps.hash,
                buildResult.manifest.artifacts.deps.size,
              )
            : undefined,
      };

      const commit = await this.convex.action(api.compileJobs.commitRevisionFromBuildForExecutor, {
        compileJobId: jobId,
        workerId: this.workerId,
        artifactFingerprint: prepare.artifactFingerprint,
        manifest: manifestSummary,
        artifacts,
        instanceToken: this.tokenSource.getInstanceToken(),
      });

      console.log(`Revision id=${commit.revisionId} created for job ${jobId} in ${Date.now() - startTime}ms`);

      await this.convex.mutation(api.compileJobs.completeCompileJob, {
        compileJobId: jobId,
        revisionId: commit.revisionId,
        workerId: this.workerId,
        revisionFsDeclarationCount: buildResult.revisionFs.declarations.length,
        revisionFsFileCount: buildResult.revisionFs.files.length,
        revisionFsSystemCount: buildResult.revisionFs.system.length,
        compilerVersion: buildResult.manifest.compilerVersion,
        sourceFingerprint: buildResult.manifest.sourceFingerprint,
        artifactFingerprint: prepare.artifactFingerprint,
        instanceToken: this.tokenSource.getInstanceToken(),
      });
    } catch (error) {
      console.error(`Compile job ${jobId} failed in ${Date.now() - startTime}ms`, error);
      const serialized = toSerializableError(error);
      try {
        await this.convex.mutation(api.compileJobs.failCompileJob, {
          compileJobId: jobId,
          workerId: this.workerId,
          error: serialized,
          instanceToken: this.tokenSource.getInstanceToken(),
        });
      } catch (failError) {
        console.warn(`[executor] failed to mark compile job ${jobId} as failed: ${String(failError)}`);
      }
    } finally {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      if (tmpRoot) {
        try {
          await rm(tmpRoot, { recursive: true, force: true });
        } catch (error) {
          console.warn(`[executor] failed to cleanup compile temp dir ${tmpRoot}: ${String(error)}`);
        }
      }
    }
  }
}
