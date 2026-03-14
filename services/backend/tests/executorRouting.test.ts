import { describe, expect, it } from "bun:test";
import {
  buildExecutorUnavailableError,
  clearSessionExecutorAssignment,
  clearSessionExecutorAssignmentsForExecutor,
  clearSessionExecutorAssignmentsForWorkspace,
  countNonterminalAssignments,
  pickPreferredExecutorInstance,
  scheduleJobToExecutorInstance,
} from "../convex/executorRouting";

type TableName =
  | "workspaces"
  | "executors"
  | "executorInstances"
  | "jobs"
  | "compileJobs"
  | "sessions"
  | "revisions"
  | "sessionExecutorAssignments";

function createFakeCtx(seed?: Partial<Record<TableName, any[]>>) {
  const tables: Record<TableName, any[]> = {
    workspaces: [],
    executors: [],
    executorInstances: [],
    jobs: [],
    compileJobs: [],
    sessions: [],
    revisions: [],
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
    query: (table: TableName) => ({
      withIndex: (_indexName: string, build?: (q: { eq: (field: string, value: unknown) => any }) => any) => {
        const filters: Array<{ field: string; value: unknown }> = [];
        const builder = {
          eq(field: string, value: unknown) {
            filters.push({ field, value });
            return builder;
          },
        };
        build?.(builder);
        const applyFilters = () =>
          tables[table].filter((row) => filters.every((filter) => row[filter.field] === filter.value));
        return {
          collect: async () => applyFilters(),
          first: async () => applyFilters()[0] ?? null,
        };
      },
    }),
  };

  return {
    db,
    tables,
  };
}

describe("buildExecutorUnavailableError", () => {
  it("includes structured metadata for unassigned workspaces", () => {
    const error = buildExecutorUnavailableError({
      reason: "unassigned_executor",
      workspaceId: "workspace_1" as any,
    });

    expect(error.message).toBe("Workspace has no assigned executor");
    expect(error.data).toEqual({
      errorType: "EXECUTOR_UNAVAILABLE",
      reason: "unassigned_executor",
      workspaceId: "workspace_1",
    });
  });

  it("includes executor context when no healthy instance exists", () => {
    const error = buildExecutorUnavailableError({
      reason: "no_healthy_instance",
      workspaceId: "workspace_1" as any,
      executorId: "executor_1" as any,
    });

    expect(error.message).toBe("No healthy executor instance is available");
    expect(error.data.executorId).toBe("executor_1");
  });
});

describe("pickPreferredExecutorInstance", () => {
  const baseInstances = [
    {
      _id: "instance_a" as any,
      status: "online" as const,
      expiresAt: 2_000,
      lastHeartbeatAt: 1_500,
      maxConcurrentRuntimeJobs: undefined,
      maxConcurrentCompileJobs: undefined,
    },
    {
      _id: "instance_b" as any,
      status: "online" as const,
      expiresAt: 2_000,
      lastHeartbeatAt: 1_600,
      maxConcurrentRuntimeJobs: undefined,
      maxConcurrentCompileJobs: undefined,
    },
  ];

  it("picks the least-loaded healthy instance", () => {
    const picked = pickPreferredExecutorInstance({
      instances: baseInstances,
      queueKind: "runtime",
      loadByInstanceId: new Map([
        ["instance_a" as any, 3],
        ["instance_b" as any, 1],
      ]),
      now: 1_000,
    });

    expect(picked?._id).toBe("instance_b");
  });

  it("respects per-queue capacity limits", () => {
    const picked = pickPreferredExecutorInstance({
      instances: [
        {
          ...baseInstances[0],
          maxConcurrentRuntimeJobs: 1,
        },
        {
          ...baseInstances[1],
          maxConcurrentRuntimeJobs: 2,
        },
      ],
      queueKind: "runtime",
      loadByInstanceId: new Map([
        ["instance_a" as any, 1],
        ["instance_b" as any, 1],
      ]),
      now: 1_000,
    });

    expect(picked?._id).toBe("instance_b");
  });

  it("honors a healthy preferred runtime instance even when it is at capacity", () => {
    const picked = pickPreferredExecutorInstance({
      instances: [
        {
          ...baseInstances[0],
          maxConcurrentRuntimeJobs: 1,
        },
        {
          ...baseInstances[1],
          maxConcurrentRuntimeJobs: 10,
        },
      ],
      queueKind: "runtime",
      loadByInstanceId: new Map([
        ["instance_a" as any, 1],
        ["instance_b" as any, 0],
      ]),
      preferredInstanceId: "instance_a" as any,
      honorPreferredCapacity: true,
      now: 1_000,
    });

    expect(picked?._id).toBe("instance_a");
  });

  it("falls back when the preferred instance is unhealthy", () => {
    const picked = pickPreferredExecutorInstance({
      instances: [
        {
          ...baseInstances[0],
          status: "offline" as const,
        },
        baseInstances[1],
      ],
      queueKind: "runtime",
      loadByInstanceId: new Map(),
      preferredInstanceId: "instance_a" as any,
      honorPreferredCapacity: true,
      now: 1_000,
    });

    expect(picked?._id).toBe("instance_b");
  });

  it("breaks ties by freshest heartbeat then stable id", () => {
    const picked = pickPreferredExecutorInstance({
      instances: [
        {
          ...baseInstances[0],
          _id: "instance_z" as any,
          lastHeartbeatAt: 1_700,
        },
        {
          ...baseInstances[1],
          _id: "instance_a" as any,
          lastHeartbeatAt: 1_700,
        },
      ],
      queueKind: "compile",
      loadByInstanceId: new Map(),
      now: 1_000,
    });

    expect(picked?._id).toBe("instance_a");
  });

  it("excludes unhealthy or expired instances", () => {
    const picked = pickPreferredExecutorInstance({
      instances: [
        {
          ...baseInstances[0],
          status: "offline" as const,
        },
        {
          ...baseInstances[1],
          expiresAt: 999,
        },
      ],
      queueKind: "runtime",
      loadByInstanceId: new Map(),
      now: 1_000,
    });

    expect(picked).toBeNull();
  });
});

