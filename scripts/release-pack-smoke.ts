import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PUBLIC_PACKAGES, type PublicPackageSpec } from "./lib/public-packages";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const DRY_RUN = process.argv.includes("--dry-run");

type PackFile = {
  path: string;
};

type PackResult = {
  filename: string;
  files: PackFile[];
};

type PackageJson = {
  bin?: Record<string, string> | string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  main?: string;
  types?: string;
  exports?: unknown;
};

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await Bun.file(filePath).stat();
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT" ? Promise.reject(error) : false;
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function run(command: string[], cwd: string, envOverrides?: Record<string, string>): Promise<string> {
  const proc = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...envOverrides,
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed in ${cwd}\n${stderr || stdout}`);
  }
  return stdout.trim();
}

async function setupFakeSetupCommands(installDir: string): Promise<{
  bunInstallLogFile: string;
  bunInstallMarker: string;
  bunxLogFile: string;
  env: Record<string, string>;
  gitInitLogFile: string;
  gitInitMarker: string;
}> {
  const binDir = path.join(installDir, ".fake-bin");
  const bunxLogFile = path.join(installDir, "fake-bunx.log");
  const gitInitLogFile = path.join(installDir, "fake-git.log");
  const bunInstallLogFile = path.join(installDir, "fake-bun-install.log");
  const gitInitMarker = path.join(installDir, "fake-git-init.marker");
  const bunInstallMarker = path.join(installDir, "fake-bun-install.marker");
  const bunxPath = path.join(binDir, "fake-bunx");
  const gitPath = path.join(binDir, "fake-git");
  const bunInstallPath = path.join(binDir, "fake-bun-install");

  await mkdir(binDir, { recursive: true });
  await Bun.write(
    bunxPath,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${bunxLogFile}"
mkdir -p skills/capability-authoring/references
cat > skills/capability-authoring/SKILL.md <<'EOF'
---
name: capability-authoring
description: Installed by fake bunx during release smoke tests.
---
EOF
cat > skills/capability-authoring/references/capability-template.md <<'EOF'
# Capability template
EOF
`,
  );
  await Bun.write(
    gitPath,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${gitInitLogFile}"
if [ "$1" = "init" ]; then
  mkdir -p .git
fi
if [ "$1" = "commit" ]; then
  touch "${gitInitMarker}"
fi
`,
  );
  await Bun.write(
    bunInstallPath,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${bunInstallLogFile}"
mkdir -p node_modules
touch "${bunInstallMarker}"
`,
  );
  await Promise.all([chmod(bunxPath, 0o755), chmod(gitPath, 0o755), chmod(bunInstallPath, 0o755)]);

  return {
    bunInstallLogFile,
    bunInstallMarker,
    bunxLogFile,
    env: {
      TOKENSPACE_BUNX_BIN: bunxPath,
      TOKENSPACE_GIT_BIN: gitPath,
      TOKENSPACE_BUN_INSTALL_BIN: bunInstallPath,
    },
    gitInitLogFile,
    gitInitMarker,
  };
}

function parsePackMetadata(output: string): PackResult[] {
  const match = output.match(/\[\s*\{[\s\S]*\}\s*\]\s*$/);
  if (!match) {
    throw new Error(`Unable to find npm pack JSON payload in output:\n${output}`);
  }
  return JSON.parse(match[0]) as PackResult[];
}

function collectExportPaths(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  return Object.values(value as Record<string, unknown>).flatMap((entry) => collectExportPaths(entry));
}

function ensureNoWorkspaceVersions(pkg: PackageJson, packageName: string): void {
  for (const blockName of ["dependencies", "peerDependencies"] as const) {
    const block = pkg[blockName];
    if (!block) continue;
    for (const [dependency, version] of Object.entries(block)) {
      if (version.startsWith("workspace:")) {
        throw new Error(`${packageName} still contains workspace dependency ${dependency}@${version}`);
      }
      if (version === "catalog:") {
        throw new Error(`${packageName} still contains catalog dependency ${dependency}@${version}`);
      }
    }
  }
}

function validatePackFiles(spec: PublicPackageSpec, packResult: PackResult, pkg: PackageJson): void {
  const fileSet = new Set(packResult.files.map((file) => file.path));

  for (const requiredPath of spec.requiredFiles) {
    assert(fileSet.has(requiredPath), `${spec.name} tarball is missing ${requiredPath}`);
  }

  for (const filePath of fileSet) {
    const allowedPrefix =
      filePath.startsWith("dist/") || filePath === "LICENSE" || filePath === "README.md" || filePath === "package.json";
    const allowedSystem = spec.allowSystemDir && filePath.startsWith("system/");
    const allowedExtraPrefix = spec.allowedPrefixes?.some((prefix) => filePath.startsWith(prefix)) ?? false;
    assert(
      allowedPrefix || allowedSystem || allowedExtraPrefix,
      `${spec.name} tarball includes unexpected file ${filePath}`,
    );
    assert(!filePath.startsWith("src/"), `${spec.name} tarball still includes source file ${filePath}`);
    assert(!filePath.includes(".test."), `${spec.name} tarball still includes test file ${filePath}`);
    assert(!filePath.includes("__snapshots__"), `${spec.name} tarball still includes snapshot file ${filePath}`);
  }

  const exportedPaths = [
    pkg.main,
    pkg.types,
    ...collectExportPaths(pkg.exports),
    ...(typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin ?? {})),
  ].filter((value): value is string => Boolean(value?.startsWith("./")));

  for (const exportedPath of exportedPaths) {
    assert(fileSet.has(exportedPath.slice(2)), `${spec.name} export target ${exportedPath} is not packed`);
  }
}

