import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { loadPersistedKeys } from "@tokenspace/convex-local-dev";

// Configuration constants
export const EXAMPLES_DIR = path.join(import.meta.dir, "../../examples");
export const LOCAL_DEV_EXECUTOR_NAME = "Local Dev Executor";
export const LOCAL_DEV_EXECUTOR_CREATED_BY = "dev-seed";
export const SEED_WORKSPACES = [
  {
    slug: "demo",
    name: "Demo",
    dir: path.join(EXAMPLES_DIR, "demo"),
    credentials: [
      { credentialId: "datadog-api-key", envVar: "DEMO_DATADOG_API_KEY" },
      { credentialId: "datadog-app-key", envVar: "DEMO_DATADOG_APP_KEY" },
      { credentialId: "linear-client-id", envVar: "DEMO_LINEAR_CLIENT_ID" },
      { credentialId: "linear-client-secret", envVar: "DEMO_LINEAR_CLIENT_SECRET" },
    ] satisfies SeedCredential[],
  },
  {
    slug: "testing",
    name: "Testing",
    dir: path.join(EXAMPLES_DIR, "testing"),
  },
] as const;
export const CONVEX_STATE_DIR = path.join(import.meta.dir, "../../.convex");

// Files/directories to skip when reading workspace directories
export const SKIP_PATTERNS = ["node_modules", ".git", "tsconfig.json"];

export type SeedCredential = {
  credentialId: string;
  envVar: string;
};

export type SeedWorkspaceConfig = (typeof SEED_WORKSPACES)[number];
export type SeedExecutorMode = "assignOnly" | "assignAndRotateBootstrap";
export type SeedLog = (message: string) => void;
export type SeedWorkspaceStatus = "created" | "exists" | "updated";
export type SeedWorkspaceResult = {
  slug: string;
  name: string;
  workspaceId: string;
  status: SeedWorkspaceStatus;
};
export type EnsureLocalDevExecutorResult = {
  executorId: string;
  assignedWorkspaceIds: string[];
  bootstrapToken?: string;
};
export type SeedConfiguredWorkspacesResult = {
  workspaces: SeedWorkspaceResult[];
  workspaceIds: string[];
  executor: EnsureLocalDevExecutorResult;
};

/**
 * Get the Convex URL from environment or .env file
 */
export function getConvexUrl(): string {
  if (process.env.CONVEX_URL) {
    return process.env.CONVEX_URL;
  }

  // Try to read from .env file
  const envPath = path.join(import.meta.dir, "../../.env");
  if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, "utf-8");
    const match = envContent.match(/^CONVEX_URL=(.+)$/m);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  throw new Error("CONVEX_URL not found. Set CONVEX_URL environment variable or ensure .env file exists.");
}

/**
 * Get the admin key from environment or .convex/keys.json
 */
export function getAdminKey(): string {
  if (process.env.CONVEX_ADMIN_KEY) {
    return process.env.CONVEX_ADMIN_KEY;
  }

  // Try to load from .convex/keys.json
  const instanceName = process.env.CONVEX_DEPLOYMENT ?? "tokenspace";
  const keys = loadPersistedKeys(CONVEX_STATE_DIR, instanceName);
  if (keys?.adminKey) {
    return keys.adminKey;
  }

  throw new Error(
    "Admin key not found. Set CONVEX_ADMIN_KEY environment variable or ensure .convex/keys.json exists (run dev server first).",
  );
}

/**
 * Run an internal Convex function using adminKey authentication
 */
