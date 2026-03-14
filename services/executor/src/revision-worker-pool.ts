import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import type { TokenspaceError } from "@tokenspace/sdk";
import type { ConvexClient } from "convex/browser";
import { ensureRevisionEnv } from "./revision-env";
import type { ToolOutputResult } from "./tool-output";
import { type ChildToParentMessage, encodeMessage } from "./worker-protocol";

type JobId = Id<"jobs">;

type StartJobResult = {
  code: string;
  language: "typescript" | "bash";
  sessionId?: string | null;
  cwd?: string | null;
  approvals?: Array<{ action: string; data?: any }>;
  bundleUrl?: string | null;
  depsUrl?: string | null;
  timeoutMs?: number;
  status?: "running" | "canceled";
};

type SerializableJobError = { message: string; stack?: string; details?: string; data?: Record<string, unknown> };

type PoolConfig = {
  maxWorkersPerRevision: number;
  workerIdleTtlMs: number;
  jobLeaseMs: number;
  heartbeatIntervalMs: number;
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function nowMs(): number {
  return Date.now();
}

function toSerializableError(error: unknown): SerializableJobError {
  const maybe = error as Partial<TokenspaceError> | undefined;
  if (maybe && typeof maybe === "object" && typeof maybe.message === "string") {
    const withDetails =
      "details" in maybe || "data" in maybe
        ? {
            message: maybe.message,
            stack: typeof maybe.stack === "string" ? maybe.stack : undefined,
            details: typeof (maybe as any).details === "string" ? (maybe as any).details : undefined,
            data:
              typeof (maybe as any).data === "object" ? ((maybe as any).data as Record<string, unknown>) : undefined,
          }
        : { message: maybe.message, stack: typeof maybe.stack === "string" ? maybe.stack : undefined };
    return withDetails;
  }
  if (error instanceof Error) return { message: error.message, stack: error.stack };
  return { message: String(error) };
}

class WorkerProcess {
  readonly revisionId: string;
  readonly workerId: string;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly idleTtlMs: number;
  private alive = true;

  private buffer = "";
  private ready = false;
  private inflight: {
    requestId: string;
    jobId: string;
    resolve: (result: ToolOutputResult) => void;
    reject: (error: SerializableJobError) => void;
  } | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(revisionId: string, workerId: string, idleTtlMs: number) {
    this.revisionId = revisionId;
    this.workerId = workerId;
    this.idleTtlMs = idleTtlMs;

    const bun = process.execPath;
    const workerPath = join(import.meta.dir, "worker.ts");

    this.child = spawn(bun, ["run", workerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
      },
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onStdoutChunk(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      process.stderr.write(`[worker:${this.revisionId}] ${chunk}`);
    });
    this.child.on("exit", (code, signal) => {
      this.alive = false;
      if (this.inflight) {
        const { reject } = this.inflight;
        this.inflight = null;
        reject({
          message: `Worker exited unexpectedly (code=${code ?? "null"} signal=${signal ?? "null"})`,
        });
      }
    });
  }

  isAlive(): boolean {
    return this.alive;
  }

  async init(): Promise<void> {
    if (this.ready) return;
    const requestId = `${this.workerId}:init:${randomId()}`;
    await this.sendAndWaitReady(requestId);
  }

  private sendAndWaitReady(requestId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Worker init timed out"));
      }, 10_000);

      const onReady = (message: ChildToParentMessage) => {
        if (message.type !== "ready") return false;
        if (message.requestId !== requestId) return false;
        clearTimeout(timeout);
        this.ready = true;
        resolve();
        return true;
      };

      const prevHandler = this.messageHandler;
      this.messageHandler = (message) => {
        if (onReady(message)) {
          this.messageHandler = prevHandler;
          return;
        }
        prevHandler?.(message);
      };

      this.child.stdin.write(
        encodeMessage({
          type: "init",
          requestId,
          revisionId: this.revisionId,
        }),
      );
    });
  }

  async exec(args: {
    jobId: JobId;
    code: string;
    language: "typescript" | "bash";
    bundleUrl?: string | null;
    bundlePath?: string | null;
    sessionId?: string | null;
    approvals?: Array<{ action: string; data?: any }>;
    cwd?: string | null;
    timeoutMs: number;
  }): Promise<ToolOutputResult> {
    await this.init();
    this.cancelIdleTimer();

    if (this.inflight) {
      throw new Error("Worker is already executing a job");
    }

    const requestId = `${this.workerId}:exec:${randomId()}`;
    const jobId = String(args.jobId);

    return await new Promise<ToolOutputResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.terminate();
        reject({ message: `Execution timed out after ${args.timeoutMs}ms` });
      }, args.timeoutMs);

      this.inflight = {
        requestId,
        jobId,
        resolve: (result) => {
          clearTimeout(timer);
          this.inflight = null;
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.inflight = null;
          reject(error);
        },
      };

      this.child.stdin.write(
        encodeMessage({
          type: "exec",
          requestId,
          jobId,
          revisionId: this.revisionId,
          language: args.language,
          code: args.code,
          bundleUrl: args.bundleUrl,
          bundlePath: args.bundlePath,
          sessionId: args.sessionId,
          approvals: args.approvals,
          cwd: args.cwd,
          timeoutMs: args.timeoutMs,
        }),
      );
    });
  }

  markIdle(onIdleExpired: () => void) {
    this.cancelIdleTimer();
    this.idleTimer = setTimeout(() => {
      onIdleExpired();
    }, this.idleTtlMs);
  }

  terminate() {
    if (!this.alive) return;
    this.alive = false;
    this.cancelIdleTimer();
    this.child.kill("SIGKILL");
  }

  private cancelIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private messageHandler: ((message: ChildToParentMessage) => void) | null = null;

  private onStdoutChunk(chunk: string) {
    this.buffer += chunk;
    let idx = this.buffer.indexOf("\n");
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let message: ChildToParentMessage;
      try {
        message = JSON.parse(line) as ChildToParentMessage;
      } catch (_e) {
        process.stderr.write(`[worker:${this.revisionId}] failed to parse message: ${line}\n`);
        continue;
      }
      this.onMessage(message);
      idx = this.buffer.indexOf("\n");
    }
  }

  private onMessage(message: ChildToParentMessage) {
    if (this.messageHandler) {
      this.messageHandler(message);
    }

    if (!this.inflight) return;
    if (message.type === "result" && message.requestId === this.inflight.requestId) {
      this.inflight.resolve(message.result);
      return;
    }
    if (message.type === "error" && message.requestId === this.inflight.requestId) {
      this.inflight.reject(message.error);
      return;
    }
  }
}

