import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import type { ConvexClient } from "convex/browser";
import type { CompileJobRunner } from "./compile-job-runner";
import type { ExecutorInstanceTokenSource } from "./executor-session";
import type { RevisionWorkerPool } from "./revision-worker-pool";

type Logger = Pick<Console, "log">;

export class AssignedJobSubscriptions {
  private readonly seenJobs = new Set<string>();
  private readonly seenCompileJobs = new Set<string>();
  private runtimeUnsubscribe: (() => void) | null = null;
  private compileUnsubscribe: (() => void) | null = null;
  private removeTokenListener: (() => void) | null = null;

  constructor(
    private readonly args: {
      convex: ConvexClient;
      tokenSource: ExecutorInstanceTokenSource;
      runtimePool: RevisionWorkerPool;
      compileJobRunner: CompileJobRunner;
      logger?: Logger;
    },
  ) {}

  start(): void {
    this.subscribe();
    this.removeTokenListener = this.args.tokenSource.onTokenChange(() => {
      this.args.logger?.log("Resubscribing assigned-job listeners after token rotation");
      this.subscribe();
    });
  }

  stop(): void {
    this.removeTokenListener?.();
    this.removeTokenListener = null;
    this.runtimeUnsubscribe?.();
    this.runtimeUnsubscribe = null;
    this.compileUnsubscribe?.();
    this.compileUnsubscribe = null;
  }

  private subscribe(): void {
    this.runtimeUnsubscribe?.();
    this.compileUnsubscribe?.();

    const instanceToken = this.args.tokenSource.getInstanceToken();
    this.runtimeUnsubscribe = this.args.convex.onUpdate(api.executor.runnableJobs, { instanceToken }, (jobs) => {
      for (const job of jobs) {
        if (this.seenJobs.has(job)) {
          continue;
        }
        this.seenJobs.add(job);
        this.args.runtimePool.enqueue(job as Id<"jobs">).finally(() => {
          setTimeout(() => {
            this.seenJobs.delete(job);
          }, 30_000);
        });
      }
    });

    this.compileUnsubscribe = this.args.convex.onUpdate(
      api.compileJobs.runnableCompileJobs,
      { instanceToken },
      (jobs) => {
        for (const job of jobs) {
          if (this.seenCompileJobs.has(job)) {
            continue;
          }
          this.seenCompileJobs.add(job);
          this.args.compileJobRunner.enqueue(job as Id<"compileJobs">);
          setTimeout(() => {
            this.seenCompileJobs.delete(job);
          }, 30_000);
        }
      },
    );
  }
}
