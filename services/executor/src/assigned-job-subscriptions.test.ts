import { describe, expect, it } from "bun:test";
import { AssignedJobSubscriptions } from "./assigned-job-subscriptions";

function createTokenSource(initialToken: string) {
  let currentToken = initialToken;
  const listeners = new Set<(token: string) => void>();
  return {
    source: {
      getInstanceToken: () => currentToken,
      onTokenChange: (listener: (token: string) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    rotate(nextToken: string) {
      currentToken = nextToken;
      for (const listener of listeners) {
        listener(nextToken);
      }
    },
  };
}

describe("AssignedJobSubscriptions", () => {
  it("resubscribes both queues when the executor token rotates", async () => {
    const tokenSource = createTokenSource("instance-token-1");
    const subscriptions: Array<{
      args: { instanceToken: string };
      callback: (jobs: string[]) => void;
      closed: boolean;
    }> = [];
    const runtimeJobs: string[] = [];
    const compileJobs: string[] = [];

    const manager = new AssignedJobSubscriptions({
      convex: {
        onUpdate: (_ref: unknown, args: { instanceToken: string }, callback: (jobs: string[]) => void) => {
          const entry = { args, callback, closed: false };
          subscriptions.push(entry);
          return () => {
            entry.closed = true;
          };
        },
      } as any,
      tokenSource: tokenSource.source,
      runtimePool: {
        enqueue: async (jobId: string) => {
          runtimeJobs.push(jobId);
        },
      } as any,
      compileJobRunner: {
        enqueue: (jobId: string) => {
          compileJobs.push(jobId);
        },
      } as any,
    });

    manager.start();
    expect(subscriptions.map((entry) => entry.args.instanceToken)).toEqual(["instance-token-1", "instance-token-1"]);

    subscriptions[0]!.callback(["job-1", "job-1"]);
    subscriptions[1]!.callback(["compile-1", "compile-1"]);
    await Promise.resolve();

    expect(runtimeJobs).toEqual(["job-1"]);
    expect(compileJobs).toEqual(["compile-1"]);

    tokenSource.rotate("instance-token-2");

    expect(subscriptions[0]!.closed).toBe(true);
    expect(subscriptions[1]!.closed).toBe(true);
    expect(subscriptions.slice(2).map((entry) => entry.args.instanceToken)).toEqual([
      "instance-token-2",
      "instance-token-2",
    ]);

    manager.stop();
    expect(subscriptions[2]!.closed).toBe(true);
    expect(subscriptions[3]!.closed).toBe(true);
  });
});
