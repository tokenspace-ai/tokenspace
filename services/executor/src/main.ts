import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { ConvexClient } from "convex/browser";
import { AssignedJobSubscriptions } from "./assigned-job-subscriptions";
import { CompileJobRunner } from "./compile-job-runner";
import { ExecutorSession } from "./executor-session";
import { RevisionWorkerPool } from "./revision-worker-pool";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readExecutorVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
  return pkg.version ?? "0.0.0";
}

async function main() {
  const convexUrl = process.env.TOKENSPACE_API_URL || requireEnv("CONVEX_URL");
  const bootstrapToken = requireEnv("TOKENSPACE_TOKEN");
  const executorVersion = readExecutorVersion();
  console.log(`Starting tokenspace executor with API URL=${convexUrl}`);

  const convex = new ConvexClient(convexUrl);
  const session = new ExecutorSession({
    convex,
    bootstrapToken,
    hostname: hostname(),
    version: executorVersion,
  });
  await session.start();

  RevisionWorkerPool.initialize({ convex, tokenSource: session });
  const pool = RevisionWorkerPool.get();
  const compileJobRunner = new CompileJobRunner(convex, session);
  const subscriptions = new AssignedJobSubscriptions({
    convex,
    tokenSource: session,
    runtimePool: pool,
    compileJobRunner,
    logger: console,
  });
  subscriptions.start();

  const fatalPromise = new Promise<never>((_, reject) => {
    session.onFatal((error) => {
      reject(error);
    });
  });

  try {
    await Promise.race([waitForSignal(), fatalPromise]);
  } finally {
    console.log("Shutting down...");
    subscriptions.stop();
    session.stop();
    pool.shutdown();
  }
}

async function waitForSignal() {
  return new Promise((resolve) => {
    const finish = () => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolve(true);
    };
    process.on("SIGINT", finish);
    process.on("SIGTERM", finish);
  });
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
