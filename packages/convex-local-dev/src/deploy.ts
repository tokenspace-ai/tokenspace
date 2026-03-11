import { watch } from "node:fs/promises";
import type { ConvexBackend } from "./backend";
import type { ConvexLogger } from "./logger";

interface AutoDeployerOptions {
  convexDir: string;
  watchDirs?: string[];
  logger: ConvexLogger;
}

export class AutoDeployer {
  private deployPending = false;
  private deployRunning = false;
  private lastDeployTime = 0;
  private deployTimer: ReturnType<typeof setTimeout> | null = null;
  private abortController = new AbortController();

  constructor(
    private readonly backend: ConvexBackend,
    private readonly options: AutoDeployerOptions,
  ) {}

  async start(): Promise<void> {
    this.scheduleDeploy();
    this.options.logger.info(`Watching convex directory for changes: ${this.options.convexDir}`);
    await Promise.all([
      this.watchDir(this.options.convexDir),
      ...(this.options.watchDirs?.map((dir) => this.watchDir(dir)) ?? []),
    ]);
  }

  private async watchDir(dir: string): Promise<void> {
    for await (const _ of watch(dir, { recursive: true, signal: this.abortController.signal })) {
      this.scheduleDeploy();
    }
  }

  private scheduleDeploy(): void {
    if (this.deployRunning) {
      this.deployPending = true;
      return;
    }
    if (this.deployTimer == null) {
      const timeSinceLastDeploy = Date.now() - this.lastDeployTime;
      const delay = Math.max(0, 3000 - timeSinceLastDeploy);
      this.deployTimer = setTimeout(this.#deploy.bind(this), delay);
    }
  }

  async #deploy(): Promise<void> {
    this.deployTimer = null;
    if (this.deployRunning) {
      return;
    }
    this.deployRunning = true;
    this.deployPending = false;
    this.lastDeployTime = Date.now();
    try {
      this.options.logger.info("Deploying...");
      this.backend.deploy();
      this.options.logger.info("Deployed successfully");
    } catch (e) {
      this.options.logger.error(`Failed to deploy: ${e}`);
    } finally {
      this.deployRunning = false;
      if (this.deployPending) {
        this.scheduleDeploy();
      }
    }
  }

  async stop(): Promise<void> {
    this.abortController.abort();
    if (this.deployTimer) {
      clearTimeout(this.deployTimer);
      this.deployTimer = null;
    }
    this.deployPending = false;
    this.deployRunning = false;
  }
}
