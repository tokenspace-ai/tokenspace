import { describe, expect, it } from "bun:test";
import {
  assertWorkspaceExecutorAssignmentState,
  buildExecutorSummary,
  canManageExecutorLifecycle,
  deriveExecutorInstanceHealth,
  ensureLocalDevExecutorInternalImpl,
  isExecutorInstanceHealthy,
  LOCAL_DEV_EXECUTOR_CREATED_BY,
  LOCAL_DEV_EXECUTOR_NAME,
} from "../convex/executors";

type TableName =
  | "workspaces"
  | "executors"
  | "executorInstances"
  | "jobs"
  | "compileJobs"
  | "sessionExecutorAssignments";

function createFakeCtx(seed?: Partial<Record<TableName, any[]>>) {
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
      const buildAccessor = (filters: Array<{ field: string; value: unknown }>) => {
        const applyFilters = () =>
          tables[table].filter((row) => filters.every((filter) => row[filter.field] === filter.value));
        return {
          collect: async () => applyFilters(),
          first: async () => applyFilters()[0] ?? null,
        };
      };

      return {
        collect: async () => tables[table],
        withIndex: (_indexName: string, build?: (q: { eq: (field: string, value: unknown) => any }) => any) => {
          const filters: Array<{ field: string; value: unknown }> = [];
          const builder = {
            eq(field: string, value: unknown) {
              filters.push({ field, value });
              return builder;
            },
          };
          build?.(builder);
          return buildAccessor(filters);
        },
      };
    },
  };

  return {
    db,
    tables,
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
