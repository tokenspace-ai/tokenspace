import { describe, expect, it } from "bun:test";
import {
  generateInstructions,
  generateRunCodeDescription,
  generateSystemInstructionsPrompt,
  generateWorkspaceOverview,
} from "./instructions";
import type { LocalSession } from "./types";

function makeSession(tokenspaceMd?: string): LocalSession {
  return {
    manifest: {
      version: 2,
      sessionId: "session-1",
      createdAt: new Date(0).toISOString(),
      workspaceName: "Testing",
      workspaceDir: "/workspace",
      sessionRoot: "/session",
      buildDir: "/session/build",
      sandboxDir: "/session/sandbox",
      logsDir: "/session/logs",
      bundlePath: "/session/build/bundle.mjs",
      buildManifestPath: "/session/build/manifest.json",
      sourceFingerprint: "fingerprint",
      buildOrigin: "fresh-build",
    },
    sessionRoot: "/session",
    buildDir: "/session/build",
    sandboxDir: "/session/sandbox",
    logsDir: "/session/logs",
    bundlePath: "/session/build/bundle.mjs",
    buildManifestPath: "/session/build/manifest.json",
    fileSystem: {} as LocalSession["fileSystem"],
    buildResult: {
      manifest: {} as LocalSession["buildResult"]["manifest"],
      revisionFs: {} as LocalSession["buildResult"]["revisionFs"],
      bundleCode: "",
      diagnostics: {} as LocalSession["buildResult"]["diagnostics"],
      deps: null,
      metadata: {
        capabilities: [
          {
            path: "capabilities/testing/CAPABILITY.md",
            typesPath: "capabilities/testing/capability.d.ts",
            name: "Testing",
            description: "Exercise the local MCP sandbox",
          },
        ],
        skills: [
          {
            path: "skills/release/SKILL.md",
            name: "Release",
            description: "Release guidance",
          },
        ],
        tokenspaceMd,
        credentialRequirements: [],
        models: [],
      },
    },
  };
}

describe("generateInstructions", () => {
  it("appends TOKENSPACE.md content when present", async () => {
    const instructions = await generateInstructions(
      makeSession("# Workspace Instructions\n\nUse the testing capability first.\n"),
    );

    expect(instructions).toContain("# Workspace Instructions");
    expect(instructions).toContain("Use the testing capability first.");
    expect(instructions).toContain("<workspace_instructions>");
  });

  it("omits the workspace instructions section when TOKENSPACE.md is absent", async () => {
    const instructions = await generateInstructions(makeSession());

    expect(instructions).not.toContain("<workspace_instructions>");
    expect(instructions).not.toContain("The workspace includes additional instructions in `TOKENSPACE.md`.");
  });

  it("generates a runCode description with capabilities, sandbox, and skills guidance", async () => {
    const description = await generateRunCodeDescription(makeSession());

    expect(description).toContain("Available capability namespaces:");
    expect(description).toContain("Available capabilities:\n- testing: Exercise the local MCP sandbox");
    expect(description).toContain("testing: Exercise the local MCP sandbox");
    expect(description).toContain("/sandbox");
    expect(description).toContain("Release (skills/release/SKILL.md)");
    expect(description).toContain("system-instructions");
  });

  it("generates a system-instructions prompt body with filesystem and skill guidance", async () => {
    const promptText = await generateSystemInstructionsPrompt(makeSession());

    expect(promptText).toContain("# Tokenspace System Instructions");
    expect(promptText).toContain("The runtime filesystem is virtual and rooted at `/sandbox`.");
    expect(promptText).toContain("- Release: Release guidance (skills/release/SKILL.md)");
    expect(promptText).toContain("- bash: Use Tokenspace's sandboxed bash environment");
  });

  it("generates a workspace overview with capabilities, filesystem, and skills", async () => {
    const overview = await generateWorkspaceOverview(makeSession());

    expect(overview).toContain("# Tokenspace Workspace Overview");
    expect(overview).toContain("- testing: Exercise the local MCP sandbox (capabilities/testing/CAPABILITY.md)");
    expect(overview).toContain("All file access is scoped to the virtual filesystem at `/sandbox`.");
    expect(overview).toContain("- Release: Release guidance (skills/release/SKILL.md)");
    expect(overview).toContain("If the client did not load MCP server instructions automatically");
  });
});
