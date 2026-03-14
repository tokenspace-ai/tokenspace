import { describe, expect, it } from "bun:test";
import {
  buildExecutorUnavailableError,
  countNonterminalAssignments,
  pickPreferredExecutorInstance,
} from "../convex/executorRouting";

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
