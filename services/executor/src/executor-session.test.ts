import { describe, expect, it } from "bun:test";
import { ExecutorSession } from "./executor-session";

function createScheduler() {
  const queue: Array<() => void | Promise<void>> = [];
  return {
    schedule: (fn: () => void | Promise<void>) => {
      queue.push(fn);
      return queue.length as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: () => {},
    async runNext() {
      const next = queue.shift();
      if (!next) {
        throw new Error("No scheduled task");
      }
      await next();
    },
    get size() {
      return queue.length;
    },
  };
}

describe("ExecutorSession", () => {
  it("registers and rotates the instance token on heartbeat", async () => {
    const scheduler = createScheduler();
    const tokenChanges: string[] = [];
    const session = new ExecutorSession({
      convex: {
        mutation: async (_ref: unknown, args: Record<string, unknown>) => {
          if ("bootstrapToken" in args) {
            return {
              executorId: "executor_1",
              instanceId: "instance_1",
              instanceToken: "instance-token-1",
              instanceTokenExpiresAt: 10_000,
              heartbeatIntervalMs: 5_000,
              heartbeatTimeoutMs: 15_000,
            };
          }
          return {
            executorId: "executor_1",
            instanceId: "instance_1",
            instanceToken: "instance-token-2",
            instanceTokenExpiresAt: 20_000,
            lastHeartbeatAt: 2_000,
            expiresAt: 17_000,
            heartbeatIntervalMs: 5_000,
            heartbeatTimeoutMs: 15_000,
          };
        },
      } as any,
      bootstrapToken: "bootstrap-token",
      hostname: "executor-host",
      version: "1.2.3",
      schedule: scheduler.schedule as typeof setTimeout,
      cancel: scheduler.cancel as typeof clearTimeout,
      logger: { log() {}, warn() {}, error() {} },
    });

    session.onTokenChange((token) => tokenChanges.push(token));

    await session.start();
    expect(session.getInstanceToken()).toBe("instance-token-1");
    expect(scheduler.size).toBe(1);

    await scheduler.runNext();
    await Promise.resolve();

    expect(session.getInstanceToken()).toBe("instance-token-2");
    expect(tokenChanges).toEqual(["instance-token-2"]);
  });

  it("retries transient heartbeat failures before lease expiry", async () => {
    const scheduler = createScheduler();
    let now = 1_000;
    let heartbeatAttempts = 0;
    const fatals: string[] = [];
    const session = new ExecutorSession({
      convex: {
        mutation: async (_ref: unknown, args: Record<string, unknown>) => {
          if ("bootstrapToken" in args) {
            return {
              executorId: "executor_1",
              instanceId: "instance_1",
              instanceToken: "instance-token-1",
              instanceTokenExpiresAt: 10_000,
              heartbeatIntervalMs: 5_000,
              heartbeatTimeoutMs: 15_000,
            };
          }
          heartbeatAttempts += 1;
          if (heartbeatAttempts === 1) {
            throw new Error("network timeout");
          }
          return {
            executorId: "executor_1",
            instanceId: "instance_1",
            instanceToken: "instance-token-1",
            instanceTokenExpiresAt: 11_000,
            lastHeartbeatAt: 2_000,
            expiresAt: 17_000,
            heartbeatIntervalMs: 5_000,
            heartbeatTimeoutMs: 15_000,
          };
        },
      } as any,
      bootstrapToken: "bootstrap-token",
      hostname: "executor-host",
      version: "1.2.3",
      now: () => now,
      schedule: scheduler.schedule as typeof setTimeout,
      cancel: scheduler.cancel as typeof clearTimeout,
      logger: { log() {}, warn() {}, error() {} },
    });
    session.onFatal((error) => fatals.push(error.message));

    await session.start();
    await scheduler.runNext();
    await Promise.resolve();
    expect(fatals).toEqual([]);
    expect(scheduler.size).toBe(1);

    now += 1_000;
    await scheduler.runNext();
    await Promise.resolve();
    expect(session.getInstanceToken()).toBe("instance-token-1");
    expect(fatals).toEqual([]);
  });

  it("fails immediately on fatal auth-style heartbeat errors", async () => {
    const scheduler = createScheduler();
    const fatals: string[] = [];
    const session = new ExecutorSession({
      convex: {
        mutation: async (_ref: unknown, args: Record<string, unknown>) => {
          if ("bootstrapToken" in args) {
            return {
              executorId: "executor_1",
              instanceId: "instance_1",
              instanceToken: "instance-token-1",
              instanceTokenExpiresAt: 10_000,
              heartbeatIntervalMs: 5_000,
              heartbeatTimeoutMs: 15_000,
            };
          }
          throw new Error("Executor token version mismatch");
        },
      } as any,
      bootstrapToken: "bootstrap-token",
      hostname: "executor-host",
      version: "1.2.3",
      schedule: scheduler.schedule as typeof setTimeout,
      cancel: scheduler.cancel as typeof clearTimeout,
      logger: { log() {}, warn() {}, error() {} },
    });
    session.onFatal((error) => fatals.push(error.message));

    await session.start();
    await scheduler.runNext();
    await Promise.resolve();

    expect(fatals).toEqual(["Executor token version mismatch"]);
  });
});
