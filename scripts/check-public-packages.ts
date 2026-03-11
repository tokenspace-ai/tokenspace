import { readFile } from "node:fs/promises";
import path from "node:path";
import { PUBLIC_PACKAGE_DIRS, PUBLIC_PACKAGE_NAMES } from "./lib/public-packages";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const WORKSPACE_GLOBS = ["apps", "packages", "services", "examples"];
const DIRECT_WORKSPACES = ["scripts"];

type PackageJson = {
  bugs?: string | { url?: string };
  homepage?: string;
  license?: string;
  name?: string;
  private?: boolean;
  repository?: string | { directory?: string; type?: string; url?: string };
};

function hasRepositoryMetadata(repository: PackageJson["repository"], packageDir: string): boolean {
  if (typeof repository === "string") {
    return repository.length > 0;
  }
  if (!repository || typeof repository !== "object") {
    return false;
  }
  return (
    repository.type === "git" &&
    repository.url === "git+https://github.com/tokenspace-ai/tokenspace.git" &&
    repository.directory === packageDir
  );
}

function hasBugsMetadata(bugs: PackageJson["bugs"]): boolean {
  if (typeof bugs === "string") {
    return bugs.length > 0;
  }
  if (!bugs || typeof bugs !== "object") {
    return false;
  }
  return bugs.url === "https://github.com/tokenspace-ai/tokenspace/issues";
}

async function main(): Promise<void> {
  const errors: string[] = [];

  for (const parent of WORKSPACE_GLOBS) {
    const parentDir = path.join(REPO_ROOT, parent);
    let entries: string[] = [];
    try {
      entries = await Array.fromAsync(new Bun.Glob("*").scan(parentDir));
    } catch {
      continue;
    }

    for (const entry of entries) {
      const packageDir = path.join(parent, entry);
      const packageJsonPath = path.join(REPO_ROOT, packageDir, "package.json");
      const file = Bun.file(packageJsonPath);
      if (!(await file.exists())) {
        continue;
      }

      const pkg = (JSON.parse(await readFile(packageJsonPath, "utf8")) as PackageJson) ?? {};
      const isAllowedPublic = PUBLIC_PACKAGE_DIRS.has(packageDir);

      if (isAllowedPublic) {
        if (pkg.private) {
          errors.push(`${packageDir} is in the public allowlist but still marked private`);
        }
        if (!pkg.name || !PUBLIC_PACKAGE_NAMES.has(pkg.name)) {
          errors.push(`${packageDir} has unexpected public package name "${pkg.name ?? "<missing>"}"`);
        }
        if (pkg.license !== "Apache-2.0") {
          errors.push(`${packageDir} must declare license Apache-2.0`);
        }
        if (!hasRepositoryMetadata(pkg.repository, packageDir)) {
          errors.push(`${packageDir} is missing repository metadata for its package directory`);
        }
        if (pkg.homepage !== `https://github.com/tokenspace-ai/tokenspace/tree/main/${packageDir}#readme`) {
          errors.push(`${packageDir} is missing the expected homepage metadata`);
        }
        if (!hasBugsMetadata(pkg.bugs)) {
          errors.push(`${packageDir} is missing the expected bugs metadata`);
        }
        continue;
      }

      if (pkg.private !== true) {
        errors.push(`${packageDir} is publishable but not in the public allowlist`);
      }
    }
  }

  for (const workspaceDir of DIRECT_WORKSPACES) {
    const packageJsonPath = path.join(REPO_ROOT, workspaceDir, "package.json");
    const file = Bun.file(packageJsonPath);
    if (!(await file.exists())) {
      continue;
    }

    const pkg = (JSON.parse(await readFile(packageJsonPath, "utf8")) as PackageJson) ?? {};
    if (PUBLIC_PACKAGE_DIRS.has(workspaceDir)) {
      if (pkg.private) {
        errors.push(`${workspaceDir} is in the public allowlist but still marked private`);
      }
      if (!pkg.name || !PUBLIC_PACKAGE_NAMES.has(pkg.name)) {
        errors.push(`${workspaceDir} has unexpected public package name "${pkg.name ?? "<missing>"}"`);
      }
      if (pkg.license !== "Apache-2.0") {
        errors.push(`${workspaceDir} must declare license Apache-2.0`);
      }
      if (!hasRepositoryMetadata(pkg.repository, workspaceDir)) {
        errors.push(`${workspaceDir} is missing repository metadata for its package directory`);
      }
      if (pkg.homepage !== `https://github.com/tokenspace-ai/tokenspace/tree/main/${workspaceDir}#readme`) {
        errors.push(`${workspaceDir} is missing the expected homepage metadata`);
      }
      if (!hasBugsMetadata(pkg.bugs)) {
        errors.push(`${workspaceDir} is missing the expected bugs metadata`);
      }
      continue;
    }

    if (pkg.private !== true) {
      errors.push(`${workspaceDir} is publishable but not in the public allowlist`);
    }
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    process.exit(1);
  }

  console.log(`Validated ${PUBLIC_PACKAGE_NAMES.size} public packages and private defaults for all other workspaces.`);
}

await main();