async function packPackage(spec: PublicPackageSpec, packDir?: string): Promise<PackResult> {
  const cwd = path.join(REPO_ROOT, spec.dir);
  const pkg = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8")) as PackageJson;
  ensureNoWorkspaceVersions(pkg, spec.name);

  const packArgs = ["npm", "pack", "--json"];
  if (DRY_RUN) {
    packArgs.push("--dry-run");
  }
  if (packDir) {
    packArgs.push("--pack-destination", packDir);
  }

  const stdout = await run(packArgs, cwd);
  const parsed = parsePackMetadata(stdout);
  const packResult = parsed[0];
  assert(packResult, `npm pack did not return metadata for ${spec.name}`);
  validatePackFiles(spec, packResult, pkg);
  return packResult;
}

async function runInstallSmoke(packDir: string, filenames: string[]): Promise<void> {
  const installDir = await mkdtemp(path.join(tmpdir(), "tokenspace-pack-install-"));
  try {
    const fakeCommands = await setupFakeSetupCommands(installDir);
    await writeFile(
      path.join(installDir, "package.json"),
      JSON.stringify({ name: "tokenspace-pack-smoke", private: true, type: "module" }, null, 2),
      "utf8",
    );

    const tarballs = filenames.map((filename) => path.join(packDir, filename));
    await run(["npm", "install", "--ignore-scripts", "--no-package-lock", ...tarballs], installDir);

    await run(["bun", "./node_modules/tokenspace/dist/cli.js", "--help"], installDir);
    await run(
      ["bun", "./node_modules/tokenspace/dist/cli.js", "init", "smoke-workspace", "--name", "Smoke Workspace", "--yes"],
      installDir,
      fakeCommands.env,
    );
    await run(["bun", "./node_modules/@tokenspace/compiler/dist/cli.js", "--help"], installDir);
    await run(["bun", "./node_modules/@tokenspace/local-mcp/dist/cli.js", "--help"], installDir);

    const scaffoldDir = path.join(installDir, "smoke-workspace");
    const scaffoldPackage = JSON.parse(await readFile(path.join(scaffoldDir, "package.json"), "utf8")) as PackageJson;
    assert(
      scaffoldPackage.dependencies?.["@tokenspace/sdk"]?.startsWith("^"),
      "tokenspace init scaffold is missing @tokenspace/sdk",
    );
    assert(
      scaffoldPackage.devDependencies?.["@tokenspace/compiler"]?.startsWith("^"),
      "tokenspace init scaffold is missing @tokenspace/compiler",
    );
    assert(
      await pathExists(path.join(scaffoldDir, "skills/capability-authoring/SKILL.md")),
      "tokenspace init scaffold is missing installed capability-authoring skill files",
    );
    assert(await pathExists(path.join(scaffoldDir, ".git")), "tokenspace init did not initialize a git repository");
    assert(await pathExists(path.join(scaffoldDir, "node_modules")), "tokenspace init did not run bun install");
    assert(
      await pathExists(fakeCommands.gitInitMarker),
      "tokenspace init did not complete the git initialization flow",
    );
    assert(await pathExists(fakeCommands.bunInstallMarker), "tokenspace init did not execute bun install");

    const bunxLog = await readFile(fakeCommands.bunxLogFile, "utf8");
    assert(
      bunxLog.includes(
        "skills add https://github.com/tokenspace-ai/skills --skill capability-authoring --agent claude-code -y",
      ),
      "tokenspace init did not invoke the expected skills installer command",
    );
    const gitLog = await readFile(fakeCommands.gitInitLogFile, "utf8");
    assert(gitLog.includes("init"), "tokenspace init did not run git init");
    assert(gitLog.includes("add ."), "tokenspace init did not stage the scaffolded files");
    assert(gitLog.includes("commit -m init tokenspace"), "tokenspace init did not create the initial commit");

    await run(
      [
        "bun",
        "-e",
        [
          "import '@tokenspace/sdk';",
          "import '@tokenspace/sdk/credentials';",
          "import { buildWorkspace } from '@tokenspace/compiler';",
          "import { executeCode } from '@tokenspace/runtime-core';",
          "import { SANDBOX_TYPES } from '@tokenspace/types';",
          "import { getSystemContentFiles } from '@tokenspace/system-content';",
          "void buildWorkspace; void executeCode; void SANDBOX_TYPES; void getSystemContentFiles;",
        ].join(" "),
      ],
      installDir,
    );
  } finally {
    await rm(installDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const packDir = DRY_RUN ? undefined : await mkdtemp(path.join(tmpdir(), "tokenspace-packs-"));
  try {
    const filenames: string[] = [];
    for (const spec of PUBLIC_PACKAGES) {
      const packResult = await packPackage(spec, packDir);
      if (packDir) {
        filenames.push(packResult.filename);
      }
      console.log(`Validated ${spec.name}`);
    }

    if (packDir) {
      await runInstallSmoke(packDir, filenames);
      console.log("Validated installation smoke test");
    }
  } finally {
    if (packDir) {
      await rm(packDir, { recursive: true, force: true });
    }
  }
}

await main();
