import type { ChildProcess } from "node:child_process";

import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { generateAdminKey, generateInstanceSecret } from "./keys";
import { normalizeLogger } from "./logger";
import type { ConvexLogger, LogLevel } from "./logger.ts";
import {
  detectPackageManager,
  downloadConvexBinary,
  getExecCommand,
  killProcessOnPort,
  loadPersistedKeys,
  savePersistedKeys,
  waitForHttpOk,
} from "./utils";

/**
 * Options for creating a ConvexBackend instance.
 */
export interface ConvexBackendOptions {
  /** The instance name for the Convex backend (defaults to "convex-local") */
  instanceName?: string | undefined;
  /** The instance secret for the Convex backend (auto-generated if not provided) */
  instanceSecret?: string | undefined;
  /** The admin key for authenticating with the Convex backend (auto-generated if not provided) */
  adminKey?: string | undefined;
  /** Port for the backend (dynamically assigned if not provided, starting from 3210) */
  port?: number | undefined;
  /** Port for the site proxy (dynamically assigned if not provided) */
  siteProxyPort?: number | undefined;
  /** The project directory containing the Convex functions (defaults to cwd) */
  projectDir?: string | undefined;
  /** Timeout for deploy operations in milliseconds (defaults to 60000) */
  deployTimeout?: number | undefined;
  /** Timeout for backend health check in milliseconds (defaults to 10000) */
  healthCheckTimeout?: number | undefined;
  /** Pin to a specific Convex backend version (e.g., "precompiled-2024-12-17") */
  binaryVersion?: string | undefined;
  /** Directory to cache the Convex binary (defaults to ~/.convex-local-backend/releases) */
  binaryCacheDir?: string | undefined;
  /** How long to use a cached binary before checking for updates in milliseconds (defaults to 7 days) */
  binaryCacheTtl?: number | undefined;

  backendLogFile?: string | undefined;
}

export async function launchConvexBackend(
  { logger, ...options }: ConvexBackendOptions & { logger?: ConvexLogger },
  storageDir: string,
): Promise<ConvexBackend> {
  const backend = new ConvexBackend(options, logger);
  await backend.startBackend(storageDir);
  return backend;
}

export class ConvexBackend {
  /** The port the backend is listening on */
  public port: number | undefined;
  /** The port for the site proxy */
  public siteProxyPort: number | undefined;
  /** The backend process */
  public process: ChildProcess | undefined;
  /** The backend URL */
  public backendUrl?: string;

  private readonly projectDir: string;
  public backendDir: string;
  public readonly instanceName: string;
  private instanceSecret!: string;
  public adminKey!: string;
  private readonly logger: ConvexLogger;
  private readonly deployTimeout: number;
  private readonly healthCheckTimeout: number;
  public readonly binaryVersion: string | undefined;
  private readonly binaryCacheDir: string | undefined;
  private readonly binaryCacheTtl: number;
  private readonly backendLogFile: string | undefined;
  private readonly providedInstanceSecret: string | undefined;
  private readonly providedAdminKey: string | undefined;
  /**
   * Create a new ConvexBackend instance.
   *
   * @param options - Configuration options for the backend
   * @param logger - Optional logger configuration:
   *   - `undefined`: Uses default logger at "info" level
   *   - `LogLevel` string ("error", "warn", "info", "silent"): Uses built-in logger at specified level
   *   - `ConvexLogger` object: Uses the provided custom logger
   *
   * @example
   * ```ts
   * // Default logging
   * new ConvexBackend({})
   *
   * // Only show errors
   * new ConvexBackend({}, "error")
   *
   * // Silent mode
   * new ConvexBackend({}, "silent")
   *
   * // Custom logger
   * new ConvexBackend({}, {
   *   info: (msg) => myLogger.info(msg),
   *   warn: (msg) => myLogger.warn(msg),
   *   error: (msg) => myLogger.error(msg),
   * })
   * ```
   */
  constructor(options: ConvexBackendOptions, logger?: ConvexLogger | LogLevel) {
    this.logger = normalizeLogger(logger);
    this.projectDir = options.projectDir ?? process.cwd();
    this.backendDir = path.join(this.projectDir, ".convex", crypto.randomBytes(16).toString("hex"));
    this.deployTimeout = options.deployTimeout ?? 60000;
    this.healthCheckTimeout = options.healthCheckTimeout ?? 10000;
    this.binaryVersion = options.binaryVersion ?? packageJson.convexBackendVersion;
    this.binaryCacheDir = options.binaryCacheDir;
    this.binaryCacheTtl = options.binaryCacheTtl ?? 7 * 24 * 60 * 60 * 1000; // 7 days
    this.backendLogFile = options.backendLogFile;
    // Use fixed ports if provided
    this.port = options.port ?? 3210;
    this.siteProxyPort = options.siteProxyPort ?? 3211;
    this.backendUrl = `http://127.0.0.1:${this.port}`;

    this.instanceName = options.instanceName ?? "convex-local";

    // Store provided keys for later use - actual key initialization happens in initializeKeys()
    this.providedInstanceSecret = options.instanceSecret;
    this.providedAdminKey = options.adminKey;
  }

