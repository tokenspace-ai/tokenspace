import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

let workspaceBySlug: Record<string, any>;
let workspaces: any[];
let selectedDefaultWorkspaceSlug: string | null;
let promptSelectCalls: Array<{ question: string; options: Array<{ label: string; value: string }> }>;
let promptSelectValue: string;

const originalConsoleLog = console.log;
const logMock = mock((..._args: unknown[]) => {});

mock.module("../client.js", () => ({
  exitWithError: (message: string): never => {
    throw new Error(`EXIT:${message}`);
  },
  getWorkspaceBySlug: async (slug: string) => workspaceBySlug[slug] ?? null,
  listWorkspaces: async () => workspaces,
}));

mock.module("../auth.js", () => ({
  getDefaultWorkspaceSlug: () => selectedDefaultWorkspaceSlug,
  setDefaultWorkspaceSlug: (workspaceSlug: string) => {
    selectedDefaultWorkspaceSlug = workspaceSlug;
  },
}));

mock.module("../prompts.js", () => ({
  prompt: async () => {
    throw new Error("prompt should not be called in use workspace tests");
  },
  confirm: async () => {
    throw new Error("confirm should not be called in use workspace tests");
  },
  promptSecret: async () => {
    throw new Error("promptSecret should not be called in use workspace tests");
  },
  promptSelect: async (question: string, options: Array<{ label: string; value: string }>) => {
    promptSelectCalls.push({ question, options });
    return promptSelectValue;
  },
}));

const { useWorkspace } = await import("./use");

beforeEach(() => {
  workspaceBySlug = {
    alpha: { _id: "ws_alpha", slug: "alpha", name: "Alpha" },
    beta: { _id: "ws_beta", slug: "beta", name: "Beta" },
  };
  workspaces = [workspaceBySlug.beta, workspaceBySlug.alpha];
  selectedDefaultWorkspaceSlug = null;
  promptSelectCalls = [];
  promptSelectValue = "beta";
  logMock.mockClear();
  console.log = logMock as typeof console.log;
});

afterEach(() => {
  console.log = originalConsoleLog;
});

describe("use workspace", () => {
  it("sets the default workspace from an explicit slug", async () => {
    await useWorkspace("alpha");

    expect(selectedDefaultWorkspaceSlug).toBe("alpha");
  });

  it("shows an interactive picker when no slug is provided", async () => {
    selectedDefaultWorkspaceSlug = "alpha";

    await useWorkspace();

    expect(promptSelectCalls).toHaveLength(1);
    expect(promptSelectCalls[0]?.options.map((option) => option.value)).toEqual(["alpha", "beta"]);
    expect(promptSelectCalls[0]?.options[0]?.label).toContain("[current default]");
    expect(selectedDefaultWorkspaceSlug).toBe("beta");
  });

  it("fails when the selected workspace does not exist", async () => {
    await expect(useWorkspace("missing")).rejects.toThrow("EXIT:Tokenspace 'missing' not found");
  });
});
