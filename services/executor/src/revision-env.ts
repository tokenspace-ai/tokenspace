import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

type RevisionDepsArtifact = {
  packageJson?: string;
  bunLock?: string;
  bunLockbBase64?: string;
};

type EnsureRevisionEnvArgs = {
  revisionId: string;
  bundleUrl: string;
  depsUrl?: string | null;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function safePathComponent(component: string): string {
  return encodeURIComponent(component);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function downloadText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  return await response.text();
}

async function downloadJson<T>(url: string): Promise<T> {
  const text = await downloadText(url);
  return JSON.parse(text) as T;
}

async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(`${process.pid}`);
      await handle.close();
      break;
    } catch (error: any) {
      if (error?.code === "EEXIST") {
        await sleep(50);
        continue;
      }
      throw error;
    }
  }

  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}

async function runBunInstall(cwd: string, args: { frozenLockfile: boolean }): Promise<void> {
  const bun = process.execPath;
  const command = ["install"];
  if (args.frozenLockfile) {
    command.push("--frozen-lockfile");
  }
  const child = spawn(bun, command, {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      // Ensure bun doesn't prompt.
      CI: process.env.CI ?? "1",
    },
  });

  const exitCode: number = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    throw new Error(`bun install failed with exit code ${exitCode}`);
  }
}

function getMonorepoRoot(): string {
  return join(import.meta.dir, "..", "..", "..");
}

const WORKSPACE_DIRS = ["apps", "examples", "packages", "services"];