describe("countNonterminalAssignments", () => {
  it("counts only pending and running assignments", () => {
    const counts = countNonterminalAssignments([
      {
        assignedInstanceId: "instance_1" as any,
        status: "pending" as const,
      },
      {
        assignedInstanceId: "instance_1" as any,
        status: "running" as const,
      },
      {
        assignedInstanceId: "instance_1" as any,
        status: "failed" as const,
      },
      {
        assignedInstanceId: "instance_2" as any,
        status: "completed" as const,
      },
    ]);

    expect(counts.get("instance_1" as any)).toBe(2);
    expect(counts.has("instance_2" as any)).toBe(false);
  });
});

describe("scheduleJobToExecutorInstance", () => {
  it("reuses healthy session affinity for runtime jobs", async () => {
    const ctx = createFakeCtx({
      workspaces: [{ _id: "workspace_1", executorId: "executor_1" }],
      executors: [{ _id: "executor_1", status: "active" }],
      revisions: [{ _id: "revision_1", workspaceId: "workspace_1" }],
      sessions: [{ _id: "session_1", revisionId: "revision_1" }],
      executorInstances: [
        {
          _id: "instance_1",
          executorId: "executor_1",
          status: "online",
          expiresAt: 5_000,
          lastHeartbeatAt: 2_000,
          maxConcurrentRuntimeJobs: 1,
        },
        {
          _id: "instance_2",
          executorId: "executor_1",
          status: "online",
          expiresAt: 5_000,
          lastHeartbeatAt: 2_100,
          maxConcurrentRuntimeJobs: 10,
        },
      ],
      jobs: [
        {
          _id: "job_1",
          targetExecutorId: "executor_1",
          assignedInstanceId: "instance_1",
          status: "running",
        },
      ],
      sessionExecutorAssignments: [
        {
          _id: "affinity_1",
          sessionId: "session_1",
          workspaceId: "workspace_1",
          executorId: "executor_1",
          assignedInstanceId: "instance_1",
          createdAt: 100,
          updatedAt: 100,
        },
      ],
    });

    const scheduled = await scheduleJobToExecutorInstance(ctx as any, {
      workspaceId: "workspace_1" as any,
      queueKind: "runtime",
      sessionId: "session_1" as any,
      now: 1_000,
    });

    expect(scheduled.kind).toBe("assigned");
    if (scheduled.kind === "assigned") {
      expect(scheduled.assignedInstanceId).toBe("instance_1");
    }
  });

  it("reassigns stale session affinity and updates the row", async () => {
    const ctx = createFakeCtx({
      workspaces: [{ _id: "workspace_1", executorId: "executor_1" }],
      executors: [{ _id: "executor_1", status: "active" }],
      revisions: [{ _id: "revision_1", workspaceId: "workspace_1" }],
      sessions: [{ _id: "session_1", revisionId: "revision_1" }],
      executorInstances: [
        {
          _id: "instance_1",
          executorId: "executor_1",
          status: "online",
          expiresAt: 999,
          lastHeartbeatAt: 900,
          maxConcurrentRuntimeJobs: 1,
        },
        {
          _id: "instance_2",
          executorId: "executor_1",
          status: "online",
          expiresAt: 5_000,
          lastHeartbeatAt: 2_100,
          maxConcurrentRuntimeJobs: 10,
        },
      ],
      sessionExecutorAssignments: [
        {
          _id: "affinity_1",
          sessionId: "session_1",
          workspaceId: "workspace_1",
          executorId: "executor_1",
          assignedInstanceId: "instance_1",
          createdAt: 100,
          updatedAt: 100,
        },
      ],
    });

    const scheduled = await scheduleJobToExecutorInstance(ctx as any, {
      workspaceId: "workspace_1" as any,
      queueKind: "runtime",
      sessionId: "session_1" as any,
      now: 1_000,
    });

    expect(scheduled.kind).toBe("assigned");
    if (scheduled.kind === "assigned") {
      expect(scheduled.assignedInstanceId).toBe("instance_2");
    }
    expect(ctx.tables.sessionExecutorAssignments[0]?.assignedInstanceId).toBe("instance_2");
    expect(ctx.tables.sessionExecutorAssignments[0]?.updatedAt).toBe(1_000);
  });

  it("keeps compile jobs on least-loaded scheduling without session affinity", async () => {
    const ctx = createFakeCtx({
      workspaces: [{ _id: "workspace_1", executorId: "executor_1" }],
      executors: [{ _id: "executor_1", status: "active" }],
      executorInstances: [
        {
          _id: "instance_1",
          executorId: "executor_1",
          status: "online",
          expiresAt: 5_000,
          lastHeartbeatAt: 2_000,
          maxConcurrentCompileJobs: 10,
        },
        {
          _id: "instance_2",
          executorId: "executor_1",
          status: "online",
          expiresAt: 5_000,
          lastHeartbeatAt: 2_100,
          maxConcurrentCompileJobs: 10,
        },
      ],
      compileJobs: [
        {
          _id: "compile_1",
          targetExecutorId: "executor_1",
          assignedInstanceId: "instance_2",
          status: "running",
        },
      ],
      sessionExecutorAssignments: [
        {
          _id: "affinity_1",
          sessionId: "session_1",
          workspaceId: "workspace_1",
          executorId: "executor_1",
          assignedInstanceId: "instance_1",
          createdAt: 100,
          updatedAt: 100,
        },
      ],
    });

    const scheduled = await scheduleJobToExecutorInstance(ctx as any, {
      workspaceId: "workspace_1" as any,
      queueKind: "compile",
      now: 1_000,
    });

    expect(scheduled.kind).toBe("assigned");
    if (scheduled.kind === "assigned") {
      expect(scheduled.assignedInstanceId).toBe("instance_1");
    }
  });
});

