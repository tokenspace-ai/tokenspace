import { describe, expect, it } from "bun:test";
import {
  assertWorkspaceExecutorAssignmentState,
  buildExecutorSummary,
  canManageExecutorLifecycle,
  cleanupStaleExecutorInstancesInternalImpl,
  createExecutorUnassignedInternalImpl,
  deleteExecutorImpl,
  deriveExecutorInstanceHealth,
  EXECUTOR_INACTIVE_INSTANCE_RETENTION_MS,
  ensureLocalDevExecutorInternalImpl,
  isExecutorInstanceHealthy,
  LOCAL_DEV_EXECUTOR_CREATED_BY,
  LOCAL_DEV_EXECUTOR_NAME,
  listManageableExecutorsInternalImpl,
  renameExecutorImpl,
  rotateExecutorBootstrapTokenImpl,
  setWorkspaceExecutorInternalImpl,
} from "../convex/executors";

process.env.WORKOS_ORG_ID ??= "org_test";
process.env.CONVEX_URL ??= "https://example.convex.cloud";

type TableName =
  | "workspaces"
  | "executors"
  | "executorInstances"
  | "jobs"
  | "compileJobs"
  | "sessionExecutorAssignments";

function createFakeCtx(
  seed?: Partial<Record<TableName, any[]>>,
  options?: {
    user?: {
      subject: string;
      org_id: string;
      role?: string | null;
    } | null;
  },
) {
  const tables: Record<TableName, any[]> = {
    workspaces: [],
    executors: [],
    executorInstances: [],
    jobs: [],
    compileJobs: [],
    sessionExecutorAssignments: [],
    ...seed,
  };
  let nextId = 0;

  const db = {
    get: async (id: string) => {
      for (const rows of Object.values(tables)) {
        const row = rows.find((entry) => entry._id === id);
        if (row) {
          return row;
        }
      }
      return null;
    },
    insert: async (table: TableName, value: Record<string, unknown>) => {
      const row = { _id: `${table}_${++nextId}`, ...value };
      tables[table].push(row);
      return row._id;
    },
    patch: async (id: string, value: Record<string, unknown>) => {
      for (const rows of Object.values(tables)) {
        const index = rows.findIndex((entry) => entry._id === id);
        if (index >= 0) {
          rows[index] = { ...rows[index], ...value };
          return;
        }
      }
    },
    delete: async (id: string) => {
      for (const rows of Object.values(tables)) {
        const index = rows.findIndex((entry) => entry._id === id);
        if (index >= 0) {
          rows.splice(index, 1);
          return;
        }
      }
    },
    query: (table: TableName) => {
      const buildAccessor = (
        filters: Array<{ field: string; op: "eq" | "lt" | "lte" | "gt" | "gte"; value: unknown }>,
      ) => {
        const applyFilters = () =>
          tables[table].filter((row) =>
            filters.every((filter) => {
              const rowValue = row[filter.field];
              switch (filter.op) {
                case "eq":
                  return rowValue === filter.value;
                case "lt":
                  return rowValue < filter.value;
                case "lte":
                  return rowValue <= filter.value;
                case "gt":
                  return rowValue > filter.value;
                case "gte":
                  return rowValue >= filter.value;
                default:
                  return false;
              }
            }),
          );
        return {
          collect: async () => applyFilters(),
          first: async () => applyFilters()[0] ?? null,
          take: async (count: number) => applyFilters().slice(0, count),
        };
      };

      return {
        collect: async () => tables[table],
        withIndex: (
          _indexName: string,
          build?: (q: {
            eq: (field: string, value: unknown) => any;
            lt: (field: string, value: unknown) => any;
            lte: (field: string, value: unknown) => any;
            gt: (field: string, value: unknown) => any;
            gte: (field: string, value: unknown) => any;
          }) => any,
        ) => {
          const filters: Array<{ field: string; op: "eq" | "lt" | "lte" | "gt" | "gte"; value: unknown }> = [];
          const builder = {
            eq(field: string, value: unknown) {
              filters.push({ field, op: "eq", value });
              return builder;
            },
            lt(field: string, value: unknown) {
              filters.push({ field, op: "lt", value });
              return builder;
            },
            lte(field: string, value: unknown) {
              filters.push({ field, op: "lte", value });
              return builder;
            },
            gt(field: string, value: unknown) {
              filters.push({ field, op: "gt", value });
              return builder;
            },
            gte(field: string, value: unknown) {
              filters.push({ field, op: "gte", value });
              return builder;
            },
          };
          build?.(builder);
          return buildAccessor(filters);
        },
      };
    },
  };

  const mutationCalls: Array<{ ref: unknown; args: unknown }> = [];
  return {
    auth: {
      getUserIdentity: async () => options?.user ?? null,
    },
    db,
    tables,
    mutationCalls,
    runMutation: async (ref: unknown, args: unknown) => {
      mutationCalls.push({ ref, args });
      return undefined;
    },
  };
}

