/**
 * Shared test utilities for integration tests.
 *
 * Provides:
 * - IntegrationTestHarness for managing backend and executor lifecycle
 * - Helper functions for common test operations
 * - Type definitions for test context
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type ConvexBackend, launchConvexBackend, watchFunctionLogs } from "@tokenspace/convex-local-dev";
import { type Subprocess, spawn } from "bun";
import { getFunctionName } from "convex/server";
import { api, internal } from "../../../services/backend/convex/_generated/api";

// ============================================================================
// Configuration Constants
// ============================================================================

export const WORKSPACE_SLUG = "testing";
export const WORKSPACE_NAME = "Testing Workspace";
export const EXAMPLE_DIR = path.join(import.meta.dir, "../../../examples/testing");
export const BACKEND_DIR = path.join(import.meta.dir, "../../../services/backend");
export const EXECUTOR_DIR = path.join(import.meta.dir, "../../../services/executor");
export const REPLAY_FIXTURES_DIR = path.join(import.meta.dir, "../fixtures/replay-recordings");

/** Files/directories to skip when reading workspace fixture directory */
export const SKIP_PATTERNS = ["node_modules", ".git", "tsconfig.json"];

/** Binary file extensions to encode as base64 */
export const BINARY_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".pdf", ".zip"];

export const EXECUTOR_TOKEN = "test-executor-token";
const CREDENTIAL_ENCRYPTION_KEY_SEED = "integration-test-master-key-0001";
export const CREDENTIAL_ENCRYPTION_KEY = Buffer.from(CREDENTIAL_ENCRYPTION_KEY_SEED, "utf8").toString("base64");
export const TEST_ENV_CREDENTIAL_NAME = "TOKENSPACE_TEST_ENV_CREDENTIAL";
export const TEST_ENV_CREDENTIAL_VALUE = "env-credential-value";

type ReplayFixture = {
  recordingId: string;
  displayName: string;
  showInReplayModelPicker: boolean;
  playbackSettings?: {
    initialDelayMs?: number;
    chunkDelayMs?: number;
  };
  toolOutcomes?: Array<{
    toolCallId: string;
    toolName: string;
    args?: unknown;
    status: "result" | "error";
    result?: unknown;
    error?: string;
  }>;
  recording: unknown;
};

function toDisplayNameFromFixtureFile(fileName: string): string {
  const baseName = path.basename(fileName, path.extname(fileName));
  const normalized = baseName.replace(/[_-]+/g, " ").trim();
  if (!normalized) {
    return baseName;
  }
  return normalized.replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizePlaybackSettings(input: unknown): ReplayFixture["playbackSettings"] {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const initialDelayMs =
    typeof record.initialDelayMs === "number" && Number.isFinite(record.initialDelayMs) && record.initialDelayMs >= 0
      ? Math.floor(record.initialDelayMs)
      : undefined;
  const chunkDelayMs =
    typeof record.chunkDelayMs === "number" && Number.isFinite(record.chunkDelayMs) && record.chunkDelayMs >= 0
      ? Math.floor(record.chunkDelayMs)
      : undefined;
  if (initialDelayMs === undefined && chunkDelayMs === undefined) {
    return undefined;
  }
  return {
    ...(initialDelayMs !== undefined ? { initialDelayMs } : {}),
    ...(chunkDelayMs !== undefined ? { chunkDelayMs } : {}),
  };
}

function normalizeToolOutcomes(input: unknown): ReplayFixture["toolOutcomes"] {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const outcomes = input
    .map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
      }
      const record = value as Record<string, unknown>;
      if (typeof record.toolCallId !== "string" || typeof record.toolName !== "string") {
        return null;
      }
      const status: "result" | "error" | null =
        record.status === "result" ? "result" : record.status === "error" ? "error" : null;
      if (status === null) {
        return null;
      }
      return {
        toolCallId: record.toolCallId,
        toolName: record.toolName,
        args: record.args,
        status,
        result: record.result,
        error: typeof record.error === "string" ? record.error : undefined,
      };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null);
  return outcomes;
}