type RevisionState = {
  revisionId: string;
  queue: JobId[];
  workers: Set<WorkerProcess>;
  idleWorkers: WorkerProcess[];
  draining: boolean;
};

function randomId(): string {
  return Math.random().toString(16).slice(2);
}

export class RevisionWorkerPool {
  private static instance: RevisionWorkerPool | null = null;
  private readonly convex: ConvexClient;
  private readonly instanceToken: string;
  private readonly config: PoolConfig;
  private readonly supervisorId: string;
  private readonly revisions = new Map<string, RevisionState>();
  private readonly revisionEnv = new Map<
    string,
    { bundleUrl: string; depsUrl: string | null; promise: Promise<{ bundlePath: string }> }
  >();

  private constructor(args: { convex: ConvexClient; instanceToken: string; config: PoolConfig }) {
    this.convex = args.convex;
    this.instanceToken = args.instanceToken;
    this.config = args.config;
    this.supervisorId = randomUUID();
  }

  static initialize(args: { convex: ConvexClient; instanceToken: string }) {
    if (RevisionWorkerPool.instance) return;
    const jobLeaseMs = parsePositiveInt(process.env.TOKENSPACE_RUNTIME_JOB_LEASE_MS, 30_000);
    const heartbeatIntervalMs = parsePositiveInt(
      process.env.TOKENSPACE_RUNTIME_JOB_HEARTBEAT_MS,
      Math.floor(jobLeaseMs / 2),
    );
    const config: PoolConfig = {
      maxWorkersPerRevision: parsePositiveInt(process.env.TOKENSPACE_RUNTIME_MAX_WORKERS_PER_REVISION, 2),
      workerIdleTtlMs: parsePositiveInt(process.env.TOKENSPACE_RUNTIME_WORKER_IDLE_TTL_MS, 60_000),
      jobLeaseMs,
      heartbeatIntervalMs,
    };
    RevisionWorkerPool.instance = new RevisionWorkerPool({
      convex: args.convex,
      instanceToken: args.instanceToken,
      config,
    });
  }