describe("session affinity cleanup", () => {
  it("clears affinity by session, workspace, and executor", async () => {
    const ctx = createFakeCtx({
      sessionExecutorAssignments: [
        {
          _id: "affinity_1",
          sessionId: "session_1",
          workspaceId: "workspace_1",
          executorId: "executor_1",
          assignedInstanceId: "instance_1",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          _id: "affinity_2",
          sessionId: "session_2",
          workspaceId: "workspace_1",
          executorId: "executor_2",
          assignedInstanceId: "instance_2",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          _id: "affinity_3",
          sessionId: "session_3",
          workspaceId: "workspace_2",
          executorId: "executor_1",
          assignedInstanceId: "instance_3",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    await clearSessionExecutorAssignment(ctx as any, {
      sessionId: "session_1" as any,
    });
    expect(ctx.tables.sessionExecutorAssignments.map((row) => row._id)).toEqual(["affinity_2", "affinity_3"]);

    const clearedWorkspaceCount = await clearSessionExecutorAssignmentsForWorkspace(ctx as any, {
      workspaceId: "workspace_1" as any,
    });
    expect(clearedWorkspaceCount).toBe(1);
    expect(ctx.tables.sessionExecutorAssignments.map((row) => row._id)).toEqual(["affinity_3"]);

    const clearedExecutorCount = await clearSessionExecutorAssignmentsForExecutor(ctx as any, {
      executorId: "executor_1" as any,
    });
    expect(clearedExecutorCount).toBe(1);
    expect(ctx.tables.sessionExecutorAssignments).toEqual([]);
  });
});
