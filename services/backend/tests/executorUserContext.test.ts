import { describe, expect, it } from "bun:test";

process.env.WORKOS_CLIENT_ID ??= "test-client-id";

const { resolveJobCallerUserId } = await import("../convex/executor");

describe("executor user context", () => {
  it("resolves the caller from a session-backed job", async () => {
    const userId = await resolveJobCallerUserId(
      {
        db: {
          get: async () => ({ userId: "session-user" }),
        },
      } as any,
      {
        sessionId: "session-1",
      } as any,
    );

    expect(userId).toBe("session-user");
  });

  it("resolves the caller from a thread-backed job", async () => {
    const userId = await resolveJobCallerUserId(
      {
        runQuery: async () => ({ userId: "thread-user" }),
      } as any,
      {
        threadId: "thread-1",
      } as any,
    );

    expect(userId).toBe("thread-user");
  });

  it("returns null when a job has no user-backed context", async () => {
    const userId = await resolveJobCallerUserId(
      {
        runQuery: async () => null,
      } as any,
      {} as any,
    );

    expect(userId).toBeNull();
  });
});
