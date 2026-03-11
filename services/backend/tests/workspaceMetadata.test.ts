import { describe, expect, it } from "bun:test";
import { extractPromptMetadataFromEntries, parseWorkspaceModelsYaml } from "../convex/workspaceMetadata";

describe("extractPromptMetadataFromEntries", () => {
  it("extracts capability and skill metadata from markdown frontmatter", () => {
    const result = extractPromptMetadataFromEntries([
      {
        path: "capabilities/github/CAPABILITY.md",
        content: `---
name: GitHub
description: Interact with GitHub resources
---
# GitHub
`,
      },
      {
        path: "skills/release/SKILL.md",
        content: `---
name: Release checklist
description: Steps for release readiness
---
# Skill
`,
      },
      {
        path: "docs/README.md",
        content: "# ignored",
      },
    ]);

    expect(result.capabilities).toEqual([
      {
        path: "capabilities/github/CAPABILITY.md",
        typesPath: "capabilities/github/capability.d.ts",
        name: "GitHub",
        description: "Interact with GitHub resources",
      },
    ]);
    expect(result.skills).toEqual([
      {
        path: "skills/release/SKILL.md",
        name: "Release checklist",
        description: "Steps for release readiness",
      },
    ]);
  });
});

describe("parseWorkspaceModelsYaml", () => {
  it("parses model definitions from src/models.yaml", () => {
    const result = parseWorkspaceModelsYaml(`
models:
  - modelId: anthropic/claude-haiku-4.5
    isDefault: true
  - modelId: anthropic/claude-opus-4.6
    isDefault: false
`);

    expect(result).toHaveLength(2);
    expect(result.find((entry) => entry.isDefault)?.modelId).toBe("anthropic/claude-haiku-4.5");
  });
});