  /**
   * Initialize keys from persisted storage, provided options, or generate new ones.
   * Must be called before starting the backend.
   */
  private initializeKeys(storageDir: string): void {
    // If both keys were explicitly provided, use them
    if (this.providedInstanceSecret && this.providedAdminKey) {
      this.instanceSecret = this.providedInstanceSecret;
      this.adminKey = this.providedAdminKey;
      return;
    }

    // Try to load persisted keys from the storage directory
    const persistedKeys = loadPersistedKeys(storageDir, this.instanceName);
    if (persistedKeys) {
      this.instanceSecret = persistedKeys.instanceSecret;
      this.adminKey = persistedKeys.adminKey;
      this.logger.info("Loaded persisted keys from storage", { timestamp: true });
      return;
    }

    // Generate new keys and persist them
    this.instanceSecret = generateInstanceSecret();
    this.adminKey = generateAdminKey(this.instanceSecret, this.instanceName);
    savePersistedKeys(storageDir, this.instanceSecret);
    this.logger.info("Generated and persisted new keys", { timestamp: true });
  }

  /**
   * Get the admin key for authenticating with the Convex backend.
   * Use this to create your own ConvexClient with admin privileges.
   */
  public getAdminKey(): string {
    return this.adminKey;
  }

  /**
   * Spawn the backend process.
   * Returns immediately after spawning - does not wait for the backend to be ready.
   * Call waitForReady() to ensure the backend is accepting connections.
   * @param backendDir - The directory to store backend state
   */
  async spawn(backendDir: string): Promise<void> {
    // Kill any existing process on the port before spawning
    if (this.port) {
      await killProcessOnPort(this.port, this.logger);
    }

    const storageDir = path.join(backendDir, "convex_local_storage");
    fs.mkdirSync(storageDir, { recursive: true });

    const sqlitePath = path.join(backendDir, "convex_local_backend.sqlite3");
    const convexBinary = await downloadConvexBinary(
      {
        cacheTtlMs: this.binaryCacheTtl,
        version: this.binaryVersion,
        cacheDir: this.binaryCacheDir,
      },
      this.logger,
    );

    this.process = childProcess.spawn(
      convexBinary,
      [
        "--port",
        String(this.port),
        "--site-proxy-port",
        String(this.siteProxyPort),
        "--instance-name",
        this.instanceName,
        "--instance-secret",
        this.instanceSecret,
        "--local-storage",
        storageDir,
        sqlitePath,
      ],
      {
        cwd: backendDir,
        stdio: this.backendLogFile ? "pipe" : "ignore",
      },
    );

    if (this.backendLogFile) {
      const logFile = fs.createWriteStream(this.backendLogFile);
      this.process.stdout?.pipe(logFile);
      this.process.stderr?.pipe(logFile);
    }

    if (!this.process.pid) {
      throw new Error("Convex process failed to start - no PID assigned");
    }

    this.logger.info(`Backend spawned on port ${this.port} (waiting for ready...)`, {
      timestamp: true,
    });
  }

  /**
   * Wait for the backend to be ready to accept connections.
   * Call this after spawn() before making any API calls.
   */
  async waitForReady(): Promise<void> {
    await this.healthCheck();

    this.logger.info("Backend ready", { timestamp: true });
    this.logger.info(`  Instance name:   ${this.instanceName}`, { timestamp: true });
    this.logger.info(`  Backend version: ${this.binaryVersion}`, { timestamp: true });
    this.logger.info(`  Admin key:       ${this.adminKey}`, { timestamp: true });
    this.logger.info(`  Backend URL:     ${this.backendUrl}`, { timestamp: true });
  }

