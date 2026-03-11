import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RevisionFilesystemArtifact } from "@tokenspace/compiler";
import { materializeSandbox } from "./materialize-sandbox";

describe("materializeSandbox", () => {
  it("writes declarations, builtins, binary files, and local system content", async () => {
    const sandboxDir = await mkdtemp(path.join(tmpdir(), "tokenspace-local-mcp-sandbox-"));
    const binaryBytes = Uint8Array.from([0, 1, 2, 3, 255]);
    const revisionFs: RevisionFilesystemArtifact = {
      declarations: [
        {
          fileName: "capabilities/testing/capability.d.ts",
          content: "declare namespace testing {}",
        },
      ],
      files: [
        {
          path: "docs/readme.md",
          content: "# hello",
        },
        {
          path: "assets/logo.bin",
          content: Buffer.from(binaryBytes).toString("base64"),
          binary: true,
        },
      ],
      system: [],
      builtins: "declare const fs: unknown;",
    };

    await materializeSandbox({
      sandboxDir,
      revisionFs,
      localSystemFiles: [
        {
          path: "skills/bash/SKILL.md",
          content: "Local MCP bash skill",
        },
      ],
    });

    expect(await readFile(path.join(sandboxDir, "capabilities/testing/capability.d.ts"), "utf8")).toContain("testing");
    expect(await readFile(path.join(sandboxDir, "docs/readme.md"), "utf8")).toBe("# hello");
    expect(await readFile(path.join(sandboxDir, "builtins.d.ts"), "utf8")).toContain("declare const fs");
    expect(await readFile(path.join(sandboxDir, "system/skills/bash/SKILL.md"), "utf8")).toBe("Local MCP bash skill");

    const binary = await readFile(path.join(sandboxDir, "assets/logo.bin"));
    expect(Array.from(binary)).toEqual(Array.from(binaryBytes));
  });
});
