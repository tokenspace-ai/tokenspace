/**
 * Integration tests for workspace seeding.
 *
 * Tests the ability to:
 * - Seed a workspace from the testing example workspace
 * - Retrieve the seeded workspace
 * - Verify the default branch exists
 *
 * Note: This test uses the shared harness but tests workspace operations
 * that may create additional workspaces beyond the shared one.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { getSharedContext, getSharedHarness, waitForSetup } from "./setup";
import {
  EXAMPLE_DIR,
  getFunctionName,
  internal,
  readFilesRecursively,
  type TestContext,
  WORKSPACE_NAME,
  WORKSPACE_SLUG,
} from "./test-utils";

describe("Workspace Seeding", () => {
  let context: TestContext;

  beforeAll(async () => {
    await waitForSetup();
    context = getSharedContext();
  });

  it("seeds a workspace from the testing example workspace", async () => {
    // The shared setup already seeded the workspace, verify it exists
    expect(context.workspaceId).toBeDefined();
  });

  it("can retrieve the seeded workspace", async () => {
    const backend = getSharedHarness().getBackend();

    const workspace = (await backend.runFunction(getFunctionName(internal.seed.getWorkspaceBySlugInternal), {
      slug: WORKSPACE_SLUG,
    })) as { _id: string; name: string; slug: string } | null;

    expect(workspace).toBeDefined();
    expect(workspace?.name).toBe(WORKSPACE_NAME);
    expect(workspace?.slug).toBe(WORKSPACE_SLUG);
  });

  it("has a default branch", async () => {
    const backend = getSharedHarness().getBackend();

    const branch = (await backend.runFunction(getFunctionName(internal.vcs.getDefaultBranchInternal), {
      workspaceId: context.workspaceId,
    })) as { _id: string; name: string; isDefault: boolean } | null;

    expect(branch).toBeDefined();
    expect(branch?.name).toBe("main");
    expect(branch?.isDefault).toBe(true);
  });

  it("reads files from testing workspace directory correctly", () => {
    const files = readFilesRecursively(EXAMPLE_DIR);
    expect(files.length).toBeGreaterThan(0);

    // Should have capability files
    const capabilityFiles = files.filter((f) => f.path.includes("capabilities/"));
    expect(capabilityFiles.length).toBeGreaterThan(0);
  });
});