describe("isExecutorInstanceHealthy", () => {
  it("returns true only for online instances with a non-expired lease", () => {
    expect(
      isExecutorInstanceHealthy(
        {
          status: "online",
          expiresAt: 2_000,
        },
        1_000,
      ),
    ).toBe(true);

    expect(
      isExecutorInstanceHealthy(
        {
          status: "offline",
          expiresAt: 2_000,
        },
        1_000,
      ),
    ).toBe(false);

    expect(
      isExecutorInstanceHealthy(
        {
          status: "online",
          expiresAt: 999,
        },
        1_000,
      ),
    ).toBe(false);

    expect(
      isExecutorInstanceHealthy(
        {
          status: "online",
          expiresAt: 1_000,
        },
        1_000,
      ),
    ).toBe(true);
  });
});

describe("assertWorkspaceExecutorAssignmentState", () => {
  const executorId = "executor_123" as any;
  const workspace = {
    _id: "workspace_123" as any,
    executorId,
  };
  const executor = {
    _id: executorId,
    status: "active" as const,
  };

  it("accepts a matching active workspace assignment", () => {
    expect(() =>
      assertWorkspaceExecutorAssignmentState({
        executor,
        workspace,
        expectedExecutorId: executorId,
      }),
    ).not.toThrow();
  });

  it("rejects a missing workspace", () => {
    expect(() =>
      assertWorkspaceExecutorAssignmentState({
        executor,
        workspace: null,
        expectedExecutorId: executorId,
      }),
    ).toThrow("Workspace not found");
  });

  it("rejects a missing executor", () => {
    expect(() =>
      assertWorkspaceExecutorAssignmentState({
        executor: null,
        workspace,
        expectedExecutorId: executorId,
      }),
    ).toThrow("Executor not found");
  });

  it("rejects a disabled executor", () => {
    expect(() =>
      assertWorkspaceExecutorAssignmentState({
        executor: {
          _id: executorId,
          status: "disabled",
        },
        workspace,
        expectedExecutorId: executorId,
      }),
    ).toThrow("Executor is not active");
  });

  it("rejects an executor document that does not match the expected executor id", () => {
    expect(() =>
      assertWorkspaceExecutorAssignmentState({
        executor: {
          _id: "other_executor" as any,
          status: "active",
        },
        workspace,
        expectedExecutorId: executorId,
      }),
    ).toThrow("Executor document does not match expected executor id");
  });

  it("rejects a mismatched workspace assignment", () => {
    expect(() =>
      assertWorkspaceExecutorAssignmentState({
        executor,
        workspace: {
          _id: "workspace_123" as any,
          executorId: "other_executor" as any,
        },
        expectedExecutorId: executorId,
      }),
    ).toThrow("Workspace is not assigned to executor");
  });
});

describe("canManageExecutorLifecycle", () => {
  const executor = {
    createdBy: "creator-user",
  };

  it("allows the creator to manage the executor", () => {
    expect(
      canManageExecutorLifecycle({
        executor,
        user: {
          subject: "creator-user",
          role: "member",
        } as any,
      }),
    ).toBe(true);
  });

  it("allows org admins to manage the executor", () => {
    expect(
      canManageExecutorLifecycle({
        executor,
        user: {
          subject: "someone-else",
          role: "admin",
        } as any,
      }),
    ).toBe(true);
  });

  it("rejects non-creator workspace admins and members", () => {
    expect(
      canManageExecutorLifecycle({
        executor,
        user: {
          subject: "someone-else",
          role: "workspace_admin",
        } as any,
      }),
    ).toBe(false);
  });
});

describe("deriveExecutorInstanceHealth", () => {
  it("marks expired or non-online instances as offline", () => {
    expect(
      deriveExecutorInstanceHealth(
        {
          status: "online",
          expiresAt: 2_000,
        },
        1_000,
      ),
    ).toBe("online");

    expect(
      deriveExecutorInstanceHealth(
        {
          status: "online",
          expiresAt: 999,
        },
        1_000,
      ),
    ).toBe("offline");

    expect(
      deriveExecutorInstanceHealth(
        {
          status: "draining",
          expiresAt: 2_000,
        },
        1_000,
      ),
    ).toBe("offline");
  });
});

