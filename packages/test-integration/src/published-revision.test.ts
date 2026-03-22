import { beforeAll, describe, expect, it } from "bun:test";
import { api } from "../../../services/backend/convex/_generated/api";
import { getSharedHarness, waitForSetup } from "./setup";
import { EXAMPLE_DIR, enqueueAndWaitForRevision, getFunctionName, internal, readFilesRecursively } from "./test-utils";

const TEST_USER_ID = "integration-test-user";

async function seedWorkspaceForPublishedRevisionTest(args: { slug: string; name: string }) {
  const backend = getSharedHarness().getBackend();
  const files = readFilesRecursively(EXAMPLE_DIR);

  const seeded = (await backend.runFunction(getFunctionName(internal.seed.seedWorkspace), {
    slug: args.slug,
    name: args.name,
    files,
  })) as { workspaceId: string };

  await getSharedHarness().assignSharedExecutorToWorkspace(seeded.workspaceId);

  const branch = (await backend.runFunction(getFunctionName(internal.vcs.getDefaultBranchInternal), {
    workspaceId: seeded.workspaceId,
  })) as { _id: string; commitId: string } | null;

  if (!branch) {
    throw new Error("Default branch not found after seeding workspace");
  }

  return {
    workspaceId: seeded.workspaceId,
    branchId: branch._id,
    commitId: branch.commitId,
  };
}

describe("Published revision routing", () => {
  let publishedWorkspace: { workspaceId: string; branchId: string; revisionId: string };

  beforeAll(async () => {
    await waitForSetup();
    const backend = getSharedHarness().getBackend();
    const workspace = await seedWorkspaceForPublishedRevisionTest({
      slug: "testing-published-revision",
      name: "Testing Published Revision",
    });
    const revisionId = await enqueueAndWaitForRevision(backend, {
      workspaceId: workspace.workspaceId,
      branchId: workspace.branchId,
      includeWorkingState: false,
    });

    await backend.runFunction(getFunctionName(internal.workspace.setActiveRevisionInternal), {
      workspaceId: workspace.workspaceId,
      revisionId,
    });

    publishedWorkspace = {
      workspaceId: workspace.workspaceId,
      branchId: workspace.branchId,
      revisionId,
    };
  });

  it("publishes the compiled revision for the seeded workspace", async () => {
    const backend = getSharedHarness().getBackend();

    const workspace = (await backend.runFunction(getFunctionName(internal.seed.getWorkspaceBySlugInternal), {
      slug: "testing-published-revision",
    })) as { _id: string; activeRevisionId?: string } | null;

    expect(workspace?._id).toBe(publishedWorkspace.workspaceId);
    expect(workspace?.activeRevisionId).toBe(publishedWorkspace.revisionId);

    const revision = (await backend.runFunction(getFunctionName(api.fs.revision.getRevision), {
      workspaceId: publishedWorkspace.workspaceId,
    })) as { _id: string; workspaceId: string } | null;

    expect(revision?._id).toBe(publishedWorkspace.revisionId);
    expect(revision?.workspaceId).toBe(publishedWorkspace.workspaceId);
  });

  it("keeps the default published revision pinned after the branch head advances", async () => {
    const backend = getSharedHarness().getBackend();
    const publishedRevisionId = publishedWorkspace.revisionId;

    await backend.runFunction(getFunctionName(internal.fs.working.write), {
      workspaceId: publishedWorkspace.workspaceId,
      branchId: publishedWorkspace.branchId,
      userId: TEST_USER_ID,
      path: "src/published-revision-test.ts",
      content: `export const publishedRevisionCutover = "branch-head-advance";\n`,
    });

    const nextCommitId = (await backend.runFunction(getFunctionName(internal.vcs.createCommitInternal), {
      workspaceId: publishedWorkspace.workspaceId,
      branchId: publishedWorkspace.branchId,
      userId: TEST_USER_ID,
      message: "Advance branch head for published revision test",
    })) as string;

    const nextRevisionId = await enqueueAndWaitForRevision(backend, {
      workspaceId: publishedWorkspace.workspaceId,
      branchId: publishedWorkspace.branchId,
      includeWorkingState: false,
      userId: TEST_USER_ID,
    });

    const latestBranchRevision = (await backend.runFunction(
      getFunctionName(api.fs.revision.getRevisionByBranchCommit),
      {
        branchId: publishedWorkspace.branchId,
        commitId: nextCommitId,
      },
    )) as { _id: string } | null;

    expect(latestBranchRevision?._id).toBe(nextRevisionId);
    expect(nextRevisionId).not.toBe(publishedRevisionId);

    const publishedRevision = (await backend.runFunction(getFunctionName(api.fs.revision.getRevision), {
      workspaceId: publishedWorkspace.workspaceId,
    })) as { _id: string } | null;

    expect(publishedRevision?._id).toBe(publishedRevisionId);
  });

  it("returns no default runtime revision until a revision is published", async () => {
    const backend = getSharedHarness().getBackend();
    const workspace = await seedWorkspaceForPublishedRevisionTest({
      slug: "testing-unpublished-revision",
      name: "Testing Unpublished Revision",
    });

    const revisionId = await enqueueAndWaitForRevision(backend, {
      workspaceId: workspace.workspaceId,
      branchId: workspace.branchId,
      includeWorkingState: false,
    });

    expect(revisionId).toBeDefined();

    const publishedRevision = (await backend.runFunction(getFunctionName(api.fs.revision.getRevision), {
      workspaceId: workspace.workspaceId,
    })) as { _id: string } | null;

    expect(publishedRevision).toBeNull();
  });

  it("rejects publishing a revision from another workspace", async () => {
    const backend = getSharedHarness().getBackend();
    const otherWorkspace = await seedWorkspaceForPublishedRevisionTest({
      slug: "testing-foreign-revision",
      name: "Testing Foreign Revision",
    });

    const foreignRevisionId = await enqueueAndWaitForRevision(backend, {
      workspaceId: otherWorkspace.workspaceId,
      branchId: otherWorkspace.branchId,
      includeWorkingState: false,
    });

    await expect(
      backend.runFunction(getFunctionName(internal.workspace.setActiveRevisionInternal), {
        workspaceId: publishedWorkspace.workspaceId,
        revisionId: foreignRevisionId,
      }),
    ).rejects.toThrow("Revision does not belong to this workspace");
  });
});
