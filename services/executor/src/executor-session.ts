import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import type { ConvexClient } from "convex/browser";

const DEFAULT_HEARTBEAT_RETRY_MS = 1_000;
const LEASE_EXPIRY_SAFETY_WINDOW_MS = 1_000;

type ExecutorSessionState = {
  executorId: Id<"executors">;
  instanceId: Id<"executorInstances">;
  instanceToken: string;
  instanceTokenExpiresAt: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  lastHeartbeatAt: number;
  expiresAt: number;
};

type SessionListener = (instanceToken: string) => void;
type FatalListener = (error: Error) => void;

type Logger = Pick<Console, "log" | "warn" | "error">;

export type ExecutorInstanceTokenSource = {
  getInstanceToken(): string;
  onTokenChange(listener: SessionListener): () => void;
};

type RegisterExecutorInstanceResult = {
  executorId: Id<"executors">;
  instanceId: Id<"executorInstances">;
  instanceToken: string;
  instanceTokenExpiresAt: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
};

type HeartbeatExecutorInstanceResult = {
  executorId: Id<"executors">;
  instanceId: Id<"executorInstances">;
  instanceToken?: string;
  instanceTokenExpiresAt: number;
  lastHeartbeatAt: number;
  expiresAt: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
};

export class ExecutorSession implements ExecutorInstanceTokenSource {
  private state: ExecutorSessionState | null = null;
  private readonly tokenListeners = new Set<SessionListener>();
  private readonly fatalListeners = new Set<FatalListener>();
  private readonly now: () => number;
  private readonly schedule: typeof setTimeout;
  private readonly cancel: typeof clearTimeout;
  private readonly logger: Logger;
  private readonly heartbeatRetryMs: number;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatInFlight = false;
  private stopped = false;

  constructor(
    private readonly args: {
      convex: ConvexClient;
      bootstrapToken: string;
      hostname: string;
      version: string;
      heartbeatRetryMs?: number;
      now?: () => number;
      schedule?: typeof setTimeout;
      cancel?: typeof clearTimeout;
      logger?: Logger;
    },
  ) {
    this.now = args.now ?? Date.now;
    this.schedule = args.schedule ?? setTimeout;
    this.cancel = args.cancel ?? clearTimeout;
    this.logger = args.logger ?? console;
    this.heartbeatRetryMs = args.heartbeatRetryMs ?? DEFAULT_HEARTBEAT_RETRY_MS;
  }

