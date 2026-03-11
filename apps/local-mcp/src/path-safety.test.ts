import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveSandboxPath, SandboxPathError } from "./path-safety";

describe("resolveSandboxPath", () => {
  it("normalizes relative sandbox paths", async () => {
    const sandboxRoot = await mkdtemp(path.join(tmpdir(), "tokenspace-local-mcp-paths-"));
    const canonicalSandboxRoot = await realpath(sandboxRoot);
    const resolved = await resolveSandboxPath({
      sandboxRoot,
      path: "./docs//guides/../guide.md",
    });

    expect(resolved.relativePath).toBe("docs/guide.md");
    expect(resolved.absolutePath).toBe(path.join(canonicalSandboxRoot, "docs/guide.md"));
  });

  it("accepts absolute /sandbox paths", async () => {
    const sandboxRoot = await mkdtemp(path.join(tmpdir(), "tokenspace-local-mcp-paths-"));
    const resolved = await resolveSandboxPath({
      sandboxRoot,
      path: "/sandbox/memory/note.txt",
    });

    expect(resolved.relativePath).toBe("memory/note.txt");
  });

  it("rejects traversal outside the sandbox root", async () => {
    const sandboxRoot = await mkdtemp(path.join(tmpdir(), "tokenspace-local-mcp-paths-"));

    await expect(
      resolveSandboxPath({
        sandboxRoot,
        path: "../../secret.txt",
      }),
    ).rejects.toThrow(SandboxPathError);
  });

  it("rejects absolute paths outside /sandbox", async () => {
    const sandboxRoot = await mkdtemp(path.join(tmpdir(), "tokenspace-local-mcp-paths-"));

    await expect(
      resolveSandboxPath({
        sandboxRoot,
        path: "/etc/passwd",
      }),
    ).rejects.toThrow(SandboxPathError);
  });

  it("rejects symlink traversal inside the sandbox", async () => {
    const sandboxRoot = await mkdtemp(path.join(tmpdir(), "tokenspace-local-mcp-paths-"));
    const outsideDir = await mkdtemp(path.join(tmpdir(), "tokenspace-local-mcp-outside-"));
    const linkPath = path.join(sandboxRoot, "linked");

    await mkdir(path.join(outsideDir, "docs"), { recursive: true });
    await symlink(outsideDir, linkPath);

    await expect(
      resolveSandboxPath({
        sandboxRoot,
        path: "linked/docs/file.txt",
      }),
    ).rejects.toThrow(SandboxPathError);
  });
});