  static get(): RevisionWorkerPool {
    if (!RevisionWorkerPool.instance) {
      throw new Error("RevisionWorkerPool not initialized");
    }
    return RevisionWorkerPool.instance;
  }

  async enqueue(jobId: JobId): Promise<void> {
    const job = await this.convex.query(api.executor.getJob, { jobId, instanceToken: this.instanceToken });
    if (!job) return;
    const now = nowMs();
    const reclaimable =
      job.status === "running" && (job.leaseExpiresAt == null || (job.leaseExpiresAt as number) < now);
    if (job.status !== "pending" && !reclaimable) return;
    if (!job.revisionId) {
      return;
    }

    const revisionId = String(job.revisionId);
    const state = this.getOrCreateRevisionState(revisionId);
    state.queue.push(jobId);
    void this.drainRevisionQueue(state);
  }

  private getOrCreateRevisionState(revisionId: string): RevisionState {
    const existing = this.revisions.get(revisionId);
    if (existing) return existing;
    const state: RevisionState = {
      revisionId,
      queue: [],
      workers: new Set(),
      idleWorkers: [],
      draining: false,
    };
    this.revisions.set(revisionId, state);
    return state;
  }

  private async drainRevisionQueue(state: RevisionState): Promise<void> {
    if (state.draining) return;
    state.draining = true;
    try {
      while (state.queue.length > 0) {
        const worker = await this.acquireWorker(state);
        const jobId = state.queue.shift()!;
        void this.runJobOnWorker(state, worker, jobId).finally(() => {
          this.releaseWorker(state, worker);
        });
      }
    } finally {
      state.draining = false;
    }
  }

  private async acquireWorker(state: RevisionState): Promise<WorkerProcess> {
    while (state.idleWorkers.length > 0) {
      const idle = state.idleWorkers.pop()!;
      if (idle.isAlive()) return idle;
      state.workers.delete(idle);
    }

    if (state.workers.size >= this.config.maxWorkersPerRevision) {
      // Wait for the next worker to become idle.
      return await new Promise((resolve) => {
        const check = () => {
          while (state.idleWorkers.length > 0) {
            const w = state.idleWorkers.pop()!;
            if (w.isAlive()) {
              resolve(w);
              return;
            }
            state.workers.delete(w);
          }
          setTimeout(check, 25);
        };
        check();
      });
    }

    const workerId = `${state.revisionId}:${randomId()}`;
    const worker = new WorkerProcess(state.revisionId, workerId, this.config.workerIdleTtlMs);
    state.workers.add(worker);
    await worker.init();
    return worker;
  }

  private releaseWorker(state: RevisionState, worker: WorkerProcess) {
    if (!worker.isAlive()) {
      state.workers.delete(worker);
      return;
    }
    state.idleWorkers.push(worker);
    worker.markIdle(() => {
      // Only scale down if still idle (i.e. still present in idleWorkers).
      const idx = state.idleWorkers.indexOf(worker);
      if (idx === -1) return;
      state.idleWorkers.splice(idx, 1);
      state.workers.delete(worker);
      worker.terminate();
    });

    // If new jobs arrived while a worker was busy, drain again.
    if (state.queue.length > 0) {
      void this.drainRevisionQueue(state);
    }
  }