  async start(): Promise<void> {
    if (this.stopped) {
      throw new Error("Executor session has been stopped");
    }
    if (this.state) {
      return;
    }

    const registered = await this.registerInstance();
    this.applyRegisteredState(registered);
    this.logger.log(
      `Registered executor instance ${registered.instanceId} for executor ${registered.executorId} on ${this.args.hostname}`,
    );
    this.scheduleNextHeartbeat(registered.heartbeatIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeatTimer) {
      this.cancel(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  getInstanceToken(): string {
    if (!this.state) {
      throw new Error("Executor session is not registered");
    }
    return this.state.instanceToken;
  }

  getState() {
    return this.state;
  }

  onTokenChange(listener: SessionListener): () => void {
    this.tokenListeners.add(listener);
    return () => {
      this.tokenListeners.delete(listener);
    };
  }

  onFatal(listener: FatalListener): () => void {
    this.fatalListeners.add(listener);
    return () => {
      this.fatalListeners.delete(listener);
    };
  }

  private scheduleNextHeartbeat(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    if (this.heartbeatTimer) {
      this.cancel(this.heartbeatTimer);
    }
    this.heartbeatTimer = this.schedule(
      () => {
        void this.runHeartbeat();
      },
      Math.max(1, Math.floor(delayMs)),
    );
  }

  private async runHeartbeat(): Promise<void> {
    if (this.stopped || this.heartbeatInFlight || !this.state) {
      return;
    }

    this.heartbeatInFlight = true;
    try {
      const heartbeat = (await this.args.convex.mutation(api.executors.heartbeatExecutorInstance, {
        instanceToken: this.state.instanceToken,
        hostname: this.args.hostname,
        version: this.args.version,
      })) as HeartbeatExecutorInstanceResult;

      const previousToken = this.state.instanceToken;
      const nextToken = heartbeat.instanceToken ?? previousToken;
      this.state = {
        executorId: heartbeat.executorId,
        instanceId: heartbeat.instanceId,
        instanceToken: nextToken,
        instanceTokenExpiresAt: heartbeat.instanceTokenExpiresAt,
        heartbeatIntervalMs: heartbeat.heartbeatIntervalMs,
        heartbeatTimeoutMs: heartbeat.heartbeatTimeoutMs,
        lastHeartbeatAt: heartbeat.lastHeartbeatAt,
        expiresAt: heartbeat.expiresAt,
      };

      if (nextToken !== previousToken) {
        this.logger.log(`Rotated executor instance token for ${heartbeat.instanceId}`);
        for (const listener of this.tokenListeners) {
          listener(nextToken);
        }
      }

      this.scheduleNextHeartbeat(heartbeat.heartbeatIntervalMs);
    } catch (error) {
      await this.handleHeartbeatFailure(toError(error));
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  private async handleHeartbeatFailure(error: Error): Promise<void> {
    if (!this.state) {
      this.fail(error);
      return;
    }

    if (isReRegisterableHeartbeatError(error)) {
      await this.reRegisterAfterHeartbeatFailure(error);
      return;
    }

    if (isFatalHeartbeatError(error)) {
      this.fail(error);
      return;
    }

    const now = this.now();
    const nextAttemptAt = now + this.heartbeatRetryMs;
    if (nextAttemptAt >= this.state.expiresAt - LEASE_EXPIRY_SAFETY_WINDOW_MS) {
      this.fail(new Error(`Executor heartbeat failed before lease expiry: ${error.message}`));
      return;
    }

    this.logger.warn(`Executor heartbeat failed, retrying in ${this.heartbeatRetryMs}ms: ${error.message}`);
    this.scheduleNextHeartbeat(this.heartbeatRetryMs);
  }

  private async reRegisterAfterHeartbeatFailure(error: Error): Promise<void> {
    const previousToken = this.state?.instanceToken ?? null;
    this.logger.warn(`Executor heartbeat failed with recoverable lease loss, re-registering: ${error.message}`);

    try {
      const registered = await this.registerInstance();
      this.applyRegisteredState(registered);

      if (previousToken !== registered.instanceToken) {
        for (const listener of this.tokenListeners) {
          listener(registered.instanceToken);
        }
      }

      this.logger.log(
        `Re-registered executor instance ${registered.instanceId} for executor ${registered.executorId} on ${this.args.hostname}`,
      );
      this.scheduleNextHeartbeat(registered.heartbeatIntervalMs);
    } catch (registrationError) {
      this.fail(
        new Error(`Executor failed to re-register after heartbeat lease loss: ${toError(registrationError).message}`),
      );
    }
  }

  private async registerInstance(): Promise<RegisterExecutorInstanceResult> {
    return (await this.args.convex.mutation(api.executors.registerExecutorInstance, {
      bootstrapToken: this.args.bootstrapToken,
      hostname: this.args.hostname,
      version: this.args.version,
    })) as RegisterExecutorInstanceResult;
  }

  private applyRegisteredState(registered: RegisterExecutorInstanceResult): void {
    const now = this.now();
    this.state = {
      executorId: registered.executorId,
      instanceId: registered.instanceId,
      instanceToken: registered.instanceToken,
      instanceTokenExpiresAt: registered.instanceTokenExpiresAt,
      heartbeatIntervalMs: registered.heartbeatIntervalMs,
      heartbeatTimeoutMs: registered.heartbeatTimeoutMs,
      lastHeartbeatAt: now,
      expiresAt: now + registered.heartbeatTimeoutMs,
    };
  }

  private fail(error: Error): void {
    if (this.stopped) {
      return;
    }
    this.stop();
    for (const listener of this.fatalListeners) {
      listener(error);
    }
  }
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

function isFatalHeartbeatError(error: Error): boolean {
  return /Unauthorized|Executor is not active|Executor token version mismatch|Executor instance token expired|Executor instance heartbeat lease expired|Executor instance is not online/i.test(
    error.message,
  );
}

function isReRegisterableHeartbeatError(error: Error): boolean {
  return /Executor instance token expired|Executor instance heartbeat lease expired|Executor instance is not online/i.test(
    error.message,
  );
}
