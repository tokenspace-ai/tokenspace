import { randomUUID } from "node:crypto";
import { access, cp, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BuildWorkspaceResult,
  buildWorkspace,
  fingerprintWorkspaceSource,
  loadBuiltWorkspace,
} from "@tokenspace/compiler";
import { LocalSessionFs } from "./local-session-fs";
import { materializeSandbox } from "./materialize-sandbox";
import { loadLocalSystemContent } from "./system-content";
import type { CreateLocalSessionOptions, LocalBuildOrigin, LocalSession, LocalSessionManifest } from "./types";

const SESSION_LAYOUT_VERSION = 2;

function sanitizeWorkspaceName(workspaceDir: string): string {
  const rawName = path.basename(workspaceDir) || "workspace";
  const sanitized = rawName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "workspace";
}

function createSessionId(now: Date = new Date()): string {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return `${timestamp}-${process.pid}-${randomUUID().slice(0, 8)}`;
}

export function getDefaultSessionsRootDir(): string {
  return path.join(homedir(), ".tokenspace", "local-mcp", "sessions");
}

export function getDefaultBuildCacheDir(): string {
  return path.join(homedir(), ".tokenspace", "local-mcp", "build-cache");
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function toPackageName(specifier: string): string | null {
  if (!specifier || specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) {
    return null;
  }

  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }
  return parts[0] ?? null;
}

function extractRuntimePackageNames(bundleCode: string): string[] {
  const packageNames = new Set<string>();
  const importPattern =
    /(?:import|export)\s+(?:[^"'`]*?\s+from\s*)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

  for (const match of bundleCode.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2];
    if (!specifier) continue;
    const packageName = toPackageName(specifier);
    if (packageName) {
      packageNames.add(packageName);
    }
  }

  return [...packageNames].sort((a, b) => a.localeCompare(b));
}

function resolvePackageDir(packageName: string, searchPaths: string[]): string {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve(`${packageName}/package.json`, {
    paths: searchPaths,
  });
  return path.dirname(packageJsonPath);
}

async function linkRuntimeNodeModules(buildDir: string, workspaceDir: string, bundleCode: string): Promise<void> {
  const currentModuleDir = path.dirname(fileURLToPath(import.meta.url));
  const nodeModulesDir = path.join(buildDir, "node_modules");
  const searchPaths = [workspaceDir, currentModuleDir];

  await mkdir(nodeModulesDir, { recursive: true });

  for (const packageName of extractRuntimePackageNames(bundleCode)) {
    const packageDir = resolvePackageDir(packageName, searchPaths);
    const targetPath = path.join(nodeModulesDir, ...packageName.split("/"));
    if (await pathExists(targetPath)) continue;
    await mkdir(path.dirname(targetPath), { recursive: true });
    await symlink(packageDir, targetPath, "dir");
  }
}

async function copyBuildArtifacts(sourceDir: string, buildDir: string): Promise<void> {
  await cp(sourceDir, buildDir, { recursive: true, force: true });
}

async function loadCachedBuild(cacheDir: string): Promise<BuildWorkspaceResult> {
  try {
    return await loadBuiltWorkspace(cacheDir);
  } catch (error) {
    await rm(cacheDir, { recursive: true, force: true });
    throw error;
  }
}

async function populateCacheEntry(workspaceDir: string, cacheDir: string): Promise<BuildWorkspaceResult> {
  const cacheParentDir = path.dirname(cacheDir);
  const cacheDirName = path.basename(cacheDir);
  await mkdir(cacheParentDir, { recursive: true });

  const tempBuildDir = await mkdtemp(path.join(cacheParentDir, `${cacheDirName}-tmp-`));
  try {
    const buildResult = await buildWorkspace({
      workspaceDir,
      outDir: tempBuildDir,
      mode: "local",
    });

    try {
      await rename(tempBuildDir, cacheDir);
      return buildResult;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }

      await rm(tempBuildDir, { recursive: true, force: true });
      return await loadCachedBuild(cacheDir);
    }
  } catch (error) {
    await rm(tempBuildDir, { recursive: true, force: true });
    throw error;
  }
}

async function resolveSessionBuild(
  workspaceDir: string,
  workspaceName: string,
  buildCacheRootDir: string,
  buildDir: string,
): Promise<{ buildOrigin: LocalBuildOrigin; buildResult: BuildWorkspaceResult }> {
  const sourceFingerprint = await fingerprintWorkspaceSource({ workspaceDir });
  const cacheDir = path.join(buildCacheRootDir, workspaceName, sourceFingerprint);

  let buildOrigin: LocalBuildOrigin = "cache-hit";
  let buildResult: BuildWorkspaceResult;

  if (await pathExists(cacheDir)) {
    try {
      buildResult = await loadCachedBuild(cacheDir);
    } catch {
      buildOrigin = "fresh-build";
      buildResult = await populateCacheEntry(workspaceDir, cacheDir);
    }
  } else {
    buildOrigin = "fresh-build";
    buildResult = await populateCacheEntry(workspaceDir, cacheDir);
  }

  await copyBuildArtifacts(cacheDir, buildDir);
  await linkRuntimeNodeModules(buildDir, workspaceDir, buildResult.bundleCode);

  return {
    buildOrigin,
    buildResult,
  };
}

export async function createLocalSession(options: CreateLocalSessionOptions): Promise<LocalSession> {
  const workspaceDir = path.resolve(options.workspaceDir);
  const sessionsRootDir = path.resolve(options.sessionsRootDir ?? getDefaultSessionsRootDir());
  const buildCacheRootDir = path.resolve(options.buildCacheDir ?? getDefaultBuildCacheDir());
  const workspaceName = sanitizeWorkspaceName(workspaceDir);
  const sessionId = createSessionId();
  const sessionRoot = path.join(sessionsRootDir, workspaceName, sessionId);
  const buildDir = path.join(sessionRoot, "build");
  const sandboxDir = path.join(sessionRoot, "sandbox");
  const logsDir = path.join(sessionRoot, "logs");

  await mkdir(sessionRoot, { recursive: true });
  await mkdir(logsDir, { recursive: true });

  const { buildOrigin, buildResult } = await resolveSessionBuild(
    workspaceDir,
    workspaceName,
    buildCacheRootDir,
    buildDir,
  );
  const localSystemFiles = await loadLocalSystemContent(options.systemDir);

  await materializeSandbox({
    sandboxDir,
    revisionFs: buildResult.revisionFs,
    localSystemFiles,
  });

  const buildManifestPath = path.join(buildDir, "manifest.json");
  const bundlePath = path.join(buildDir, buildResult.manifest.artifacts.bundle.path);
  const manifest: LocalSessionManifest = {
    version: SESSION_LAYOUT_VERSION,
    sessionId,
    createdAt: new Date().toISOString(),
    workspaceName,
    workspaceDir,
    sessionRoot,
    buildDir,
    sandboxDir,
    logsDir,
    bundlePath,
    buildManifestPath,
    sourceFingerprint: buildResult.manifest.sourceFingerprint,
    buildOrigin,
  };

  await writeFile(path.join(sessionRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    manifest,
    sessionRoot,
    buildDir,
    sandboxDir,
    logsDir,
    bundlePath,
    buildManifestPath,
    fileSystem: new LocalSessionFs(sandboxDir),
    buildResult,
  };
}
