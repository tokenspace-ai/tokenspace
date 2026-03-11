import { beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";
import { getSharedHarness, waitForSetup } from "./setup";
import { enqueueAndWaitForRevision, getFunctionName, internal, readFilesRecursively } from "./test-utils";

const REPO_ROOT = path.join(import.meta.dir, "../../..");

async function seedWorkspaceFromDir(
  slug: string,
  name: string,
  workspaceDir: string,
): Promise<{ workspaceId: string; branchId: string }> {
  const backend = getSharedHarness().getBackend();
  const exists = (await backend.runFunction(getFunctionName(internal.seed.workspaceExists), {
    slug,
  })) as boolean;

  if (exists) {
    await backend.runFunction(getFunctionName(internal.seed.deleteWorkspace), { slug });
  }

  const files = readFilesRecursively(workspaceDir);
  const seeded = (await backend.runFunction(getFunctionName(internal.seed.seedWorkspace), {
    slug,
    name,
    files,
  })) as { workspaceId: string };

  const branch = (await backend.runFunction(getFunctionName(internal.vcs.getDefaultBranchInternal), {
    workspaceId: seeded.workspaceId,
  })) as { _id: string };

  return {
    workspaceId: seeded.workspaceId,
    branchId: branch._id,
  };
}

describe("Executor-backed revision compilation", () => {
  beforeAll(async () => {
    await waitForSetup();
  });

  it("compiles examples/testing via executor and dedupes", async () => {
    const backend = getSharedHarness().getBackend();
    const workspaceCases = [
      {
        slug: "executor-compile-testing",
        name: "Executor Compile Testing",
        dir: path.join(REPO_ROOT, "examples/testing"),
      },
      // {
      //   slug: "executor-compile-siftd",
      //   name: "Executor Compile Siftd",
      //   dir: path.join(REPO_ROOT, "examples/siftd"),
      // },
    ];

    for (const workspaceCase of workspaceCases) {
      const seeded = await seedWorkspaceFromDir(workspaceCase.slug, workspaceCase.name, workspaceCase.dir);

      const revisionId = await enqueueAndWaitForRevision(backend, {
        workspaceId: seeded.workspaceId,
        branchId: seeded.branchId,
        includeWorkingState: false,
      });

      const revisionIdAgain = await enqueueAndWaitForRevision(backend, {
        workspaceId: seeded.workspaceId,
        branchId: seeded.branchId,
        includeWorkingState: false,
      });

      expect(revisionIdAgain).toBe(revisionId);

      const revision = (await backend.runFunction(getFunctionName(internal.revisions.getRevision), {
        revisionId,
      })) as {
        compileMode?: string;
        diagnosticsStorageId?: string;
        manifestStorageId?: string;
        compilerVersion?: string;
      };

      expect(revision.compileMode).toBe("server");
      expect(revision.diagnosticsStorageId).toBeDefined();
      expect(revision.manifestStorageId).toBeDefined();
      expect(revision.compilerVersion).toBeDefined();

      const buildDetails = (await backend.runFunction(
        getFunctionName(internal.compile.getRevisionBuildDetailsInternal),
        {
          workspaceId: seeded.workspaceId,
          revisionId,
        },
      )) as {
        manifest?: { schemaVersion: number };
        diagnostics?: { timingsMs: Record<string, number> };
      };
      expect(buildDetails.manifest?.schemaVersion).toBeGreaterThan(0);
      expect(buildDetails.diagnostics).toBeDefined();
      expect(Object.keys(buildDetails.diagnostics?.timingsMs ?? {})).not.toHaveLength(0);
    }
  }, 240000);

  it("compiles includeWorkingState revisions via executor", async () => {
    const backend = getSharedHarness().getBackend();
    const seeded = await seedWorkspaceFromDir(
      "executor-compile-working-state",
      "Executor Compile Working State",
      path.join(REPO_ROOT, "examples/testing"),
    );
    const userId = "integration-working-user";

    await backend.runFunction(getFunctionName(internal.fs.working.write), {
      workspaceId: seeded.workspaceId,
      branchId: seeded.branchId,
      userId,
      path: "TOKENSPACE.md",
      content: "# Working State Override\n\nThis content comes from working state.\n",
    });

    const revisionId = await enqueueAndWaitForRevision(backend, {
      workspaceId: seeded.workspaceId,
      branchId: seeded.branchId,
      includeWorkingState: true,
      userId,
    });

    const revision = (await backend.runFunction(getFunctionName(internal.revisions.getRevision), {
      revisionId,
    })) as {
      compileMode?: string;
      workingStateHash?: string;
    };
    expect(revision.compileMode).toBe("server");
    expect(revision.workingStateHash).toBeDefined();

    const revisionFs = (await backend.runFunction(getFunctionName(internal.compile.getRevisionFsFromRevision), {
      revisionId,
    })) as {
      files: Array<{ path: string; content: string; binary?: boolean }>;
    };

    const tokenSpaceFile = revisionFs.files.find((file) => file.path === "TOKENSPACE.md");
    expect(tokenSpaceFile).toBeDefined();
    expect(tokenSpaceFile?.content).toContain("Working State Override");
  }, 180000);

  it("enqueues compile job and allows watching status until completion", async () => {
    const backend = getSharedHarness().getBackend();
    const seeded = await seedWorkspaceFromDir(
      "executor-compile-watch",
      "Executor Compile Watch",
      path.join(REPO_ROOT, "examples/testing"),
    );

    const queued = (await backend.runFunction(getFunctionName(internal.compile.enqueueBranchCompile), {
      workspaceId: seeded.workspaceId,
      branchId: seeded.branchId,
      includeWorkingState: false,
      checkExistingRevision: false,
    })) as { compileJobId?: string };

    expect(queued.compileJobId).toBeDefined();
    const compileJobId = queued.compileJobId!;

    const startedAt = Date.now();
    let completedJob: {
      status: string;
      revisionId?: string;
    } | null = null;

    while (Date.now() - startedAt < 120_000) {
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
        completedJob = job;
        break;
      }
      if (job.status === "failed" || job.status === "canceled") {
        throw new Error(job.error?.message ?? `Compile job ended with status ${job.status}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }

    expect(completedJob).toBeDefined();
    expect(completedJob?.status).toBe("completed");
    expect(completedJob?.revisionId).toBeDefined();
  }, 180000);
});
