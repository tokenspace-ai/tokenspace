import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.join(import.meta.dir, "../../../..");
const CLI_PATH = path.join(REPO_ROOT, "apps/cli/src/cli.ts");
const CLI_PACKAGE_JSON_PATH = path.join(REPO_ROOT, "apps/cli/package.json");

function stripAnsi(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape sequence matching
  return value.replace(/\x1B\[[0-9;]*m/g, "");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT" ? Promise.reject(error) : false;
  }
}

async function runCli(
  args: string[],
  options: { cwd: string; input?: string; env?: Record<string, string> },
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn("bun", [CLI_PATH, ...args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  if (options.input) {
    child.stdin.write(options.input);
  }
  child.stdin.end();

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });

  return { exitCode, stdout, stderr };
}

async function setupFakeSetupCommands(tempRoot: string): Promise<{
  bunInstallLogFile: string;
  bunInstallMarker: string;
  bunxLogFile: string;
  env: Record<string, string>;
  gitInitLogFile: string;
  gitInitMarker: string;
}> {
  const binDir = path.join(tempRoot, "bin");
  const bunxLogFile = path.join(tempRoot, "fake-bunx.log");
  const gitInitLogFile = path.join(tempRoot, "fake-git.log");
  const bunInstallLogFile = path.join(tempRoot, "fake-bun-install.log");
  const gitInitMarker = path.join(tempRoot, "git-init.marker");
  const bunInstallMarker = path.join(tempRoot, "bun-install.marker");
  const bunxPath = path.join(binDir, "fake-bunx");
  const gitPath = path.join(binDir, "fake-git");
  const bunInstallPath = path.join(binDir, "fake-bun-install");

  await mkdir(binDir, { recursive: true });
  await writeFile(
    bunxPath,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${bunxLogFile}"
mkdir -p skills/capability-authoring/references
cat > skills/capability-authoring/SKILL.md <<'EOF'
---
name: capability-authoring
description: Installed by fake bunx during tests.
---
EOF
cat > skills/capability-authoring/references/capability-template.md <<'EOF'
# Capability template
EOF
`,
    "utf8",
  );
  await writeFile(
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
    "utf8",
  );
  await writeFile(
    bunInstallPath,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${bunInstallLogFile}"
mkdir -p node_modules
touch "${bunInstallMarker}"
`,
    "utf8",
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

describe("tokenspace init", () => {
  it("reports the package version from package.json", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "tokenspace-cli-version-"));

    try {
      const packageJson = JSON.parse(await readFile(CLI_PACKAGE_JSON_PATH, "utf8")) as { version: string };
      const result = await runCli(["--version"], {
        cwd: tempRoot,
      });

      expect(result.exitCode).toBe(0);
      expect(stripAnsi(result.stdout).trim()).toBe(packageJson.version);
      expect(stripAnsi(result.stderr)).toBe("");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("creates a scaffold in ./<slug> from the interactive bare command", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "tokenspace-cli-init-"));

    try {
      const homeDir = path.join(tempRoot, "home");
      await mkdir(homeDir, { recursive: true });

      const result = await runCli(["init"], {
        cwd: tempRoot,
        input: "My Example Workspace\nn\nn\nn\n",
        env: {
          HOME: homeDir,
        },
      });

      expect(result.exitCode).toBe(0);
      const stdout = stripAnsi(result.stdout);
      expect(stdout).toContain("Workspace name:");
      expect(stdout).toContain("Template: default");
      expect(stdout).toContain("Directory: ./my-example-workspace");
      expect(stdout).toContain(
        "bunx skills add https://github.com/tokenspace-ai/skills --skill capability-authoring --agent claude-code -y",
      );

      const workspaceDir = path.join(tempRoot, "my-example-workspace");
      expect(await pathExists(path.join(workspaceDir, "TOKENSPACE.md"))).toBe(true);
      expect(await pathExists(path.join(workspaceDir, "src/capabilities/myExampleWorkspace/capability.ts"))).toBe(true);
      expect(await readFile(path.join(workspaceDir, ".gitignore"), "utf8")).toContain(".tokenspace/");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("runs all setup steps with --yes and standalone deps", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "tokenspace-cli-init-explicit-"));

    try {
      const homeDir = path.join(tempRoot, "home");
      const fakeCommands = await setupFakeSetupCommands(tempRoot);
      await mkdir(homeDir, { recursive: true });

      const result = await runCli(["init", "custom-dir", "--name", "Custom Workspace", "--yes"], {
        cwd: tempRoot,
        env: {
          HOME: homeDir,
          ...fakeCommands.env,
        },
      });

      expect(result.exitCode).toBe(0);
      const workspaceDir = path.join(tempRoot, "custom-dir");
      const packageJson = JSON.parse(await readFile(path.join(workspaceDir, "package.json"), "utf8")) as {
        dependencies: Record<string, string>;
        devDependencies: Record<string, string>;
      };
      expect(packageJson.dependencies["@tokenspace/sdk"]).toMatch(/^\^/);
      expect(packageJson.devDependencies["@tokenspace/compiler"]).toMatch(/^\^/);
      expect(JSON.stringify(packageJson)).not.toContain("workspace:*");

      const capabilityDoc = await readFile(
        path.join(workspaceDir, "src/capabilities/customWorkspace/CAPABILITY.md"),
        "utf8",
      );
      expect(capabilityDoc).toContain("---");
      expect(capabilityDoc).toContain("name:");
      expect(capabilityDoc).toContain("description:");

      const skillDoc = await readFile(path.join(workspaceDir, "skills/capability-authoring/SKILL.md"), "utf8");
      expect(skillDoc).toContain("---");
      expect(skillDoc).toContain("name: capability-authoring");
      expect(skillDoc).toContain("description:");
      expect(
        await pathExists(path.join(workspaceDir, "skills/capability-authoring/references/capability-template.md")),
      ).toBe(true);

      const bunxLog = await readFile(fakeCommands.bunxLogFile, "utf8");
      expect(bunxLog).toContain(
        "skills add https://github.com/tokenspace-ai/skills --skill capability-authoring --agent claude-code -y",
      );
      const gitLog = await readFile(fakeCommands.gitInitLogFile, "utf8");
      expect(gitLog).toContain("init");
      expect(gitLog).toContain("add .");
      expect(gitLog).toContain("commit -m init tokenspace");
      expect(await pathExists(path.join(workspaceDir, ".git"))).toBe(true);
      expect(await pathExists(fakeCommands.gitInitMarker)).toBe(true);
      expect(await pathExists(fakeCommands.bunInstallMarker)).toBe(true);
      expect(await pathExists(path.join(workspaceDir, "node_modules"))).toBe(true);
      const stdout = stripAnsi(result.stdout);
      expect(stdout.indexOf("Install workspace dependencies")).toBeGreaterThan(
        stdout.indexOf("Install capability-authoring skill"),
      );
      expect(stdout.indexOf("Initialize git repository and create the first commit")).toBeGreaterThan(
        stdout.indexOf("Install workspace dependencies"),
      );
      expect(stdout).toContain('tokenspace link --create --name "Custom Workspace" --slug "custom-workspace"');
      expect(stdout).toContain("tokenspace push");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not require auth state to initialize a workspace", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "tokenspace-cli-init-no-auth-"));

    try {
      const homeDir = path.join(tempRoot, "empty-home");
      await mkdir(homeDir, { recursive: true });

      const result = await runCli(
        [
          "init",
          "local-workspace",
          "--name",
          "No Auth Workspace",
          "--skip-install-skill",
          "--skip-git-init",
          "--skip-bun-install",
        ],
        {
          cwd: tempRoot,
          env: {
            HOME: homeDir,
            CONVEX_URL: "",
          },
        },
      );

      expect(result.exitCode).toBe(0);
      expect(stripAnsi(result.stderr)).toBe("");
      expect(await pathExists(path.join(tempRoot, "local-workspace/TOKENSPACE.md"))).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("allows skip flags to override --yes defaults", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "tokenspace-cli-init-overrides-"));

    try {
      const homeDir = path.join(tempRoot, "home");
      const fakeCommands = await setupFakeSetupCommands(tempRoot);
      await mkdir(homeDir, { recursive: true });

      const result = await runCli(
        [
          "init",
          "override-workspace",
          "--name",
          "Override Workspace",
          "--yes",
          "--skip-git-init",
          "--skip-bun-install",
        ],
        {
          cwd: tempRoot,
          env: {
            HOME: homeDir,
            ...fakeCommands.env,
          },
        },
      );

      expect(result.exitCode).toBe(0);
      expect(await pathExists(path.join(tempRoot, "override-workspace/skills/capability-authoring/SKILL.md"))).toBe(
        true,
      );
      expect(await pathExists(path.join(tempRoot, "override-workspace/.git"))).toBe(false);
      expect(await pathExists(path.join(tempRoot, "override-workspace/node_modules"))).toBe(false);
      const gitLog = (await pathExists(fakeCommands.gitInitLogFile))
        ? await readFile(fakeCommands.gitInitLogFile, "utf8")
        : "";
      expect(gitLog).toBe("");
      expect(await pathExists(fakeCommands.gitInitMarker)).toBe(false);
      expect(await pathExists(fakeCommands.bunInstallMarker)).toBe(false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails cleanly when the target directory already exists", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "tokenspace-cli-init-existing-"));

    try {
      const homeDir = path.join(tempRoot, "home");
      const existingDir = path.join(tempRoot, "existing-workspace");
      const fakeCommands = await setupFakeSetupCommands(tempRoot);
      await mkdir(homeDir, { recursive: true });
      await mkdir(existingDir, { recursive: true });
      await writeFile(path.join(existingDir, "sentinel.txt"), "keep me\n", "utf8");

      const result = await runCli(["init", "existing-workspace", "--name", "Existing Workspace", "--yes"], {
        cwd: tempRoot,
        env: {
          HOME: homeDir,
          ...fakeCommands.env,
        },
      });

      expect(result.exitCode).toBe(1);
      expect(stripAnsi(result.stderr)).toContain("Target directory already exists");
      expect(await pathExists(path.join(existingDir, "sentinel.txt"))).toBe(true);
      expect(await pathExists(path.join(existingDir, "TOKENSPACE.md"))).toBe(false);
      expect(await pathExists(fakeCommands.gitInitMarker)).toBe(false);
      expect(await pathExists(fakeCommands.bunInstallMarker)).toBe(false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("normalizes an invalid capability namespace to workspace", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "tokenspace-cli-init-namespace-"));

    try {
      const homeDir = path.join(tempRoot, "home");
      await mkdir(homeDir, { recursive: true });

      const result = await runCli(
        ["init", "edge-case", "--name", "123 !!!", "--skip-install-skill", "--skip-git-init", "--skip-bun-install"],
        {
          cwd: tempRoot,
          env: {
            HOME: homeDir,
          },
        },
      );

      expect(result.exitCode).toBe(0);
      expect(await pathExists(path.join(tempRoot, "edge-case/src/capabilities/workspace/capability.ts"))).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