function loadReplayFixtures(): ReplayFixture[] {
  if (!fs.existsSync(REPLAY_FIXTURES_DIR)) {
    return [];
  }

  const fixtures: ReplayFixture[] = [];
  const files = fs
    .readdirSync(REPLAY_FIXTURES_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b));

  for (const fileName of files) {
    const fullPath = path.join(REPLAY_FIXTURES_DIR, fileName);
    const content = fs.readFileSync(fullPath, "utf-8");
    const parsed = JSON.parse(content) as {
      recordingId?: unknown;
      playbackSettings?: unknown;
      toolOutcomes?: unknown;
      recording?: unknown;
    };
    if (typeof parsed.recordingId !== "string" || parsed.recording === undefined) {
      throw new Error(`Invalid replay fixture: ${fullPath}`);
    }
    fixtures.push({
      recordingId: parsed.recordingId,
      displayName: toDisplayNameFromFixtureFile(fileName),
      showInReplayModelPicker: true,
      playbackSettings: normalizePlaybackSettings(parsed.playbackSettings),
      toolOutcomes: normalizeToolOutcomes(parsed.toolOutcomes),
      recording: parsed.recording,
    });
  }

  return fixtures;
}

// ============================================================================
// Types
// ============================================================================

export type JobStatus = "pending" | "running" | "completed" | "failed" | "canceled";

export type Job = {
  _id: string;
  status: JobStatus;
  output?: string;
  error?: { message: string; stack?: string; details?: string; data?: Record<string, unknown> };
};

/** Context containing IDs from workspace seeding and compilation */
export interface TestContext {
  workspaceId: string;
  branchId: string;
  revisionId: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Recursively read all files from a directory
 */
export function readFilesRecursively(
  dir: string,
  baseDir: string = dir,
): Array<{ path: string; content: string; binary?: boolean }> {
  const files: Array<{ path: string; content: string; binary?: boolean }> = [];

  if (!fs.existsSync(dir)) {
    return files;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    // Skip patterns
    if (SKIP_PATTERNS.some((pattern) => entry.name === pattern || entry.name.startsWith("."))) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      files.push(...readFilesRecursively(fullPath, baseDir));
    } else if (entry.isFile()) {
      // Encode binary files as base64
      const ext = path.extname(entry.name).toLowerCase();
      if (BINARY_EXTENSIONS.includes(ext)) {
        const content = fs.readFileSync(fullPath).toString("base64");
        files.push({ path: relativePath, content, binary: true });
        continue;
      }

      const content = fs.readFileSync(fullPath, "utf-8");
      files.push({ path: relativePath, content });
    }
  }

  return files;
}

/**
 * Wait for a job to complete or fail
 */
