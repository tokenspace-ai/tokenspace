import { describe, expect, it } from "bun:test";
import {
  assertWorkspaceExecutorAssignmentState,
  buildExecutorSummary,
  canManageExecutorLifecycle,
  deriveExecutorInstanceHealth,
  isExecutorInstanceHealthy,
} from "../convex/executors";

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