  /**
   * Start the backend process and wait for it to be ready.
   * Convenience method that combines spawn() and waitForReady().
   * @param storageDir - The directory to store backend state
   */
  async startBackend(storageDir: string): Promise<void> {
    // Update backendDir to match the actual storage location
    this.backendDir = storageDir;
    // Initialize keys before spawning (loads from storage or generates new ones)
    this.initializeKeys(storageDir);
    await this.spawn(storageDir);
    await this.waitForReady();
  }

  private async healthCheck(): Promise<void> {
    if (!this.port) throw new Error("Port not set for health check");
    const url = `http://localhost:${this.port}/version`;
    await waitForHttpOk(url, this.healthCheckTimeout);
  }

  /**
   * Deploy Convex functions to the backend.
   */
  deploy(): void {
    if (!this.port) throw new Error("Backend not started");

    const backendUrl = `http://localhost:${this.port}`;

    const pm = detectPackageManager();
    const { cmd, args } = getExecCommand(pm);

    const deployResult = childProcess.spawnSync(
      cmd,
      [...args, "convex", "deploy", "--admin-key", this.adminKey, "--url", backendUrl],
      {
        cwd: this.projectDir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: this.deployTimeout,
      },
    );

    if (deployResult.error) {
      throw new Error(`Failed to spawn convex deploy: ${deployResult.error.message}`);
    }

    // Log stderr (convex deploy writes progress to stderr)
    const output = (deployResult.stdout + deployResult.stderr).trim();
    if (output) {
      this.logger.info(`Deploy output:\n${output}`, { timestamp: true });
    }

    if (deployResult.status !== 0) {
      // Error details already logged above, just throw concise message
      throw new Error(`Deploy failed with exit code ${deployResult.status}`);
    }
  }

  /**
   * Set an environment variable on the backend.
   */
  async setEnv(name: string, value: string): Promise<void> {
    if (!this.port) throw new Error("Backend not started");

    const backendUrl = `http://localhost:${this.port}`;

    const response = await fetch(`${backendUrl}/api/v1/update_environment_variables`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Convex ${this.adminKey}`,
      },
      body: JSON.stringify({
        changes: [{ name, value }],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to set ${name} env via API (${response.status}): ${errorText}`);
    }
  }

  /**
   * Run a Convex function (query, mutation, or action) on the backend.
   * @param functionName - The function path (e.g., "myModule:myFunction")
   * @param args - Arguments to pass to the function
   * @returns The function result
   */
  async runFunction(functionName: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.port) throw new Error("Backend not started");

    const backendUrl = `http://localhost:${this.port}`;

    const response = await fetch(`${backendUrl}/api/function`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Convex-Client": "convex-vite-plugin",
        Authorization: `Convex ${this.adminKey}`,
      },
      body: JSON.stringify({
        path: functionName,
        format: "json",
        args,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to run ${functionName} (${response.status}): ${errorText}`);
    }

    const result = (await response.json()) as { status?: string; value?: unknown; errorMessage?: string };
    if (result.status === "error") {
      throw new Error(`Function ${functionName} failed: ${result.errorMessage ?? "Unknown error"}`);
    }
    return result.value;
  }

  /**
   * Stop the backend process.
   * @param cleanup - Whether to delete the backend state directory
   */
  async stop(cleanup = false): Promise<void> {
    const child = this.process;
    this.process = undefined;

    if (!child || child.pid === undefined) {
      if (cleanup) {
        this.logger.info("Cleaning up backend files...", { timestamp: true });
        await fsp.rm(this.backendDir, { recursive: true, force: true });
      }
      return;
    }

    const pid = child.pid;
    const isAlive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already dead
      if (cleanup) {
        this.logger.info("Cleaning up backend files...", { timestamp: true });
        await fsp.rm(this.backendDir, { recursive: true });
      }
      return;
    }

    const GRACEFUL_TIMEOUT_MS = 5000;
    const POLL_INTERVAL_MS = 100;
    let elapsed = 0;
    while (isAlive() && elapsed < GRACEFUL_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      elapsed += POLL_INTERVAL_MS;
    }

    if (isAlive()) {
      this.logger.warn(`Backend process ${pid} did not exit gracefully, force killing...`);
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already dead
      }
    }

    if (cleanup) {
      this.logger.info("Cleaning up backend files...", { timestamp: true });
      await fsp.rm(this.backendDir, { recursive: true });
    }
  }
}