export async function waitForJobCompletion(backend: ConvexBackend, jobId: string, timeoutMs = 30000): Promise<Job> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const job = (await backend.runFunction(getFunctionName(api.executor.getJob), {
      jobId,
      executorToken: EXECUTOR_TOKEN,
    })) as Job | null;
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }
    if (job.status === "completed" || job.status === "failed" || job.status === "canceled") {
      return job;
    }
    // Wait a bit before polling again
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Job ${jobId} timed out after ${timeoutMs}ms`);
}

export async function enqueueAndWaitForRevision(
  backend: ConvexBackend,
  args: {
    workspaceId: string;
    branchId: string;
    includeWorkingState?: boolean;
    workingStateHash?: string;
    userId?: string;
    checkExistingRevision?: boolean;
  },
  timeoutMs = 120000,
): Promise<string> {
  const queued = (await backend.runFunction(getFunctionName(internal.compile.enqueueBranchCompile), {
    workspaceId: args.workspaceId,
    branchId: args.branchId,
    includeWorkingState: args.includeWorkingState,
    workingStateHash: args.workingStateHash,
    userId: args.userId,
    checkExistingRevision: args.checkExistingRevision ?? true,
  })) as { compileJobId?: string; existingRevisionId?: string };

  if (queued.existingRevisionId) {
    return queued.existingRevisionId;
  }

  if (!queued.compileJobId) {
    throw new Error("Compile job was not created");
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const job = (await backend.runFunction(getFunctionName(internal.compileJobs.getCompileJob), {
      compileJobId: queued.compileJobId,
    })) as {
      status: "pending" | "running" | "completed" | "failed" | "canceled";
      revisionId?: string;
      error?: { message?: string };
    } | null;
    if (!job) {
      throw new Error("Compile job not found");
    }
    if (job.status === "completed") {
      if (!job.revisionId) {
        throw new Error("Compile job completed without revision");
      }
      return job.revisionId;
    }
    if (job.status === "failed" || job.status === "canceled") {
      throw new Error(job.error?.message ?? `Compile job ended with status ${job.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Compile job timed out after ${timeoutMs}ms`);
}

// ============================================================================
// Integration Test Harness
// ============================================================================

/**
 * Manages the lifecycle of the Convex backend and executor service for integration tests.
 *
 * Usage:
 * ```ts
 * const harness = new IntegrationTestHarness();
 *
 * beforeAll(async () => {
 *   await harness.setup();
 *   await harness.seedWorkspace();
 * }, 120000);
 *
 * afterAll(async () => {
 *   await harness.teardown();
 * });
 * ```
 */
export class IntegrationTestHarness {
  private backend: ConvexBackend | null = null;
  private executorProcess: Subprocess | null = null;
  private context: TestContext | null = null;
  private functionLogAbortController: AbortController | null = null;
  private functionLogWatcher: Promise<void> | null = null;
  private functionLogStream: fs.WriteStream | null = null;

  /**
   * Launch the Convex backend, set environment variables, deploy functions,
   * and start the executor service.
   */
  async setup(): Promise<void> {
    const logdir = process.env.TEST_LOGDIR;
    if (logdir) {
      fs.mkdirSync(logdir, { recursive: true });
    }

    // Launch local Convex backend
    console.log("Launching local Convex backend...");
    this.backend = await launchConvexBackend(
      {
        projectDir: BACKEND_DIR,
        port: 3299, // Use a unique port to avoid conflicts
        siteProxyPort: 3298,
        ...(logdir ? { backendLogFile: path.join(logdir, "convex.log") } : {}),
      },
      path.join(BACKEND_DIR, ".convex-test"),
    );

    if (logdir) {
      const convexLogPath = path.join(logdir, "convex.log");
      this.functionLogStream = fs.createWriteStream(convexLogPath, { flags: "a" });
      const writeFunctionLogLine = (level: string, message: string): void => {
        this.functionLogStream?.write(`${new Date().toISOString()} [function-${level}] ${message}\n`);
      };
      const functionLogLogger = {
        debug: (msg: string) => writeFunctionLogLine("debug", msg),
        info: (msg: string) => writeFunctionLogLine("info", msg),
        warn: (msg: string) => writeFunctionLogLine("warn", msg),
        error: (msg: string, options?: { error?: string | Error }) => {
          if (options?.error) {
            writeFunctionLogLine(
              "error",
              `${msg} ${options.error instanceof Error ? options.error.message : options.error}`,
            );
          } else {
            writeFunctionLogLine("error", msg);
          }
        },
      };

      this.functionLogAbortController = new AbortController();
      this.functionLogWatcher = watchFunctionLogs(
        this.backend.backendUrl!,
        this.backend.getAdminKey(),
        functionLogLogger,
        this.functionLogAbortController.signal,
      ).catch((error) => {
        if (!this.functionLogAbortController?.signal.aborted) {
          writeFunctionLogLine("error", `watchFunctionLogs failed: ${(error as Error).message}`);
        }
      });
    }

    // Set required environment variables on the backend before deploy
    console.log("Setting environment variables...");
    await this.backend.setEnv("WORKOS_CLIENT_ID", "test-client-id");
    await this.backend.setEnv("RESEND_API_KEY", "test-resend-api-key");
    await this.backend.setEnv("RESEND_FROM_EMAIL", "TokenSpace <onboarding@resend.dev>");
    await this.backend.setEnv("TOKENSPACE_APP_URL", "https://app.tokenspace.ai");
    await this.backend.setEnv("TOKENSPACE_EXECUTOR_TOKEN", EXECUTOR_TOKEN);
    await this.backend.setEnv("TOKENSPACE_CREDENTIAL_ENCRYPTION_KEY", CREDENTIAL_ENCRYPTION_KEY);
    await this.backend.setEnv(TEST_ENV_CREDENTIAL_NAME, TEST_ENV_CREDENTIAL_VALUE);
    await this.backend.setEnv("TOKENSPACE_MOCK_LLM", "true");
    await this.backend.setEnv("TOKENSPACE_REPLAY_LLM", "true");
    if (process.env.DURABLE_AGENTS_RACE_DEBUG === "true") {
      await this.backend.setEnv("DURABLE_AGENTS_RACE_DEBUG", "true");
    }

    // Deploy the backend functions
    console.log("Deploying backend functions...");
    this.backend.deploy();
    console.log("Backend deployed!");

    // Seed replay fixtures into Convex table for mock replay tests.
    const replayFixtures = loadReplayFixtures();
    if (replayFixtures.length > 0) {
      console.log(`Seeding ${replayFixtures.length} replay fixture(s)...`);
      for (const fixture of replayFixtures) {
        await this.backend.runFunction(getFunctionName(internal.ai.replay.upsertReplayRecordingFixture), {
          recordingId: fixture.recordingId,
          displayName: fixture.displayName,
          showInReplayModelPicker: fixture.showInReplayModelPicker,
          playbackSettings: fixture.playbackSettings,
          toolOutcomes: fixture.toolOutcomes,
          recording: fixture.recording,
        });
      }
    }

    // Start the executor service in the background
    console.log("Starting executor service...");
    const executorLogFile = logdir ? Bun.file(path.join(logdir, "executor.log")) : undefined;
    this.executorProcess = spawn({
      cmd: ["bun", "run", "src/main.ts"],
      cwd: EXECUTOR_DIR,
      env: {
        ...process.env,
        CONVEX_URL: this.backend.backendUrl,
        TOKENSPACE_EXECUTOR_TOKEN: EXECUTOR_TOKEN,
      },
      stdout: executorLogFile ?? "inherit",
      stderr: executorLogFile ?? "inherit",
    });

    // Give the executor a moment to connect
    await new Promise((resolve) => setTimeout(resolve, 1000));
    console.log("Executor service started!");
  }

  /**
   * Stop the executor service and Convex backend.
   */
  async teardown(): Promise<void> {
    if (this.functionLogAbortController) {
      this.functionLogAbortController.abort();
      this.functionLogAbortController = null;
    }
    if (this.functionLogWatcher) {
      try {
        await this.functionLogWatcher;
      } catch {
        // Ignore function log watcher shutdown errors.
      }
      this.functionLogWatcher = null;
    }
    if (this.functionLogStream) {
      await new Promise<void>((resolve) => {
        this.functionLogStream?.end(() => resolve());
      });
      this.functionLogStream = null;
    }

    // Stop the executor service
    if (this.executorProcess) {
      console.log("Stopping executor service...");
      this.executorProcess.kill();
      this.executorProcess = null;
    }

    if (this.backend) {
      console.log("Stopping backend...");
      try {
        await this.backend.stop(true); // cleanup = true
      } catch (error) {
        // Ignore cleanup errors - the backend may have already cleaned up
        console.log("Cleanup warning:", (error as Error).message);
      }
      this.backend = null;
    }
  }

  /**
   * Seed a workspace from the testing example workspace and compile it.
   * Sets the test context with workspaceId, branchId, and revisionId.
   */
  async seedWorkspace(): Promise<TestContext> {
    if (!this.backend) {
      throw new Error("Backend not started. Call setup() first.");
    }

    // Read files from the workspace fixture directory
    const files = readFilesRecursively(EXAMPLE_DIR);

    // Check if workspace already exists and delete if so
    const exists = await this.backend.runFunction(getFunctionName(internal.seed.workspaceExists), {
      slug: WORKSPACE_SLUG,
    });

    if (exists) {
      await this.backend.runFunction(getFunctionName(internal.seed.deleteWorkspace), {
        slug: WORKSPACE_SLUG,
      });
    }

    // Seed the workspace
    const result = (await this.backend.runFunction(getFunctionName(internal.seed.seedWorkspace), {
      slug: WORKSPACE_SLUG,
      name: WORKSPACE_NAME,
      files,
    })) as { workspaceId: string; status: string };

    const workspaceId = result.workspaceId;

    // Get the default branch (using internal query to bypass auth)
    const branch = (await this.backend.runFunction(getFunctionName(internal.vcs.getDefaultBranchInternal), {
      workspaceId,
    })) as { _id: string; name: string; isDefault: boolean };

    if (!branch) {
      throw new Error("Default branch not found after seeding workspace");
    }

    const branchId = branch._id;

    // Compile the workspace (using internal action to bypass auth)
    const revisionId = await enqueueAndWaitForRevision(this.backend, {
      workspaceId,
      branchId,
      includeWorkingState: false,
    });

    this.context = { workspaceId, branchId, revisionId };
    return this.context;
  }

  /**
   * Get the Convex backend instance.
   */
  getBackend(): ConvexBackend {
    if (!this.backend) {
      throw new Error("Backend not started. Call setup() first.");
    }
    return this.backend;
  }

  /**
   * Get the test context (workspaceId, branchId, revisionId).
   */
  getContext(): TestContext {
    if (!this.context) {
      throw new Error("Context not available. Call seedWorkspace() first.");
    }
    return this.context;
  }
}

// Re-export the API for convenience
export { api, internal };
export { getFunctionName } from "convex/server";