export async function runInternalFunction<T>(
  convexUrl: string,
  adminKey: string,
  functionPath: string,
  args: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${convexUrl}/api/function`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Convex ${adminKey}`,
    },
    body: JSON.stringify({
      path: functionPath,
      format: "json",
      args,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to run ${functionPath}: ${response.status} ${errorText}`);
  }

  const result = (await response.json()) as { status: string; value?: T; errorMessage?: string };
  if (result.status === "error") {
    throw new Error(`Function ${functionPath} failed: ${result.errorMessage ?? "unknown error"}`);
  }
  return result.value as T;
}

export async function getWorkspaceBySlug(
  convexUrl: string,
  adminKey: string,
  slug: string,
): Promise<{ _id: string; name: string; slug: string } | null> {
  return await runInternalFunction(convexUrl, adminKey, "seed:getWorkspaceBySlugInternal", { slug });
}

export type FileEntry = { path: string; content: string; binary?: boolean };

/**
 * Recursively read all files from a directory
 */
export function readFilesRecursively(dir: string, baseDir: string = dir): FileEntry[] {
  const files: FileEntry[] = [];

  if (!existsSync(dir)) {
    return files;
  }

  const entries = readdirSync(dir, { withFileTypes: true });

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
      const binaryExtensions = [".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".pdf", ".zip"];
      if (binaryExtensions.includes(ext)) {
        const content = readFileSync(fullPath).toString("base64");
        files.push({ path: relativePath, content, binary: true });
        continue;
      }

      const content = readFileSync(fullPath, "utf-8");
      files.push({ path: relativePath, content });
    }
  }

  return files;
}

function getWorkspaceCredentials(workspace: SeedWorkspaceConfig): readonly SeedCredential[] {
  return "credentials" in workspace && Array.isArray(workspace.credentials) ? workspace.credentials : [];
}

export async function seedWorkspaceCredentials(
  convexUrl: string,
  adminKey: string,
  workspaceId: string,
  credentials: readonly SeedCredential[],
  log?: SeedLog,
): Promise<void> {
  for (const cred of credentials) {
    const envValue = process.env[cred.envVar];
    if (!envValue) {
      log?.(`  Credential '${cred.credentialId}': skipped (${cred.envVar} not set)`);
      continue;
    }

    await runInternalFunction(convexUrl, adminKey, "credentials:seedUpsertWorkspaceCredentialInternal", {
      workspaceId,
      credentialId: cred.credentialId,
      kind: "secret",
      value: { value: envValue },
    });
    log?.(`  Credential '${cred.credentialId}': seeded from ${cred.envVar}`);
  }
}

async function updateWorkspaceFiles(
  convexUrl: string,
  adminKey: string,
  workspace: SeedWorkspaceConfig,
  log?: SeedLog,
): Promise<string> {
  log?.(`  Reading files from ${workspace.dir}...`);
  const files = readFilesRecursively(workspace.dir);
  log?.(`  Found ${files.length} files`);

  for (const file of files) {
    log?.(`  - ${file.path}`);
  }
  log?.("");

  log?.("  Updating workspace files...");
  const result = await runInternalFunction<{ workspaceId: string; updatedFiles: number; deletedFiles: number }>(
    convexUrl,
    adminKey,
    "seed:updateWorkspace",
    {
      slug: workspace.slug,
      files,
    },
  );

  log?.(
    `  Done! Updated ${result.updatedFiles} files, deleted ${result.deletedFiles} files in workspace '${workspace.slug}'.`,
  );
  log?.(`  Workspace ID: ${result.workspaceId}`);
  return result.workspaceId;
}

async function createSeedWorkspace(
  convexUrl: string,
  adminKey: string,
  workspace: SeedWorkspaceConfig,
  log?: SeedLog,
): Promise<string> {
  log?.(`  Reading files from ${workspace.dir}...`);
  const files = readFilesRecursively(workspace.dir);
  log?.(`  Found ${files.length} files`);

  for (const file of files) {
    log?.(`  - ${file.path}`);
  }
  log?.("");

  log?.("  Creating workspace and seeding files...");
  const result = await runInternalFunction<{ workspaceId: string; status: string }>(
    convexUrl,
    adminKey,
    "seed:seedWorkspace",
    {
      slug: workspace.slug,
      name: workspace.name,
      files,
    },
  );

  log?.(`  Done! Workspace '${workspace.slug}' ${result.status}.`);
  log?.(`  Workspace ID: ${result.workspaceId}`);
  return result.workspaceId;
}

export async function ensureLocalDevExecutor(
  convexUrl: string,
  adminKey: string,
  args: {
    workspaceIds: string[];
    mode: SeedExecutorMode;
  },
): Promise<EnsureLocalDevExecutorResult> {
  return await runInternalFunction(convexUrl, adminKey, "executors:ensureLocalDevExecutorInternal", {
    workspaceIds: args.workspaceIds,
    rotateBootstrap: args.mode === "assignAndRotateBootstrap",
  });
}

export async function seedConfiguredWorkspaces(args: {
  convexUrl: string;
  adminKey: string;
  forceReseed?: boolean;
  updateExisting?: boolean;
  seedWorkspaces?: boolean;
  executorMode: SeedExecutorMode;
  log?: SeedLog;
}): Promise<SeedConfiguredWorkspacesResult> {
  const log = args.log ?? (() => {});
  const workspaceResults: SeedWorkspaceResult[] = [];
  const workspaceIds = new Set<string>();

  if (args.seedWorkspaces ?? true) {
    for (const workspace of SEED_WORKSPACES) {
      log(`Workspace '${workspace.slug}' (${workspace.name})`);

      const existing = await getWorkspaceBySlug(args.convexUrl, args.adminKey, workspace.slug);
      if (existing) {
        if (args.forceReseed) {
          log("  Exists. Deleting for re-seed...");
          await runInternalFunction<{ deleted: boolean }>(args.convexUrl, args.adminKey, "seed:deleteWorkspace", {
            slug: workspace.slug,
          });
          log("  Deleted.");
        } else if (args.updateExisting) {
          const workspaceId = await updateWorkspaceFiles(args.convexUrl, args.adminKey, workspace, log);
          const credentials = getWorkspaceCredentials(workspace);
          if (credentials.length > 0) {
            await seedWorkspaceCredentials(args.convexUrl, args.adminKey, workspaceId, credentials, log);
          }
          workspaceIds.add(workspaceId);
          workspaceResults.push({
            slug: workspace.slug,
            name: workspace.name,
            workspaceId,
            status: "updated",
          });
          log("");
          continue;
        } else {
          log("  Already exists. Skipping.");
          log("  Use --update to update files in existing workspaces.");
          log("  Use --force to delete and re-seed.");
          workspaceIds.add(existing._id);
          workspaceResults.push({
            slug: workspace.slug,
            name: workspace.name,
            workspaceId: existing._id,
            status: "exists",
          });
          log("");
          continue;
        }
      }

      const workspaceId = await createSeedWorkspace(args.convexUrl, args.adminKey, workspace, log);
      const credentials = getWorkspaceCredentials(workspace);
      if (credentials.length > 0) {
        await seedWorkspaceCredentials(args.convexUrl, args.adminKey, workspaceId, credentials, log);
      }
      workspaceIds.add(workspaceId);
      workspaceResults.push({
        slug: workspace.slug,
        name: workspace.name,
        workspaceId,
        status: "created",
      });
      log("");
    }
  }

  const executor = await ensureLocalDevExecutor(args.convexUrl, args.adminKey, {
    workspaceIds: Array.from(workspaceIds),
    mode: args.executorMode,
  });

  log(
    `Local dev executor '${LOCAL_DEV_EXECUTOR_NAME}' ready (${executor.executorId}); assigned ${executor.assignedWorkspaceIds.length} workspace(s).`,
  );

  return {
    workspaces: workspaceResults,
    workspaceIds: Array.from(workspaceIds),
    executor,
  };
}
