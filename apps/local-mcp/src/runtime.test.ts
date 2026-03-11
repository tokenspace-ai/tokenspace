import { describe, expect, it } from "bun:test";
import { access, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeLocalSessionBash, executeLocalSessionCode } from "./runtime";
import { createLocalSession } from "./session";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const EXAMPLES_DIR = path.join(REPO_ROOT, "examples");

describe("@tokenspace/local-mcp", () => {
  it("persists filesystem state across TypeScript and bash tool calls", async () => {
    const sessionsRootDir = await mkdtemp(path.join(tmpdir(), "tokenspace-local-mcp-sessions-"));
    const session = await createLocalSession({
      workspaceDir: path.join(EXAMPLES_DIR, "testing"),
      sessionsRootDir,
    });

    const tsResult = await executeLocalSessionCode(
      session,
      `
const status = await testing.testConnection({});
console.log("status:", status);
await fs.write("/sandbox/persisted.txt", "hello from ts");
console.log("wrote");
`,
    );
    expect(tsResult.output).toContain("status: it works!");
    expect(tsResult.output).toContain("wrote");

    const bashResult = await executeLocalSessionBash(
      session,
      `
cat /sandbox/persisted.txt
echo "hello from bash" > /sandbox/from-bash.txt
`,
    );
    expect(bashResult.output).toContain("hello from ts");

    const tsReadBack = await executeLocalSessionCode(
      session,
      `
console.log("bash file:", await fs.readText("/sandbox/from-bash.txt"));
`,
    );
    expect(tsReadBack.output).toContain("bash file: hello from bash");

    expect(await readFile(path.join(session.sandboxDir, "persisted.txt"), "utf8")).toBe("hello from ts");
    expect(await readFile(path.join(session.sandboxDir, "from-bash.txt"), "utf8")).toBe("hello from bash\n");
  });

  // it("creates an inspectable session layout for examples/siftd", async () => {
  //   const sessionsRootDir = await mkdtemp(path.join(tmpdir(), "tokenspace-local-mcp-sessions-"));
  //   const session = await createLocalSession({
  //     workspaceDir: path.join(EXAMPLES_DIR, "siftd"),
  //     sessionsRootDir,
  //   });

  //   const manifestText = await readFile(path.join(session.sessionRoot, "manifest.json"), "utf8");
  //   const builtins = await readFile(path.join(session.sandboxDir, "builtins.d.ts"), "utf8");
  //   const linearCapability = await readFile(
  //     path.join(session.sandboxDir, "capabilities/linear/capability.d.ts"),
  //     "utf8",
  //   );
  //   const systemSkill = await readFile(path.join(session.sandboxDir, "system/skills/bash/SKILL.md"), "utf8");

  //   expect(manifestText).toContain('"workspaceName": "siftd"');
  //   expect(builtins.length).toBeGreaterThan(0);
  //   expect(linearCapability).toContain("declare namespace linear");
  //   expect(systemSkill).toContain("local MCP");
  // });

  it("rejects symlink traversal during runtime execution", async () => {
    const sessionsRootDir = await mkdtemp(path.join(tmpdir(), "tokenspace-local-mcp-sessions-"));
    const outsideDir = await mkdtemp(path.join(tmpdir(), "tokenspace-local-mcp-outside-"));
    const session = await createLocalSession({
      workspaceDir: path.join(EXAMPLES_DIR, "testing"),
      sessionsRootDir,
    });

    await writeFile(path.join(outsideDir, "secret.txt"), "secret");
    await symlink(outsideDir, path.join(session.sandboxDir, "linked"));

    await expect(executeLocalSessionBash(session, "cat /sandbox/linked/secret.txt")).rejects.toThrow(
      "No such file or directory",
    );
    await expect(
      executeLocalSessionCode(session, 'console.log(await fs.readText("/sandbox/linked/secret.txt"));'),
    ).rejects.toThrow("symbolic link");
  });

  it("reuses the build cache across repeated launches", async () => {
    const sessionsRootDir = await mkdtemp(path.join(tmpdir(), "tokenspace-local-mcp-sessions-"));
    const buildCacheDir = await mkdtemp(path.join(tmpdir(), "tokenspace-local-mcp-cache-"));
    const workspaceDir = path.join(EXAMPLES_DIR, "testing");

    const firstSession = await createLocalSession({
      workspaceDir,
      sessionsRootDir,
      buildCacheDir,
    });
    const secondSession = await createLocalSession({
      workspaceDir,
      sessionsRootDir,
      buildCacheDir,
    });

    const cacheManifestPath = path.join(
      buildCacheDir,
      "testing",
      firstSession.manifest.sourceFingerprint,
      "manifest.json",
    );

    await access(cacheManifestPath);
    expect(firstSession.manifest.buildOrigin).toBe("fresh-build");
    expect(secondSession.manifest.buildOrigin).toBe("cache-hit");
    expect(secondSession.manifest.sourceFingerprint).toBe(firstSession.manifest.sourceFingerprint);
  });

  it("falls back to a fresh build when the cached build is corrupt", async () => {
    const sessionsRootDir = await mkdtemp(path.join(tmpdir(), "tokenspace-local-mcp-sessions-"));
    const buildCacheDir = await mkdtemp(path.join(tmpdir(), "tokenspace-local-mcp-cache-"));
    const workspaceDir = path.join(EXAMPLES_DIR, "testing");

    const initialSession = await createLocalSession({
      workspaceDir,
      sessionsRootDir,
      buildCacheDir,
    });
    const cacheManifestPath = path.join(
      buildCacheDir,
      "testing",
      initialSession.manifest.sourceFingerprint,
      "manifest.json",
    );
    await writeFile(cacheManifestPath, "{not valid json}\n", "utf8");

    const repairedSession = await createLocalSession({
      workspaceDir,
      sessionsRootDir,
      buildCacheDir,
    });

    expect(repairedSession.manifest.buildOrigin).toBe("fresh-build");
    expect(repairedSession.manifest.sourceFingerprint).toBe(initialSession.manifest.sourceFingerprint);
  });
});