describe("buildExecutorSummary", () => {
  it("derives online counts and recent timestamps from instance rows", () => {
    const summary = buildExecutorSummary(
      {
        _id: "executor_1" as any,
        name: "Shared Fleet",
        status: "active",
        authMode: "opaque_secret",
        tokenVersion: 2,
        bootstrapTokenId: "bootstrap-id",
        bootstrapTokenHash: "bootstrap-hash",
        bootstrapIssuedAt: 1_000,
        bootstrapLastUsedAt: 2_000,
        createdBy: "creator-user",
        createdAt: 500,
        updatedAt: 600,
      } as any,
      [
        {
          _id: "instance_online" as any,
          executorId: "executor_1" as any,
          tokenVersion: 2,
          status: "online",
          registeredAt: 1_100,
          lastHeartbeatAt: 1_900,
          expiresAt: 2_500,
          instanceTokenId: "token-1",
          instanceTokenHash: "hash-1",
          instanceTokenIssuedAt: 1_100,
          instanceTokenExpiresAt: 2_100,
        },
        {
          _id: "instance_expired" as any,
          executorId: "executor_1" as any,
          tokenVersion: 2,
          status: "online",
          registeredAt: 1_300,
          lastHeartbeatAt: 2_200,
          expiresAt: 1_999,
          instanceTokenId: "token-2",
          instanceTokenHash: "hash-2",
          instanceTokenIssuedAt: 1_300,
          instanceTokenExpiresAt: 2_000,
        },
      ] as any,
      {
        now: 2_000,
        canManageLifecycle: true,
      },
    );

    expect(summary.onlineInstanceCount).toBe(1);
    expect(summary.lastHeartbeatAt).toBe(2_200);
    expect(summary.lastRegistrationAt).toBe(1_300);
    expect(summary.canManageLifecycle).toBe(true);
  });
});

