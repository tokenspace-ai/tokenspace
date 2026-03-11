import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { loadPersistedKeys } from "@tokenspace/convex-local-dev";

// Configuration constants
export const EXAMPLES_DIR = path.join(import.meta.dir, "../../examples");
export const SEED_WORKSPACES = [
  // {
  //   slug: "siftd",
  //   name: "SiftD Product Ops",
  //   dir: path.join(EXAMPLES_DIR, "siftd"),
  //   credentials: [
  //     { credentialId: "linear-client-secret", envVar: "LINEAR_CLIENT_SECRET" },
  //     { credentialId: "splunk-password", envVar: "SPLUNKDOGFOOD_PASSWORD" },
  //   ] satisfies SeedCredential[],
  // },
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
