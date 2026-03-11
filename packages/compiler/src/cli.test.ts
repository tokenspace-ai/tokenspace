import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.join(import.meta.dir, "../../..");
const CLI_PATH = path.join(REPO_ROOT, "packages/compiler/src/cli.ts");

async function runCli(args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const child = spawn("bun", [CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });

  return { exitCode, stdout, stderr };
}

describe("tokenspace-compiler CLI", () => {
  it("prints progress and extracted credential findings on successful build", async () => {
    const workspaceDir = await mkdtemp(path.join(tmpdir(), "tokenspace-compiler-cli-progress-"));
    const outDir = path.join(workspaceDir, "build");

    try {
      const credentialsPath = path.join(workspaceDir, "src/credentials.ts");
      await mkdir(path.dirname(credentialsPath), { recursive: true });
      await writeFile(
        credentialsPath,
        `
export const apiKey = {
  kind: "secret",
  id: "api-key",
  scope: "workspace",
};
`,
        "utf8",
      );

      const result = await runCli(["build", "--workspace", workspaceDir, "--out-dir", outDir]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("credentialCount: 1");
      expect(result.stdout).toContain("Workspace build completed");
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("prints declaration compilation failures to stdout", async () => {
    const workspaceDir = await mkdtemp(path.join(tmpdir(), "tokenspace-compiler-cli-workspace-"));
    const outDir = path.join(workspaceDir, "build");

    try {
      const sourcePath = path.join(workspaceDir, "src/capabilities/broken/capability.ts");
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(
        sourcePath,
        `
const value: string = 123;
export const broken = value;
`,
        "utf8",
      );

      const result = await runCli(["build", "--workspace", workspaceDir, "--out-dir", outDir]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("Declaration compilation failed");
      expect(result.stdout).toContain("src/capabilities/broken/capability.ts");
      expect(result.stdout).toContain("TS");
      expect(result.stderr).not.toContain("Declaration compilation failed");
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("prints usage for argument parse errors", async () => {
    const result = await runCli(["build", "--unknown-flag"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Usage:");
    expect(result.stderr).toContain("Unknown argument");
  });

  it("returns a non-zero exit code when no command is provided", async () => {
    const result = await runCli([]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Usage:");
    expect(result.stderr).toContain("Missing command");
  });
});
