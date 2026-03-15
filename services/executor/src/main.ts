#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { Command } from "commander";
import { ConvexClient } from "convex/browser";
import { AssignedJobSubscriptions } from "./assigned-job-subscriptions";
import { CompileJobRunner } from "./compile-job-runner";
import { ExecutorSession } from "./executor-session";
import { RevisionWorkerPool } from "./revision-worker-pool";

function readExecutorVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
  return pkg.version ?? "0.0.0";
}

const program = new Command()
  .name("tokenspace-executor")
  .description("Tokenspace self-hosted executor")
  .version(readExecutorVersion())
  .option("--api <url>", "Tokenspace API URL (env: TOKENSPACE_API_URL or CONVEX_URL)")
  .option("--token <token>", "Bootstrap token (env: TOKENSPACE_TOKEN)")
  .action(async (opts: { api?: string; token?: string }) => {
    const convexUrl = opts.api || process.env.TOKENSPACE_API_URL || process.env.CONVEX_URL;
    if (!convexUrl) {
      return program.error("API URL is required (--api or TOKENSPACE_API_URL)");
    }

    const bootstrapToken = opts.token || process.env.TOKENSPACE_TOKEN;
    if (!bootstrapToken) {
      return program.error("Bootstrap token is required (--token or TOKENSPACE_TOKEN)");
    }

    const executorVersion = readExecutorVersion();
    console.log(`Starting tokenspace executor v${executorVersion}`);

    process.env.TOKENSPACE_API_URL = convexUrl;

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
  });

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

program.parseAsync().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