  private async runJobOnWorker(state: RevisionState, worker: WorkerProcess, jobId: JobId) {
    const startTime = nowMs();
    let details: StartJobResult | null = null;
    try {
      details = (await this.convex.mutation(api.executor.claimJob, {
        job: jobId,
        workerId: this.supervisorId,
        leaseMs: this.config.jobLeaseMs,
        instanceToken: this.instanceToken,
      })) as StartJobResult;
    } catch {
      // Job may have been claimed/processed by another runtime instance.
      return;
    }

    if (details.status && details.status !== "running") {
      return;
    }

    if (!details.bundleUrl) {
      await this.failJob(jobId, { message: "Missing bundleUrl for running job" });
      return;
    }

    let bundlePath: string;
    try {
      const nextDepsUrl = details.depsUrl ?? null;
      const existingEnv = this.revisionEnv.get(state.revisionId);
      const envEntry =
        existingEnv && existingEnv.bundleUrl === details.bundleUrl && existingEnv.depsUrl === nextDepsUrl
          ? existingEnv
          : {
              bundleUrl: details.bundleUrl,
              depsUrl: nextDepsUrl,
              promise: (async () => {
                const env = await ensureRevisionEnv({
                  revisionId: state.revisionId,
                  bundleUrl: details.bundleUrl!,
                  depsUrl: nextDepsUrl,
                });
                return { bundlePath: env.bundlePath };
              })(),
            };
      this.revisionEnv.set(state.revisionId, envEntry);
      bundlePath = (await envEntry.promise).bundlePath;
    } catch (error) {
      await this.failJob(jobId, toSerializableError(error));
      return;
    }

    console.log(
      `Processing job id=${jobId} revision=${state.revisionId} session=${details.sessionId} language=${details.language} approvals=${details.approvals?.length ?? 0}`,
    );

    let stopRequested = false;
    let stopReason: string | undefined;
    let rejectStop: ((error: SerializableJobError) => void) | null = null;
    const stopPromise = new Promise<never>((_, reject) => {
      rejectStop = reject;
    });
    let leaseLost = false;
    let rejectLeaseLost: ((error: SerializableJobError) => void) | null = null;
    const leaseLostPromise = new Promise<never>((_, reject) => {
      rejectLeaseLost = reject;
    });
    const unsubStop = this.convex.onUpdate(api.executor.getJob, { jobId, instanceToken: this.instanceToken }, (job) => {
      if (!job) return;
      if (job.stopRequestedAt && !stopRequested) {
        stopRequested = true;
        stopReason = job.stopReason ?? undefined;
        worker.terminate();
        rejectStop?.({
          message: stopReason ?? "Job canceled",
          data: { errorType: "CANCELED" },
        });
      }
    });

    const heartbeatTimer = setInterval(
      () => {
        void this.convex
          .mutation(api.executor.heartbeatJob, {
            job: jobId,
            workerId: this.supervisorId,
            leaseMs: this.config.jobLeaseMs,
            instanceToken: this.instanceToken,
          })
          .catch((error) => {
            leaseLost = true;
            worker.terminate();
            rejectLeaseLost?.({
              message: "Lost job lease (heartbeat failed)",
              data: { errorType: "LEASE_LOST", error: String(error) },
            });
          });
      },
      Math.max(1_000, this.config.heartbeatIntervalMs),
    );

    try {
      const timeoutMs = typeof details.timeoutMs === "number" ? details.timeoutMs : 5 * 60_000;
      const result = await Promise.race([
        worker.exec({
          jobId,
          code: details.code,
          language: details.language,
          bundleUrl: details.bundleUrl,
          bundlePath,
          approvals: details.approvals,
          sessionId: details.sessionId,
          cwd: details.cwd,
          timeoutMs,
        }),
        stopPromise,
        leaseLostPromise,
      ]);
      await this.convex.mutation(api.executor.completeJob as any, {
        job: jobId,
        result,
        workerId: this.supervisorId,
        instanceToken: this.instanceToken,
      });
      console.log(`Job id=${jobId} completed in ${nowMs() - startTime}ms`);
    } catch (error) {
      const serialized = toSerializableError(error);
      if (leaseLost || (serialized.data as any)?.errorType === "LEASE_LOST") {
        // Another executor likely reclaimed the job; don't attempt to fail/cancel it.
        console.log(`Job id=${jobId} aborted due to lease loss`);
      } else if (stopRequested || (serialized.data as any)?.errorType === "CANCELED") {
        try {
          await this.convex.mutation(api.executor.cancelJob, {
            job: jobId,
            workerId: this.supervisorId,
            instanceToken: this.instanceToken,
            error: serialized,
          });
        } catch (e) {
          process.stderr.write(`[executor] failed to cancelJob id=${jobId}: ${String(e)}\n`);
        }
      } else {
        console.error(`Job id=${jobId} failed in ${nowMs() - startTime}ms`, serialized);
        await this.failJob(jobId, serialized);
      }
    }
    clearInterval(heartbeatTimer);
    unsubStop();
  }

  private async failJob(jobId: JobId, error: SerializableJobError) {
    try {
      await this.convex.mutation(api.executor.failJob, {
        job: jobId,
        workerId: this.supervisorId,
        instanceToken: this.instanceToken,
        error,
      });
    } catch (e) {
      process.stderr.write(`[executor] failed to failJob id=${jobId}: ${String(e)}\n`);
    }
  }
}
