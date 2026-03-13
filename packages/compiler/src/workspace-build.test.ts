import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildWorkspace, fingerprintWorkspaceSource, loadBuiltWorkspace } from "./workspace-build";

const REPO_ROOT = path.join(import.meta.dir, "../../..");

async function buildFixture(relativeWorkspaceDir: string, mode: "local" | "server" = "local") {
  const outDir = await mkdtemp(path.join(tmpdir(), "tokenspace-compiler-test-"));
  try {
    const workspaceDir = path.join(REPO_ROOT, relativeWorkspaceDir);
    const result = await buildWorkspace({
      workspaceDir,
      outDir,
      mode,
    });

    const manifestPath = path.join(outDir, "manifest.json");
    const manifestRaw = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(manifestRaw) as { sourceFingerprint: string; artifacts: Record<string, unknown> };

    expect(manifest.sourceFingerprint.length).toBeGreaterThan(10);
    expect(manifest.artifacts).toBeDefined();
    expect(result.bundleCode.length).toBeGreaterThan(0);

    return result;
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

describe("workspace build", () => {
  it("builds examples/testing", async () => {
    const result = await buildFixture("examples/testing");
    expect(result.revisionFs.declarations.length).toBeGreaterThan(0);
    expect(result.revisionFs.system.length).toBe(0);
    expect(result.metadata.models.length).toBeGreaterThan(0);
    expect(result.metadata.credentialRequirements).toEqual([]);
  });

  it("builds examples/demo", async () => {
    const result = await buildFixture("examples/demo");
    expect(result.revisionFs.declarations.length).toBeGreaterThan(0);
    expect(result.revisionFs.system.length).toBe(0);
    expect(result.metadata.capabilities.length).toBeGreaterThan(0);
    expect(result.metadata.credentialRequirements.length).toBeGreaterThan(0);
    expect(result.metadata.models.length).toBeGreaterThan(0);
  });

  it("omits server-only users builtin declarations in local mode", async () => {
    const result = await buildFixture("examples/testing", "local");
    expect(result.revisionFs.builtins).not.toContain("declare const users");
    expect(result.revisionFs.builtins).not.toContain("type TokenspaceUserInfo");
  });

  it("includes users builtin declarations in server mode", async () => {
    const result = await buildFixture("examples/testing", "server");
    expect(result.revisionFs.builtins).toContain("declare const users");
    expect(result.revisionFs.builtins).toContain("type TokenspaceUserInfo");
  });

  it("fails with formatted declaration diagnostics including file path", async () => {
    const workspaceDir = await mkdtemp(path.join(tmpdir(), "tokenspace-compiler-bad-workspace-"));
    const outDir = await mkdtemp(path.join(tmpdir(), "tokenspace-compiler-bad-build-"));

    try {
      const sourcePath = path.join(workspaceDir, "src/capabilities/broken/capability.ts");
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(
        sourcePath,
        `
const token: string = 123;
export const broken = token;
`,
        "utf8",
      );

      let thrown: unknown;
      try {
        await buildWorkspace({
          workspaceDir,
          outDir,
          mode: "local",
        });
      } catch (error) {
        thrown = error;
      }

      const message = thrown instanceof Error ? thrown.message : String(thrown);
      expect(message).toContain("Declaration compilation failed");
      expect(message).toContain("TS");
      expect(message).toContain("src/capabilities/broken/capability.ts");
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("computes a stable source fingerprint without running a full build", async () => {
    const workspaceDir = path.join(REPO_ROOT, "examples/testing");
    const firstFingerprint = await fingerprintWorkspaceSource({ workspaceDir });
    const secondFingerprint = await fingerprintWorkspaceSource({ workspaceDir });

    expect(firstFingerprint).toBe(secondFingerprint);
    expect(firstFingerprint.length).toBeGreaterThan(10);
  });

  it("loads a typed build result from a build directory", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "tokenspace-compiler-load-build-"));

    try {
      const workspaceDir = path.join(REPO_ROOT, "examples/testing");
      const built = await buildWorkspace({
        workspaceDir,
        outDir,
        mode: "local",
      });
      const loaded = await loadBuiltWorkspace(outDir);

      expect(loaded.manifest.sourceFingerprint).toBe(built.manifest.sourceFingerprint);
      expect(loaded.bundleCode).toBe(built.bundleCode);
      expect(loaded.metadata.tokenspaceMd).toBe(built.metadata.tokenspaceMd);
      expect(loaded.revisionFs.declarations.length).toBe(built.revisionFs.declarations.length);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
