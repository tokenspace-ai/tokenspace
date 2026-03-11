import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ensureGitignoreEntry,
  findNearestLinkedWorkspaceRoot,
  findNearestTokenspaceWorkspaceRoot,
  getLocalFiles,
  readLinkedWorkspaceConfig,
  shouldIgnoreRelativePath,
  writeLinkedWorkspaceConfig,
} from "./local-workspace";

describe("local workspace helpers", () => {
  it("writes and reads linked workspace metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tokenspace-linked-workspace-"));

    try {
      await writeLinkedWorkspaceConfig(root, "example-space");
      const linked = await readLinkedWorkspaceConfig(root);
      expect(linked).toEqual({
        version: 1,
        workspaceSlug: "example-space",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("adds .tokenspace/ to .gitignore only once", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tokenspace-gitignore-"));

    try {
      await ensureGitignoreEntry(root);
      await ensureGitignoreEntry(root);

      const gitignore = await readFile(path.join(root, ".gitignore"), "utf8");
      expect(gitignore).toBe(".tokenspace/\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves the nearest linked workspace root from nested directories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tokenspace-linked-root-"));
    const nested = path.join(root, "src", "capabilities", "nested");

    try {
      await mkdir(nested, { recursive: true });
      await writeLinkedWorkspaceConfig(root, "example-space");

      expect(await findNearestLinkedWorkspaceRoot(nested)).toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to TOKENSPACE.md when locating a local workspace root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tokenspace-workspace-root-"));
    const nested = path.join(root, "src", "capabilities", "nested");

    try {
      await mkdir(nested, { recursive: true });
      await Bun.write(path.join(root, "TOKENSPACE.md"), "# Example\n");

      expect(await findNearestTokenspaceWorkspaceRoot(nested)).toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores only the workspace root build directory", () => {
    expect(shouldIgnoreRelativePath("build/tokenspace/manifest.json")).toBe(true);
    expect(shouldIgnoreRelativePath("src/build/index.ts")).toBe(false);
  });

  it("can include binary files when requested", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tokenspace-local-files-"));

    try {
      await Bun.write(path.join(root, "logo.png"), "png");
      await Bun.write(path.join(root, "README.md"), "# Example\n");
      await mkdir(path.join(root, "build"), { recursive: true });
      await Bun.write(path.join(root, "build", "ignored.txt"), "ignored");

      expect(await getLocalFiles(root)).toEqual(["README.md"]);
      expect(await getLocalFiles(root, { includeBinary: true })).toEqual(["README.md", "logo.png"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
