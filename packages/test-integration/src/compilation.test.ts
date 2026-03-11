/**
 * Integration tests for workspace compilation.
 *
 * Tests the ability to:
 * - Compile a workspace successfully
 * - Create revisions with revision filesystem artifacts
 * - Generate compiled declaration files
 * - Compile code with tool calls
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { getSharedContext, getSharedHarness, waitForSetup } from "./setup";
import { api, getFunctionName, internal, type TestContext } from "./test-utils";

describe("Workspace Compilation", () => {
  let context: TestContext;

  beforeAll(async () => {
    await waitForSetup();
    context = getSharedContext();
  });

  it("compiles the workspace successfully", async () => {
    // Context already has revisionId from seedWorkspace which calls compileDefaultBranch
    expect(context.revisionId).toBeDefined();
  });

  it("creates a revision with revision filesystem artifacts", async () => {
    const backend = getSharedHarness().getBackend();

    const branch = (await backend.runFunction(getFunctionName(internal.vcs.getDefaultBranchInternal), {
      workspaceId: context.workspaceId,
    })) as { _id: string; commitId: string };

    const revision = (await backend.runFunction(getFunctionName(api.fs.revision.getRevisionByBranchCommit), {
      branchId: branch._id,
      commitId: branch.commitId,
    })) as {
      _id: string;
      workspaceId: string;
      branchId: string;
      revisionFsStorageId: string;
      bundleStorageId: string;
    } | null;

    expect(revision).toBeDefined();
    expect(revision?.workspaceId).toBe(context.workspaceId);
    expect(revision?.branchId).toBe(context.branchId);
    expect(revision?.revisionFsStorageId).toBeDefined();
    expect(revision?.bundleStorageId).toBeDefined();
  });

  it("has compiled declaration files", async () => {
    const backend = getSharedHarness().getBackend();

    const files = (await backend.runFunction(getFunctionName(internal.fs.revision.list), {
      revisionId: context.revisionId,
    })) as string[];

    expect(files).toBeDefined();
    expect(files.length).toBeGreaterThan(0);

    // Should have .d.ts files in capabilities/
    const declarationFiles = files.filter((f) => f.endsWith(".d.ts"));
    expect(declarationFiles.length).toBeGreaterThan(0);

    // Should have capability declarations
    const capabilityDeclarations = declarationFiles.filter((f) => f.startsWith("capabilities/"));
    expect(capabilityDeclarations.length).toBeGreaterThan(0);

    // Should have builtins.d.ts
    expect(files).toContain("builtins.d.ts");
  });

  it("compiles testing capability call", async () => {
    const backend = getSharedHarness().getBackend();

    const compileResult = (await backend.runFunction(getFunctionName(internal.fs.operations.compileCode), {
      revisionId: context.revisionId,
      code: `
const res = await testing.testConnection({});
console.log(res);
`,
    })) as { success: boolean; code?: string; error?: string };

    expect(compileResult.success).toBe(true);
    expect(compileResult.code).toBeDefined();
    expect(compileResult.error).toBeUndefined();
  });
});
