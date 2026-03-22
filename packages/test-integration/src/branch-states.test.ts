import { beforeAll, describe, expect, it } from "bun:test";
import { internal } from "../../../services/backend/convex/_generated/api";
import { computeWorkingStateHash } from "../../../services/backend/convex/workingStateHash";
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
  mainBranchStateId: string;
  path: string;
  content: string;
}): Promise<BranchState> {
  const backend = getSharedHarness().getBackend();
  const result = (await backend.runFunction(getFunctionName(internal.branchStates.saveFileInternal), {
    branchStateId: args.mainBranchStateId,
    path: args.path,
    content: args.content,
    createdByUserId: TEST_USER_ID,
  })) as { branchStateId: string };

  const draft = await getBranchState(result.branchStateId);
  if (!draft) {
    throw new Error("Draft branch state not found after save");
  }
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
  });

  it("auto-creates a shared draft branch state for main mutations and stores drafts under the branch-state owner key", async () => {
    const backend = getSharedHarness().getBackend();
    const workspace = await seedWorkspace({
      slug: "testing-branch-states-draft",
      name: "Testing Branch States Draft",
    });

    const [mainBranchState] = await initializeBranchStates(workspace.workspaceId);
    const draft = await createDraftAndWriteFile({
      mainBranchStateId: mainBranchState!._id,
      path: "src/branch-state-draft.ts",
      content: 'export const branchStateDraft = "shared";\n',
    });

    expect(draft._id).not.toBe(mainBranchState?._id);
    expect(draft.name).toStartWith("draft-");
    expect(draft.isMain).toBe(false);
    expect(draft.backingBranchId).not.toBe(mainBranchState?.backingBranchId);

    const sharedWorkingFile = (await backend.runFunction(getFunctionName(internal.fs.working.readForBranchState), {
      branchStateId: draft._id,
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
      mainBranchStateId: mainBranchState!._id,
      path: "src/branch-state-commit.ts",
      content: 'export const branchStateCommit = "ready";\n',
    });

    const branchBefore = (await backend.runFunction(getFunctionName(internal.vcs.getBranchInternal), {
      branchId: draft.backingBranchId,
    })) as { commitId: string } | null;

    const committed = (await backend.runFunction(getFunctionName(internal.branchStates.createCommitInternal), {
      branchStateId: draft._id,
      authorId: TEST_USER_ID,
      message: "Commit shared branch-state draft",
    })) as { commitId: string };

    const branchAfter = (await backend.runFunction(getFunctionName(internal.vcs.getBranchInternal), {
      branchId: draft.backingBranchId,
    })) as { commitId: string } | null;
    const clearedWorkingFile = (await backend.runFunction(getFunctionName(internal.fs.working.readForBranchState), {
      branchStateId: draft._id,
      path: "src/branch-state-commit.ts",
    })) as { path: string } | null;

    expect(branchAfter?.commitId).toBe(committed.commitId);
    expect(branchAfter?.commitId).not.toBe(branchBefore?.commitId);
    expect(clearedWorkingFile).toBeNull();
  });

  it("compiles a branch state with branch-state source identity and records the last compiled revision", async () => {
    const backend = getSharedHarness().getBackend();
    const workspace = await seedWorkspace({
      slug: "testing-branch-states-compile",
      name: "Testing Branch States Compile",
    });

    const [mainBranchState] = await initializeBranchStates(workspace.workspaceId);
    const draft = await createDraftAndWriteFile({
      mainBranchStateId: mainBranchState!._id,
      path: "src/branch-state-compile.ts",
      content: 'export const branchStateCompile = "draft";\n',
    });

    const queued = (await backend.runFunction(getFunctionName(internal.branchStates.compileInternal), {
      branchStateId: draft._id,
    })) as { compileJobId?: string };

    expect(queued.compileJobId).toBeDefined();
    const revisionId = await waitForCompileJob(queued.compileJobId!);
    const updatedDraft = await getBranchState(draft._id);
    const revision = (await backend.runFunction(getFunctionName(internal.revisions.getRevision), {
      revisionId,
    })) as { _id: string; branchStateId?: string; sourceSnapshotHash?: string } | null;
    const branch = (await backend.runFunction(getFunctionName(internal.vcs.getBranchInternal), {
      branchId: draft.backingBranchId,
    })) as { commitId: string } | null;
    const workingChanges = (await backend.runFunction(getFunctionName(internal.fs.working.getChangesForBranchState), {
      branchStateId: draft._id,
    })) as Array<{
      path: string;
      content?: string;
      isDeleted: boolean;
    }>;
    const sourceSnapshotHash = computeWorkingStateHash(workingChanges);
    const branchStateRevision = (await backend.runFunction(getFunctionName(internal.revisions.findRevision), {
      branchId: draft.backingBranchId,
      branchStateId: draft._id,
      commitId: branch!.commitId,
      sourceSnapshotHash,
    })) as { _id: string } | null;
    const legacyRevision = (await backend.runFunction(getFunctionName(internal.revisions.findRevision), {
      branchId: draft.backingBranchId,
      commitId: branch!.commitId,
      workingStateHash: sourceSnapshotHash,
    })) as { _id: string } | null;
    const deduped = (await backend.runFunction(getFunctionName(internal.compile.enqueueBranchCompile), {
      workspaceId: workspace.workspaceId,
      branchId: draft.backingBranchId,
      source: {
        kind: "branchState",
        branchStateId: draft._id,
      },
      checkExistingRevision: true,
    })) as { existingRevisionId?: string; compileJobId?: string };

    expect(updatedDraft?.lastCompiledRevisionId).toBe(revisionId);
    expect(revision?.branchStateId).toBe(draft._id);
    expect(revision?.sourceSnapshotHash).toBe(sourceSnapshotHash);
    expect(branchStateRevision?._id).toBe(revisionId);
    expect(legacyRevision).toBeNull();
    expect(deduped.existingRevisionId).toBe(revisionId);
    expect(deduped.compileJobId).toBeUndefined();
  });

  it("merges a draft branch state into main through the branch-state API", async () => {
    const backend = getSharedHarness().getBackend();
    const workspace = await seedWorkspace({
      slug: "testing-branch-states-merge",
      name: "Testing Branch States Merge",
    });

    const [mainBranchState] = await initializeBranchStates(workspace.workspaceId);
    const draft = await createDraftAndWriteFile({
      mainBranchStateId: mainBranchState!._id,
      path: "src/branch-state-merge.ts",
      content: 'export const branchStateMerge = "merged";\n',
    });

    await backend.runFunction(getFunctionName(internal.branchStates.createCommitInternal), {
      branchStateId: draft._id,
      authorId: TEST_USER_ID,
      message: "Commit branch-state merge change",
    });
    const queued = (await backend.runFunction(getFunctionName(internal.branchStates.compileInternal), {
      branchStateId: draft._id,
    })) as { compileJobId: string };
    await waitForCompileJob(queued.compileJobId);

    const mergeResult = (await backend.runFunction(getFunctionName(internal.branchStates.mergeIntoMainInternal), {
      branchStateId: draft._id,
      authorId: TEST_USER_ID,
    })) as { type: "fast-forward" | "merge-commit"; commitId: string };
    const refreshedMain = await getBranchState(mainBranchState!._id);
    const refreshedDraft = await getBranchState(draft._id);
    const mainBranch = (await backend.runFunction(getFunctionName(internal.vcs.getBranchInternal), {
      branchId: mainBranchState!.backingBranchId,
    })) as { commitId: string } | null;
    const mergedCommit = (await backend.runFunction(getFunctionName(internal.vcs.getCommitInternal), {
      commitId: mainBranch!.commitId,
    })) as { treeId: string } | null;
    const mergedFiles = (await backend.runFunction(getFunctionName(internal.trees.getAllFiles), {
      treeId: mergedCommit!.treeId,
    })) as Array<{ path: string; content?: string }>;
    const mergedFile = mergedFiles.find((file) => file.path === "src/branch-state-merge.ts");

    expect(mergeResult.commitId).toBe(mainBranch?.commitId);
    expect(mergeResult.type === "fast-forward" || mergeResult.type === "merge-commit").toBe(true);
    expect(refreshedMain?.lastCompiledRevisionId).toBeUndefined();
    expect(refreshedDraft?.lastCompiledRevisionId).toBeUndefined();
    expect(mergedFile?.content).toContain('branchStateMerge = "merged"');
  });

  it("deletes a non-main branch state and its backing branch", async () => {
    const backend = getSharedHarness().getBackend();
    const workspace = await seedWorkspace({
      slug: "testing-branch-states-delete",
      name: "Testing Branch States Delete",
    });

    const [mainBranchState] = await initializeBranchStates(workspace.workspaceId);
    const draft = await createDraftAndWriteFile({
      mainBranchStateId: mainBranchState!._id,
      path: "src/branch-state-delete.ts",
      content: 'export const branchStateDelete = "gone";\n',
    });

    const deleted = (await backend.runFunction(getFunctionName(internal.branchStates.deleteBranchStateInternal), {
      branchStateId: draft._id,
    })) as { deleted: boolean };
    const deletedBranchState = await getBranchState(draft._id);
    const deletedBackingBranch = (await backend.runFunction(getFunctionName(internal.vcs.getBranchInternal), {
      branchId: draft.backingBranchId,
    })) as { _id: string } | null;

    expect(deleted.deleted).toBe(true);
    expect(deletedBranchState).toBeNull();
    expect(deletedBackingBranch).toBeNull();
  });
});