async function findWorkspacePackage(monorepoRoot: string, packageName: string): Promise<string | null> {
  for (const dir of WORKSPACE_DIRS) {
    const parentDir = join(monorepoRoot, dir);
    let entries: string[];
    try {
      entries = await readdir(parentDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const pkgJsonPath = join(parentDir, entry, "package.json");
      try {
        const raw = await readFile(pkgJsonPath, "utf8");
        const pkg = JSON.parse(raw) as { name?: string };
        if (pkg.name === packageName) {
          return join(parentDir, entry);
        }
      } catch {}
    }
  }
  return null;
}

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

export async function rewriteRevisionPackageJsonWorkspaceDeps(
  pkg: Record<string, unknown>,
  resolveWorkspacePackage: (packageName: string) => Promise<string | null>,
): Promise<{ stripped: boolean; linkTargets: Array<{ name: string; target: string }> }> {
  const linkTargetMap = new Map<string, string>();
  let stripped = false;

  for (const field of DEPENDENCY_FIELDS) {
    const deps = pkg[field] as Record<string, string> | undefined;
    if (!deps) continue;

    for (const [name, version] of Object.entries(deps)) {
      if (typeof version !== "string") continue;

      if (version.startsWith("workspace:")) {
        let pkgDir: string | null | undefined = linkTargetMap.get(name);
        if (!pkgDir) {
          pkgDir = await resolveWorkspacePackage(name);
          if (!pkgDir) {
            throw new Error(`Unable to resolve workspace dependency "${name}" from monorepo root`);
          }
          linkTargetMap.set(name, pkgDir);
        }
        delete deps[name];
        stripped = true;
        continue;
      }

      if (linkTargetMap.has(name)) {
        continue;
      }

      const pkgDir = await resolveWorkspacePackage(name);
      if (pkgDir) {
        linkTargetMap.set(name, pkgDir);
      }
    }

    if (Object.keys(deps).length === 0) {
      delete pkg[field];
    }
  }

  return {
    stripped,
    linkTargets: [...linkTargetMap].map(([name, target]) => ({ name, target })),
  };
}

/**
 * Strip workspace:* deps from package.json so bun install can run in isolation,
 * then symlink matching monorepo packages into node_modules after install.
 *
 * Also collects non-workspace:* deps that match monorepo packages (e.g. "@tokenspace/sdk": "^0.1.0")
 * so they can be symlinked after install to ensure the runtime and bundle share the same module instance.
 */
async function resolveWorkspaceDeps(
  packageJsonPath: string,
): Promise<{ stripped: boolean; linkTargets: Array<{ name: string; target: string }> }> {
  const raw = await readFile(packageJsonPath, "utf8");
  const pkg = JSON.parse(raw) as Record<string, unknown>;
  const monorepoRoot = getMonorepoRoot();
  const { stripped, linkTargets } = await rewriteRevisionPackageJsonWorkspaceDeps(pkg, async (name) => {
    const pkgDir = await findWorkspacePackage(monorepoRoot, name);
    if (!pkgDir) {
      return null;
    }
    return pkgDir;
  });

  if (stripped) {
    await writeFile(packageJsonPath, JSON.stringify(pkg, null, 2), "utf8");
  }
  return { stripped, linkTargets };
}

async function symlinkWorkspacePackages(
  revisionDir: string,
  linkTargets: Array<{ name: string; target: string }>,
): Promise<void> {
  for (const { name, target } of linkTargets) {
    const parts = name.split("/");
    const linkDir =
      parts.length > 1 ? join(revisionDir, "node_modules", ...parts.slice(0, -1)) : join(revisionDir, "node_modules");
    await mkdir(linkDir, { recursive: true });
    const linkPath = join(revisionDir, "node_modules", ...parts);

    try {
      const s = await lstat(linkPath);
      if (s.isSymbolicLink()) continue;
      // npm-installed directory — remove it so we can replace with a symlink.
      await rm(linkPath, { recursive: true, force: true });
    } catch {}

    await symlink(target, linkPath);
  }
}

function getRevisionEnvRoot(): string {
  return join(import.meta.dir, "..", ".cache", "revision-envs");
}

export type RevisionEnv = {
  revisionDir: string;
  bundlePath: string;
};

export async function ensureRevisionEnv(args: EnsureRevisionEnvArgs): Promise<RevisionEnv> {
  const root = getRevisionEnvRoot();
  await mkdir(root, { recursive: true });

  const revisionDir = join(root, safePathComponent(args.revisionId));
  await mkdir(revisionDir, { recursive: true });

  const bundlePath = join(revisionDir, "bundle.mjs");
  const depsPath = join(revisionDir, "deps.json");
  const installLockPath = join(revisionDir, "install.lock");
  const installStatePath = join(revisionDir, "install-state.json");

  // Fetch and write bundle once per revision.
  if (!(await fileExists(bundlePath))) {
    const code = await downloadText(args.bundleUrl);
    await writeFile(bundlePath, code, "utf8");
  }

  // Fetch and write deps metadata (if available).
  if (args.depsUrl && !(await fileExists(depsPath))) {
    const deps = await downloadJson<RevisionDepsArtifact>(args.depsUrl);
    await writeFile(depsPath, JSON.stringify(deps), "utf8");
  }

  // If we have package.json, run bun install once. (Revision is immutable; install is cacheable.)
  const deps: RevisionDepsArtifact | null = (await fileExists(depsPath))
    ? (JSON.parse(await readFile(depsPath, "utf8")) as RevisionDepsArtifact)
    : null;

  if (deps?.packageJson) {
    const depsPackageJson = deps.packageJson;
    const packageJsonPath = join(revisionDir, "package.json");
    const depsHash = sha256(JSON.stringify(deps));
    await withFileLock(installLockPath, async () => {
      await writeFile(packageJsonPath, depsPackageJson, "utf8");
      const { stripped, linkTargets } = await resolveWorkspaceDeps(packageJsonPath);

      try {
        if (deps.bunLock && !stripped) {
          const bunLockPath = join(revisionDir, "bun.lock");
          if (!(await fileExists(bunLockPath))) {
            await writeFile(bunLockPath, deps.bunLock, "utf8");
          }
        }

        if (deps.bunLockbBase64 && !stripped) {
          const bunLockbPath = join(revisionDir, "bun.lockb");
          if (!(await fileExists(bunLockbPath))) {
            const bytes = Buffer.from(deps.bunLockbBase64, "base64");
            await writeFile(bunLockbPath, bytes);
          }
        }

        const stateRaw = (await fileExists(installStatePath)) ? await readFile(installStatePath, "utf8") : null;
        const state = stateRaw ? (JSON.parse(stateRaw) as { depsHash: string }) : null;
        if (state?.depsHash === depsHash && (await fileExists(join(revisionDir, "node_modules")))) {
          return;
        }

        const useFrozenLockfile = !stripped && Boolean(deps.bunLock || deps.bunLockbBase64);
        await runBunInstall(revisionDir, { frozenLockfile: useFrozenLockfile });
        if (linkTargets.length > 0) {
          await symlinkWorkspacePackages(revisionDir, linkTargets);
        }
        await writeFile(installStatePath, JSON.stringify({ depsHash }), "utf8");
      } finally {
        if (stripped) {
          await writeFile(packageJsonPath, depsPackageJson, "utf8");
        }
      }
    });
  }

  return { revisionDir, bundlePath };
}
