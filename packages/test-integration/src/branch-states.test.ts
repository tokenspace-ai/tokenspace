import { beforeAll, describe, expect, it } from "bun:test";
import { internal } from "../../../services/backend/convex/_generated/api";
import { getSharedHarness, waitForSetup } from "./setup";
import { EXAMPLE_DIR, getFunctionName, readFilesRecursively } from "./test-utils";

const TEST_USER_ID = "branch-state-test-user";

type SeededWorkspace = {
  workspaceId: string;
  branchId: string;
  commitId: string;
};

type BranchState = {
  _id: string;
  name: string;
  isMain: boolean;
  backingBranchId: string;
  workingOwnerKey: string;
  lastCompiledRevisionId?: string;
};

async function seedWorkspace(args: { slug: string; name: string }): Promise<SeededWorkspace> {
  const backend = getSharedHarness().getBackend();

  const exists = (await backend.runFunction(getFunctionName(internal.seed.workspaceExists), {
    slug: args.slug,
  })) as boolean;
  if (exists) {
    await backend.runFunction(getFunctionName(internal.seed.deleteWorkspace), {
      slug: args.slug,
    });
  }

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

async function initializeBranchStates(workspaceId: string): Promise<BranchState[]> {
  const backend = getSharedHarness().getBackend();
  return (await backend.runFunction(getFunctionName(internal.branchStates.ensureInitializedInternal), {
    workspaceId,
    createdByUserId: TEST_USER_ID,
  })) as BranchState[];
}

async function getBranchState(branchStateId: string): Promise<BranchState | null> {
  const backend = getSharedHarness().getBackend();
  return (await backend.runFunction(getFunctionName(internal.branchStates.getInternal), {
    branchStateId,
  })) as BranchState | null;
}

async function createDraftAndWriteFile(args: {
  workspaceId: string;
  mainBranchStateId: string;
  path: string;
  content: string;
}): Promise<BranchState> {
  const backend = getSharedHarness().getBackend();
  const draft = (await backend.runFunction(getFunctionName(internal.branchStates.ensureWritableBranchStateInternal), {
    branchStateId: args.mainBranchStateId,
    createdByUserId: TEST_USER_ID,
  })) as BranchState;

  await backend.runFunction(getFunctionName(internal.fs.working.write), {
    workspaceId: args.workspaceId,
    branchId: draft.backingBranchId,
    userId: draft.workingOwnerKey,
    path: args.path,
    content: args.content,
  });

  await backend.runFunction(getFunctionName(internal.branchStates.touchBranchStateInternal), {
    branchStateId: draft._id,
    clearLastCompiledRevisionId: true,
  });

  return draft;
}

async function waitForCompileJob(compileJobId: string, timeoutMs = 120_000): Promise<string> {
  const backend = getSharedHarness().getBackend();
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const job = (await backend.runFunction(getFunctionName(internal.compileJobs.getCompileJob), {
      compileJobId,
    })) as {
      status: "pending" | "running" | "completed" | "failed" | "canceled";
      revisionId?: string;
      error?: { message?: string };
    } | null;

    if (!job) {
      throw new Error("Compile job not found");
    }
    if (job.status === "completed") {
      if (!job.revisionId) {
        throw new Error("Compile job completed without revision");
      }
      return job.revisionId;
    }
    if (job.status === "failed" || job.status === "canceled") {
      throw new Error(job.error?.message ?? `Compile job ended with status ${job.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Compile job timed out after ${timeoutMs}ms`);
}

describe("Branch states", () => {
  beforeAll(async () => {
    await waitForSetup();
  });

  it("creates a main branch state for the seeded workspace", async () => {
    const workspace = await seedWorkspace({
      slug: "testing-branch-states-main",
      name: "Testing Branch States Main",
    });

    const branchStates = await initializeBranchStates(workspace.workspaceId);

    expect(branchStates).toHaveLength(1);
    expect(branchStates[0]?.name).toBe("main");
    expect(branchStates[0]?.isMain).toBe(true);
    expect(branchStates[0]?.backingBranchId).toBe(workspace.branchId);
    expect(branchStates[0]?.workingOwnerKey).toBe(`branch-state:${workspace.branchId}`);
  });

  it("auto-creates a shared draft branch state for main mutations and stores drafts under the branch-state owner key", async () => {
    const backend = getSharedHarness().getBackend();
    const workspace = await seedWorkspace({
      slug: "testing-branch-states-draft",
      name: "Testing Branch States Draft",
    });

    const [mainBranchState] = await initializeBranchStates(workspace.workspaceId);
    const draft = await createDraftAndWriteFile({
      workspaceId: workspace.workspaceId,
      mainBranchStateId: mainBranchState!._id,
      path: "src/branch-state-draft.ts",
      content: 'export const branchStateDraft = "shared";\n',
    });

    expect(draft._id).not.toBe(mainBranchState?._id);
    expect(draft.name).toStartWith("draft-");
    expect(draft.isMain).toBe(false);
    expect(draft.backingBranchId).not.toBe(mainBranchState?.backingBranchId);

    const sharedWorkingFile = (await backend.runFunction(getFunctionName(internal.fs.working.read), {
      branchId: draft.backingBranchId,
      userId: draft.workingOwnerKey,
      path: "src/branch-state-draft.ts",
    })) as { path: string; content?: string; isDeleted: boolean } | null;
    expect(sharedWorkingFile?.path).toBe("src/branch-state-draft.ts");
    expect(sharedWorkingFile?.isDeleted).toBe(false);

    const userScopedWorkingFile = (await backend.runFunction(getFunctionName(internal.fs.working.read), {
      branchId: draft.backingBranchId,
      userId: TEST_USER_ID,
      path: "src/branch-state-draft.ts",
    })) as { path: string } | null;
    expect(userScopedWorkingFile).toBeNull();
  });

  it("creates commits from shared draft working files and clears the draft", async () => {
    const backend = getSharedHarness().getBackend();
    const workspace = await seedWorkspace({
      slug: "testing-branch-states-commit",
      name: "Testing Branch States Commit",
    });

    const [mainBranchState] = await initializeBranchStates(workspace.workspaceId);
    const draft = await createDraftAndWriteFile({
      workspaceId: workspace.workspaceId,
      mainBranchStateId: mainBranchState!._id,
      path: "src/branch-state-commit.ts",
      content: 'export const branchStateCommit = "ready";\n',
    });

    const branchBefore = (await backend.runFunction(getFunctionName(internal.vcs.getBranchInternal), {
      branchId: draft.backingBranchId,
    })) as { commitId: string } | null;

    const commitId = (await backend.runFunction(getFunctionName(internal.vcs.createCommitForOwnerInternal), {
      workspaceId: workspace.workspaceId,
      branchId: draft.backingBranchId,
      authorId: TEST_USER_ID,
      workingOwnerId: draft.workingOwnerKey,
      message: "Commit shared branch-state draft",
    })) as string;

    const branchAfter = (await backend.runFunction(getFunctionName(internal.vcs.getBranchInternal), {
      branchId: draft.backingBranchId,
    })) as { commitId: string } | null;
    const clearedWorkingFile = (await backend.runFunction(getFunctionName(internal.fs.working.read), {
      branchId: draft.backingBranchId,
      userId: draft.workingOwnerKey,
      path: "src/branch-state-commit.ts",
    })) as { path: string } | null;

    expect(branchAfter?.commitId).toBe(commitId);
    expect(branchAfter?.commitId).not.toBe(branchBefore?.commitId);
    expect(clearedWorkingFile).toBeNull();
  });

  it("compiles a branch state without a working-state hash and records the last compiled revision", async () => {
    const backend = getSharedHarness().getBackend();
    const workspace = await seedWorkspace({
      slug: "testing-branch-states-compile",
      name: "Testing Branch States Compile",
    });

    const [mainBranchState] = await initializeBranchStates(workspace.workspaceId);
    const draft = await createDraftAndWriteFile({
      workspaceId: workspace.workspaceId,
      mainBranchStateId: mainBranchState!._id,
      path: "src/branch-state-compile.ts",
      content: 'export const branchStateCompile = "draft";\n',
    });

    const queued = (await backend.runFunction(getFunctionName(internal.compile.enqueueBranchCompile), {
      workspaceId: workspace.workspaceId,
      branchId: draft.backingBranchId,
      branchStateId: draft._id,
      includeWorkingState: true,
      userId: draft.workingOwnerKey,
      checkExistingRevision: false,
    })) as { compileJobId?: string };

    expect(queued.compileJobId).toBeDefined();
    const revisionId = await waitForCompileJob(queued.compileJobId!);
    const updatedDraft = await getBranchState(draft._id);

    expect(updatedDraft?.lastCompiledRevisionId).toBe(revisionId);
  });
});