describe("listManageableExecutorsInternalImpl", () => {
  it("returns only manageable executors for non-admin users and includes workspace/instance data", async () => {
    const ctx = createFakeCtx({
      executors: [
        {
          _id: "executor_owned",
          name: "Owned Executor",
          status: "active",
          authMode: "opaque_secret",
          tokenVersion: 1,
          bootstrapTokenId: "owned-bootstrap",
          bootstrapTokenHash: "owned-hash",
          bootstrapIssuedAt: 100,
          createdBy: "creator-user",
          createdAt: 100,
          updatedAt: 120,
        },
        {
          _id: "executor_other",
          name: "Other Executor",
          status: "active",
          authMode: "opaque_secret",
          tokenVersion: 2,
          bootstrapTokenId: "other-bootstrap",
          bootstrapTokenHash: "other-hash",
          bootstrapIssuedAt: 90,
          createdBy: "other-user",
          createdAt: 90,
          updatedAt: 110,
        },
      ],
      executorInstances: [
        {
          _id: "instance_online",
          executorId: "executor_owned",
          tokenVersion: 1,
          status: "online",
          registeredAt: 130,
          lastHeartbeatAt: 180,
          expiresAt: 250,
          instanceTokenId: "instance-online",
          instanceTokenHash: "hash-online",
          instanceTokenIssuedAt: 130,
          instanceTokenExpiresAt: 260,
          hostname: "host-a",
          version: "1.0.0",
        },
        {
          _id: "instance_offline",
          executorId: "executor_owned",
          tokenVersion: 1,
          status: "offline",
          registeredAt: 120,
          lastHeartbeatAt: 140,
          expiresAt: 150,
          instanceTokenId: "instance-offline",
          instanceTokenHash: "hash-offline",
          instanceTokenIssuedAt: 120,
          instanceTokenExpiresAt: 220,
          hostname: "host-b",
          version: "1.0.0",
        },
      ],
      workspaces: [
        {
          _id: "workspace_a",
          slug: "alpha",
          name: "Alpha",
          executorId: "executor_owned",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          _id: "workspace_b",
          slug: "beta",
          name: "Beta",
          executorId: "executor_owned",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          _id: "workspace_c",
          slug: "gamma",
          name: "Gamma",
          executorId: "executor_other",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    const result = await listManageableExecutorsInternalImpl(ctx as any, {
      user: {
        subject: "creator-user",
        role: "member",
      },
      now: 200,
    });

    expect(result).toHaveLength(1);
    expect(result[0].executor).toMatchObject({
      _id: "executor_owned",
      onlineInstanceCount: 1,
      canManageLifecycle: true,
      lastHeartbeatAt: 180,
    });
    expect(result[0].instances.map((instance) => instance.health)).toEqual(["online", "offline"]);
    expect(result[0].assignedWorkspaceCount).toBe(2);
    expect(result[0].assignedWorkspaces.map((workspace) => workspace.slug)).toEqual(["alpha", "beta"]);
  });

  it("returns all executors for org admins", async () => {
    const ctx = createFakeCtx({
      executors: [
        {
          _id: "executor_a",
          name: "A Executor",
          status: "active",
          authMode: "opaque_secret",
          tokenVersion: 1,
          bootstrapTokenId: "bootstrap-a",
          bootstrapTokenHash: "hash-a",
          bootstrapIssuedAt: 100,
          createdBy: "user-a",
          createdAt: 100,
          updatedAt: 100,
        },
        {
          _id: "executor_b",
          name: "B Executor",
          status: "active",
          authMode: "opaque_secret",
          tokenVersion: 1,
          bootstrapTokenId: "bootstrap-b",
          bootstrapTokenHash: "hash-b",
          bootstrapIssuedAt: 100,
          createdBy: "user-b",
          createdAt: 100,
          updatedAt: 100,
        },
      ],
    });

    const result = await listManageableExecutorsInternalImpl(ctx as any, {
      user: {
        subject: "admin-user",
        role: "admin",
      },
      now: 200,
    });

    expect(result.map((entry) => entry.executor._id)).toEqual(["executor_a", "executor_b"]);
  });
});

describe("createExecutorUnassignedInternalImpl", () => {
  it("creates an unassigned executor and returns setup instructions", async () => {
    const originalConvexUrl = process.env.CONVEX_URL;
    process.env.CONVEX_URL = "https://example.convex.cloud";

    try {
      const ctx = createFakeCtx({
        workspaces: [
          {
            _id: "workspace_1",
            slug: "alpha",
            name: "Alpha",
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      });

      const result = await createExecutorUnassignedInternalImpl(ctx as any, {
        name: "Shared Executor",
        createdBy: "creator-user",
        now: 500,
      });

      expect(result.executor).toMatchObject({
        name: "Shared Executor",
        createdBy: "creator-user",
        status: "active",
        onlineInstanceCount: 0,
        canManageLifecycle: true,
      });
      expect(result.bootstrapToken).toBeTruthy();
      expect(result.setup.requiredEnvVars.length).toBeGreaterThan(0);
      expect(ctx.tables.executors).toHaveLength(1);
      expect(ctx.tables.workspaces[0].executorId).toBeUndefined();
    } finally {
      if (originalConvexUrl === undefined) {
        delete process.env.CONVEX_URL;
      } else {
        process.env.CONVEX_URL = originalConvexUrl;
      }
    }
  });
});

describe("ensureLocalDevExecutorInternalImpl", () => {
  it("creates the shared local dev executor and assigns workspaces when missing", async () => {
    const ctx = createFakeCtx({
      workspaces: [
        {
          _id: "workspace_1",
          slug: "demo",
          name: "Demo",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          _id: "workspace_2",
          slug: "testing",
          name: "Testing",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    const result = await ensureLocalDevExecutorInternalImpl(ctx as any, {
      workspaceIds: ["workspace_1" as any, "workspace_2" as any],
      rotateBootstrap: false,
    });

    expect(result.executorId).toBeTruthy();
    expect(result.assignedWorkspaceIds).toEqual(["workspace_1", "workspace_2"]);
    expect(result.bootstrapToken).toBeTruthy();

    expect(ctx.tables.executors).toHaveLength(1);
    expect(ctx.tables.executors[0]).toMatchObject({
      _id: result.executorId,
      name: LOCAL_DEV_EXECUTOR_NAME,
      createdBy: LOCAL_DEV_EXECUTOR_CREATED_BY,
      status: "active",
      tokenVersion: 1,
    });
    expect(ctx.tables.workspaces.map((workspace) => workspace.executorId)).toEqual([
      result.executorId,
      result.executorId,
    ]);
  });

  it("reuses the existing shared executor and assigns requested workspaces without rotating by default", async () => {
    const existingExecutor = {
      _id: "executor_existing",
      name: LOCAL_DEV_EXECUTOR_NAME,
      status: "active",
      authMode: "opaque_secret",
      tokenVersion: 4,
      bootstrapTokenId: "bootstrap-existing",
      bootstrapTokenHash: "hash-existing",
      bootstrapIssuedAt: 10,
      createdBy: LOCAL_DEV_EXECUTOR_CREATED_BY,
      createdAt: 5,
      updatedAt: 20,
    };
    const ctx = createFakeCtx({
      executors: [existingExecutor],
      workspaces: [
        {
          _id: "workspace_1",
          slug: "demo",
          name: "Demo",
          executorId: undefined,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    const result = await ensureLocalDevExecutorInternalImpl(ctx as any, {
      workspaceIds: ["workspace_1" as any],
      rotateBootstrap: false,
    });

    expect(result).toEqual({
      executorId: "executor_existing",
      assignedWorkspaceIds: ["workspace_1"],
    });
    expect(ctx.tables.executors).toHaveLength(1);
    expect(ctx.tables.executors[0].tokenVersion).toBe(4);
    expect(ctx.tables.workspaces[0].executorId).toBe("executor_existing");
  });

  it("rotates bootstrap credentials and invalidates online instances when requested", async () => {
    const ctx = createFakeCtx({
      executors: [
        {
          _id: "executor_existing",
          name: LOCAL_DEV_EXECUTOR_NAME,
          status: "active",
          authMode: "opaque_secret",
          tokenVersion: 2,
          bootstrapTokenId: "bootstrap-existing",
          bootstrapTokenHash: "hash-existing",
          bootstrapIssuedAt: 10,
          bootstrapLastUsedAt: 12,
          createdBy: LOCAL_DEV_EXECUTOR_CREATED_BY,
          createdAt: 5,
          updatedAt: 20,
        },
      ],
      executorInstances: [
        {
          _id: "instance_online",
          executorId: "executor_existing",
          tokenVersion: 2,
          status: "online",
          registeredAt: 11,
          lastHeartbeatAt: 20,
          expiresAt: 500,
          instanceTokenId: "instance-token-1",
          instanceTokenHash: "instance-hash-1",
          instanceTokenIssuedAt: 11,
          instanceTokenExpiresAt: 500,
        },
        {
          _id: "instance_offline",
          executorId: "executor_existing",
          tokenVersion: 2,
          status: "offline",
          registeredAt: 11,
          lastHeartbeatAt: 20,
          expiresAt: 100,
          instanceTokenId: "instance-token-2",
          instanceTokenHash: "instance-hash-2",
          instanceTokenIssuedAt: 11,
          instanceTokenExpiresAt: 100,
        },
      ],
    });

    const result = await ensureLocalDevExecutorInternalImpl(ctx as any, {
      rotateBootstrap: true,
    });

    expect(result.executorId).toBe("executor_existing");
    expect(result.assignedWorkspaceIds).toEqual([]);
    expect(result.bootstrapToken).toBeTruthy();

    expect(ctx.tables.executors[0].tokenVersion).toBe(3);
    expect(ctx.tables.executors[0].bootstrapTokenId).not.toBe("bootstrap-existing");
    expect(ctx.tables.executors[0].bootstrapTokenHash).not.toBe("hash-existing");
    expect(ctx.tables.executors[0].bootstrapLastUsedAt).toBeUndefined();
    expect(ctx.tables.executorInstances.find((instance) => instance._id === "instance_online")).toMatchObject({
      status: "offline",
    });
    expect(ctx.tables.executorInstances.find((instance) => instance._id === "instance_offline")).toMatchObject({
      status: "offline",
      expiresAt: 100,
    });
  });
});

describe("setWorkspaceExecutorInternalImpl", () => {
  it("fails pending runtime and compile jobs when reassignment explicitly allows it", async () => {
    const ctx = createFakeCtx({
      workspaces: [
        {
          _id: "workspace_1",
          slug: "demo",
          name: "Demo",
          executorId: "executor_old",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      executors: [
        {
          _id: "executor_old",
          name: "Old Executor",
          status: "active",
          authMode: "opaque_secret",
          tokenVersion: 1,
          bootstrapTokenId: "old-token",
          bootstrapTokenHash: "old-hash",
          bootstrapIssuedAt: 1,
          createdBy: "user_1",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          _id: "executor_new",
          name: "New Executor",
          status: "active",
          authMode: "opaque_secret",
          tokenVersion: 1,
          bootstrapTokenId: "new-token",
          bootstrapTokenHash: "new-hash",
          bootstrapIssuedAt: 1,
          createdBy: "user_1",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      jobs: [
        {
          _id: "job_pending",
          workspaceId: "workspace_1",
          targetExecutorId: "executor_old",
          status: "pending",
          threadId: "thread_1",
          toolCallId: "tool_1",
        },
      ],
      compileJobs: [
        {
          _id: "compile_pending",
          workspaceId: "workspace_1",
          targetExecutorId: "executor_old",
          status: "pending",
          createdAt: 1,
        },
      ],
    });

    await setWorkspaceExecutorInternalImpl(ctx as any, {
      workspaceId: "workspace_1" as any,
      executorId: "executor_new" as any,
      failPendingJobs: true,
    });

    expect(ctx.tables.workspaces[0].executorId).toBe("executor_new");
    expect(ctx.tables.jobs[0]).toMatchObject({
      status: "failed",
      error: {
        data: {
          errorType: "EXECUTOR_REASSIGNED",
        },
      },
    });
    expect(ctx.tables.compileJobs[0]).toMatchObject({
      status: "failed",
      error: {
        data: {
          errorType: "EXECUTOR_REASSIGNED",
        },
      },
    });
    expect(ctx.mutationCalls).toEqual([
      {
        ref: expect.anything(),
        args: {
          threadId: "thread_1",
          toolCallId: "tool_1",
          error:
            "Code execution failed:\nJob failed because the workspace executor was reassigned before execution started.",
        },
      },
    ]);
  });

  it("continues reassignment when tool error emission fails", async () => {
    const ctx = createFakeCtx({
      workspaces: [
        {
          _id: "workspace_1",
          slug: "demo",
          name: "Demo",
          executorId: "executor_old",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      executors: [
        {
          _id: "executor_old",
          name: "Old Executor",
          status: "active",
          authMode: "opaque_secret",
          tokenVersion: 1,
          bootstrapTokenId: "old-token",
          bootstrapTokenHash: "old-hash",
          bootstrapIssuedAt: 1,
          createdBy: "user_1",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          _id: "executor_new",
          name: "New Executor",
          status: "active",
          authMode: "opaque_secret",
          tokenVersion: 1,
          bootstrapTokenId: "new-token",
          bootstrapTokenHash: "new-hash",
          bootstrapIssuedAt: 1,
          createdBy: "user_1",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      jobs: [
        {
          _id: "job_pending",
          workspaceId: "workspace_1",
          targetExecutorId: "executor_old",
          status: "pending",
          threadId: "thread_1",
          toolCallId: "tool_1",
        },
      ],
    });
    ctx.runMutation = async (ref: unknown, args: unknown) => {
      ctx.mutationCalls.push({ ref, args });
      throw new Error("tool error mutation failed");
    };

    await setWorkspaceExecutorInternalImpl(ctx as any, {
      workspaceId: "workspace_1" as any,
      executorId: "executor_new" as any,
      failPendingJobs: true,
    });

    expect(ctx.tables.workspaces[0].executorId).toBe("executor_new");
    expect(ctx.tables.jobs[0]).toMatchObject({
      status: "failed",
      error: {
        data: {
          errorType: "EXECUTOR_REASSIGNED",
        },
      },
    });
    expect(ctx.mutationCalls).toHaveLength(1);
  });

  it("rejects reassignment when pending jobs exist and failure was not confirmed", async () => {
    const ctx = createFakeCtx({
      workspaces: [
        {
          _id: "workspace_1",
          slug: "demo",
          name: "Demo",
          executorId: "executor_old",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      executors: [
        {
          _id: "executor_old",
          name: "Old Executor",
          status: "active",
          authMode: "opaque_secret",
          tokenVersion: 1,
          bootstrapTokenId: "old-token",
          bootstrapTokenHash: "old-hash",
          bootstrapIssuedAt: 1,
          createdBy: "user_1",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          _id: "executor_new",
          name: "New Executor",
          status: "active",
          authMode: "opaque_secret",
          tokenVersion: 1,
          bootstrapTokenId: "new-token",
          bootstrapTokenHash: "new-hash",
          bootstrapIssuedAt: 1,
          createdBy: "user_1",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      jobs: [
        {
          _id: "job_pending",
          workspaceId: "workspace_1",
          targetExecutorId: "executor_old",
          status: "pending",
        },
      ],
    });

    await expect(
      setWorkspaceExecutorInternalImpl(ctx as any, {
        workspaceId: "workspace_1" as any,
        executorId: "executor_new" as any,
      }),
    ).rejects.toThrow("unless pending jobs are explicitly failed");

    expect(ctx.tables.workspaces[0].executorId).toBe("executor_old");
    expect(ctx.tables.jobs[0].status).toBe("pending");
  });

  it("still rejects reassignment when running jobs exist", async () => {
    const ctx = createFakeCtx({
      workspaces: [
        {
          _id: "workspace_1",
          slug: "demo",
          name: "Demo",
          executorId: "executor_old",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      executors: [
        {
          _id: "executor_old",
          name: "Old Executor",
          status: "active",
          authMode: "opaque_secret",
          tokenVersion: 1,
          bootstrapTokenId: "old-token",
          bootstrapTokenHash: "old-hash",
          bootstrapIssuedAt: 1,
          createdBy: "user_1",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          _id: "executor_new",
          name: "New Executor",
          status: "active",
          authMode: "opaque_secret",
          tokenVersion: 1,
          bootstrapTokenId: "new-token",
          bootstrapTokenHash: "new-hash",
          bootstrapIssuedAt: 1,
          createdBy: "user_1",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      jobs: [
        {
          _id: "job_running",
          workspaceId: "workspace_1",
          targetExecutorId: "executor_old",
          status: "running",
        },
      ],
    });

    await expect(
      setWorkspaceExecutorInternalImpl(ctx as any, {
        workspaceId: "workspace_1" as any,
        executorId: "executor_new" as any,
        failPendingJobs: true,
      }),
    ).rejects.toThrow("running");

    expect(ctx.tables.workspaces[0].executorId).toBe("executor_old");
    expect(ctx.tables.jobs[0].status).toBe("running");
  });
});

describe("renameExecutorImpl", () => {
  it("updates the executor name and returns the refreshed summary", async () => {
    const ctx = createFakeCtx(
      {
        executors: [
          {
            _id: "executor_existing",
            name: "Shared Fleet",
            status: "active",
            authMode: "opaque_secret",
            tokenVersion: 2,
            bootstrapTokenId: "bootstrap-existing",
            bootstrapTokenHash: "hash-existing",
            bootstrapIssuedAt: 10,
            createdBy: "creator-user",
            createdAt: 5,
            updatedAt: 20,
          },
        ],
        executorInstances: [
          {
            _id: "instance_online",
            executorId: "executor_existing",
            tokenVersion: 2,
            status: "online",
            registeredAt: 11,
            lastHeartbeatAt: 20,
            expiresAt: 500,
            instanceTokenId: "instance-token-1",
            instanceTokenHash: "instance-hash-1",
            instanceTokenIssuedAt: 11,
            instanceTokenExpiresAt: 500,
          },
        ],
      },
      {
        user: {
          subject: "creator-user",
          org_id: process.env.WORKOS_ORG_ID!,
          role: "member",
        },
      },
    );

    const result = await renameExecutorImpl(ctx as any, {
      executorId: "executor_existing" as any,
      name: "Renamed Fleet",
    });

    expect(result.executor.name).toBe("Renamed Fleet");
    expect(ctx.tables.executors[0].name).toBe("Renamed Fleet");
  });
});

describe("deleteExecutorImpl", () => {
  it("deletes an idle executor, removes its instances, and unassigns workspaces", async () => {
    const ctx = createFakeCtx(
      {
        executors: [
          {
            _id: "executor_existing",
            name: "Shared Fleet",
            status: "active",
            authMode: "opaque_secret",
            tokenVersion: 2,
            bootstrapTokenId: "bootstrap-existing",
            bootstrapTokenHash: "hash-existing",
            bootstrapIssuedAt: 10,
            createdBy: "creator-user",
            createdAt: 5,
            updatedAt: 20,
          },
        ],
        executorInstances: [
          {
            _id: "instance_1",
            executorId: "executor_existing",
            tokenVersion: 2,
            status: "offline",
            registeredAt: 11,
            lastHeartbeatAt: 20,
            expiresAt: 100,
            instanceTokenId: "instance-token-1",
            instanceTokenHash: "instance-hash-1",
            instanceTokenIssuedAt: 11,
            instanceTokenExpiresAt: 500,
          },
          {
            _id: "instance_2",
            executorId: "executor_existing",
            tokenVersion: 2,
            status: "online",
            registeredAt: 12,
            lastHeartbeatAt: 21,
            expiresAt: 600,
            instanceTokenId: "instance-token-2",
            instanceTokenHash: "instance-hash-2",
            instanceTokenIssuedAt: 12,
            instanceTokenExpiresAt: 600,
          },
        ],
        workspaces: [
          {
            _id: "workspace_1",
            slug: "alpha",
            name: "Alpha",
            executorId: "executor_existing",
            createdAt: 1,
            updatedAt: 1,
          },
          {
            _id: "workspace_2",
            slug: "beta",
            name: "Beta",
            executorId: "executor_existing",
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        sessionExecutorAssignments: [
          {
            _id: "assignment_1",
            sessionId: "session_1",
            workspaceId: "workspace_1",
            executorId: "executor_existing",
            assignedInstanceId: "instance_1",
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
      {
        user: {
          subject: "creator-user",
          org_id: process.env.WORKOS_ORG_ID!,
          role: "member",
        },
      },
    );

    const result = await deleteExecutorImpl(ctx as any, {
      executorId: "executor_existing" as any,
    });

    expect(result).toEqual({
      deleted: true,
      clearedWorkspaceCount: 2,
      deletedInstanceCount: 2,
    });
    expect(ctx.tables.executors).toHaveLength(0);
    expect(ctx.tables.executorInstances).toHaveLength(0);
    expect(ctx.tables.sessionExecutorAssignments).toHaveLength(0);
    expect(ctx.tables.workspaces.map((workspace) => workspace.executorId)).toEqual([undefined, undefined]);
  });

  it("rejects deletion when pending runtime or compile jobs exist", async () => {
    const ctx = createFakeCtx(
      {
        executors: [
          {
            _id: "executor_existing",
            name: "Shared Fleet",
            status: "active",
            authMode: "opaque_secret",
            tokenVersion: 2,
            bootstrapTokenId: "bootstrap-existing",
            bootstrapTokenHash: "hash-existing",
            bootstrapIssuedAt: 10,
            createdBy: "creator-user",
            createdAt: 5,
            updatedAt: 20,
          },
        ],
        jobs: [
          {
            _id: "job_pending",
            workspaceId: "workspace_1",
            targetExecutorId: "executor_existing",
            status: "pending",
          },
        ],
        compileJobs: [
          {
            _id: "compile_pending",
            workspaceId: "workspace_1",
            targetExecutorId: "executor_existing",
            status: "pending",
          },
        ],
      },
      {
        user: {
          subject: "creator-user",
          org_id: process.env.WORKOS_ORG_ID!,
          role: "member",
        },
      },
    );

    await expect(
      deleteExecutorImpl(ctx as any, {
        executorId: "executor_existing" as any,
      }),
    ).rejects.toThrow("pending/running");
    expect(ctx.tables.executors).toHaveLength(1);
  });
});

describe("cleanupStaleExecutorInstancesInternalImpl", () => {
  it("deletes instances inactive longer than the retention window", async () => {
    const now = EXECUTOR_INACTIVE_INSTANCE_RETENTION_MS + 10_000;
    const ctx = createFakeCtx({
      executorInstances: [
        {
          _id: "instance_stale",
          executorId: "executor_1",
          tokenVersion: 1,
          status: "offline",
          registeredAt: 100,
          lastHeartbeatAt: 200,
          expiresAt: 0,
          instanceTokenId: "instance-token-1",
          instanceTokenHash: "instance-hash-1",
          instanceTokenIssuedAt: 100,
          instanceTokenExpiresAt: 200,
        },
        {
          _id: "instance_recent",
          executorId: "executor_1",
          tokenVersion: 1,
          status: "offline",
          registeredAt: 100,
          lastHeartbeatAt: 200,
          expiresAt: now - EXECUTOR_INACTIVE_INSTANCE_RETENTION_MS + 1_000,
          instanceTokenId: "instance-token-2",
          instanceTokenHash: "instance-hash-2",
          instanceTokenIssuedAt: 100,
          instanceTokenExpiresAt: 200,
        },
        {
          _id: "instance_healthy",
          executorId: "executor_1",
          tokenVersion: 1,
          status: "online",
          registeredAt: 100,
          lastHeartbeatAt: 200,
          expiresAt: now + 30_000,
          instanceTokenId: "instance-token-3",
          instanceTokenHash: "instance-hash-3",
          instanceTokenIssuedAt: 100,
          instanceTokenExpiresAt: 200,
        },
      ],
      sessionExecutorAssignments: [
        {
          _id: "assignment_stale",
          sessionId: "session_1",
          workspaceId: "workspace_1",
          executorId: "executor_1",
          assignedInstanceId: "instance_stale",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          _id: "assignment_recent",
          sessionId: "session_2",
          workspaceId: "workspace_1",
          executorId: "executor_1",
          assignedInstanceId: "instance_recent",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    const result = await cleanupStaleExecutorInstancesInternalImpl(ctx as any, { now });

    expect(result).toEqual({ deletedCount: 1 });
    expect(ctx.tables.executorInstances.map((instance) => instance._id)).toEqual([
      "instance_recent",
      "instance_healthy",
    ]);
    expect(ctx.tables.sessionExecutorAssignments.map((assignment) => assignment._id)).toEqual(["assignment_recent"]);
  });
});

describe("rotateExecutorBootstrapTokenImpl", () => {
  it("rotates bootstrap credentials, invalidates online instances, and returns setup instructions", async () => {
    const ctx = createFakeCtx(
      {
        executors: [
          {
            _id: "executor_existing",
            name: "Shared Fleet",
            status: "active",
            authMode: "opaque_secret",
            tokenVersion: 2,
            bootstrapTokenId: "bootstrap-existing",
            bootstrapTokenHash: "hash-existing",
            bootstrapIssuedAt: 10,
            bootstrapLastUsedAt: 12,
            createdBy: "creator-user",
            createdAt: 5,
            updatedAt: 20,
          },
        ],
        executorInstances: [
          {
            _id: "instance_online",
            executorId: "executor_existing",
            tokenVersion: 2,
            status: "online",
            registeredAt: 11,
            lastHeartbeatAt: 20,
            expiresAt: 500,
            instanceTokenId: "instance-token-1",
            instanceTokenHash: "instance-hash-1",
            instanceTokenIssuedAt: 11,
            instanceTokenExpiresAt: 500,
          },
          {
            _id: "instance_offline",
            executorId: "executor_existing",
            tokenVersion: 2,
            status: "offline",
            registeredAt: 11,
            lastHeartbeatAt: 20,
            expiresAt: 100,
            instanceTokenId: "instance-token-2",
            instanceTokenHash: "instance-hash-2",
            instanceTokenIssuedAt: 11,
            instanceTokenExpiresAt: 100,
          },
        ],
      },
      {
        user: {
          subject: "creator-user",
          org_id: process.env.WORKOS_ORG_ID!,
          role: "member",
        },
      },
    );

    const result = await rotateExecutorBootstrapTokenImpl(ctx as any, {
      executorId: "executor_existing" as any,
    });

    expect(result.bootstrapToken).toBeTruthy();
    expect(result.executor.tokenVersion).toBe(3);
    expect(result.executor.onlineInstanceCount).toBe(0);
    expect(result.setup.requiredEnvVars).toEqual(["TOKENSPACE_API_URL", "TOKENSPACE_TOKEN"]);
    expect(result.setup.snippets.docker).toContain(result.bootstrapToken);
    expect(result.setup.snippets.docker).toContain(process.env.CONVEX_URL!);
    expect(result.setup.snippets.raw).toContain(result.bootstrapToken);
    expect(result.setup.snippets.raw).toContain(process.env.CONVEX_URL!);

    expect(ctx.tables.executors[0].tokenVersion).toBe(3);
    expect(ctx.tables.executors[0].bootstrapTokenId).not.toBe("bootstrap-existing");
    expect(ctx.tables.executors[0].bootstrapTokenHash).not.toBe("hash-existing");
    expect(ctx.tables.executors[0].bootstrapLastUsedAt).toBeUndefined();
    expect(ctx.tables.executorInstances.find((instance) => instance._id === "instance_online")).toMatchObject({
      status: "offline",
    });
    expect(ctx.tables.executorInstances.find((instance) => instance._id === "instance_offline")).toMatchObject({
      status: "offline",
      expiresAt: 100,
    });
  });
});
