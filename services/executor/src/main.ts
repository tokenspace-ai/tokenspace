import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { ConvexClient } from "convex/browser";
import { CompileJobRunner } from "./compile-job-runner";
import { RevisionWorkerPool } from "./revision-worker-pool";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function main() {
  const convexUrl = requireEnv("CONVEX_URL");
  const executorToken = requireEnv("TOKENSPACE_EXECUTOR_TOKEN");
  console.log(`Starting tokenspace executor with CONVEX_URL=${convexUrl}`);

  const convex = new ConvexClient(convexUrl);
  RevisionWorkerPool.initialize({ convex, executorToken });
  const pool = RevisionWorkerPool.get();
  const compileJobRunner = new CompileJobRunner(convex, executorToken);
  const seenJobs = new Set<string>();
  const seenCompileJobs = new Set<string>();

  const unsub = convex.onUpdate(api.executor.runnableJobs, { executorToken }, (jobs) => {
    for (const job of jobs) {
      if (!seenJobs.has(job)) {
        seenJobs.add(job);
        pool.enqueue(job as Id<"jobs">).finally(() => {
          setTimeout(() => {
            seenJobs.delete(job);
          }, 30_000);
        });
      }
    }
  });
  const unsubCompileJobs = convex.onUpdate(api.compileJobs.runnableCompileJobs, { executorToken }, (jobs) => {
    for (const job of jobs) {
      if (!seenCompileJobs.has(job)) {
        seenCompileJobs.add(job);
        compileJobRunner.enqueue(job as Id<"compileJobs">);
        setTimeout(() => {
          seenCompileJobs.delete(job);
        }, 30_000);
      }
    }
  });
  await waitForSignal();
  console.log("Shutting down...");
  unsub();
  unsubCompileJobs();
}

async function waitForSignal() {
  return new Promise((resolve) => {
    process.on("SIGINT", () => {
      resolve(true);
    });
  });
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
