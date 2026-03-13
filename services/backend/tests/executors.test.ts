import { describe, expect, it } from "bun:test";
import { assertWorkspaceExecutorAssignmentState, isExecutorInstanceHealthy } from "../convex/executors";

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
