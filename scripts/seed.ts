/**
 * Seed script for initializing the backend with example workspaces.
 *
 * This script reads files from the examples/ directories and seeds them into
 * the Convex backend using internal functions with adminKey authentication.
 *
 * Usage:
 *   bun run scripts/seed.ts           # Seed missing workspaces
 *   bun run scripts/seed.ts --update  # Update files in existing workspaces
 *   bun run scripts/seed.ts --force   # Delete and re-seed all workspaces
 *
 * Environment variables:
 *   CONVEX_URL - URL of the Convex backend (default: from .env)
 *   CONVEX_ADMIN_KEY - Admin key for authentication (auto-discovered from .convex/keys.json)
 */

import {
  getAdminKey,
  getConvexUrl,
  readFilesRecursively,
  runInternalFunction,
  SEED_WORKSPACES,
  type SeedCredential,
} from "./lib/seed";

// Check for flags
const FORCE_RESEED = process.argv.includes("--force") || process.argv.includes("-f");
const UPDATE_WORKSPACE = process.argv.includes("--update") || process.argv.includes("-u");

type SeedWorkspaceConfig = (typeof SEED_WORKSPACES)[number];

function getWorkspaceCredentials(workspace: SeedWorkspaceConfig): readonly SeedCredential[] {
  return "credentials" in workspace && Array.isArray(workspace.credentials) ? workspace.credentials : [];
}

/**
 * Main seed function
 */
async function seed(): Promise<void> {
  console.log("Seeding example workspaces...\n");

  // Get configuration
  const convexUrl = getConvexUrl();
  const adminKey = getAdminKey();

  console.log(`  Convex URL: ${convexUrl}`);
  console.log(`  Workspaces: ${SEED_WORKSPACES.map((workspace) => `${workspace.slug} (${workspace.dir})`).join(", ")}`);
  console.log(`  Force reseed: ${FORCE_RESEED}`);
  console.log(`  Update existing: ${UPDATE_WORKSPACE}\n`);

  for (const workspace of SEED_WORKSPACES) {
    console.log(`Workspace '${workspace.slug}' (${workspace.name})`);

    // Check if workspace already exists
    const exists = await runInternalFunction<boolean>(convexUrl, adminKey, "seed:workspaceExists", {
      slug: workspace.slug,
    });

    if (exists) {
      if (FORCE_RESEED) {
        console.log("  Exists. Deleting for re-seed...");
        await runInternalFunction<{ deleted: boolean }>(convexUrl, adminKey, "seed:deleteWorkspace", {
          slug: workspace.slug,
        });
        console.log("  Deleted.");
      } else if (UPDATE_WORKSPACE) {
        const workspaceId = await updateWorkspace(convexUrl, adminKey, workspace);
        const credentials = getWorkspaceCredentials(workspace);
        if (credentials.length > 0) {
          await seedCredentials(convexUrl, adminKey, workspaceId, credentials);
        }
        console.log();
        continue;
      } else {
        console.log("  Already exists. Skipping.");
        console.log("  Use --update to update files in existing workspaces.");
        console.log("  Use --force to delete and re-seed.");
        console.log();
        continue;
      }
    }

    // Read files from workspace directory
    console.log(`  Reading files from ${workspace.dir}...`);
    const files = readFilesRecursively(workspace.dir);
    console.log(`  Found ${files.length} files`);

    for (const file of files) {
      console.log(`  - ${file.path}`);
    }
    console.log();

    // Seed the workspace
    console.log("  Creating workspace and seeding files...");
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

    console.log(`  Done! Workspace '${workspace.slug}' ${result.status}.`);
    console.log(`  Workspace ID: ${result.workspaceId}`);

    const credentials = getWorkspaceCredentials(workspace);
    if (credentials.length > 0) {
      await seedCredentials(convexUrl, adminKey, result.workspaceId, credentials);
    }

    console.log();
  }

  console.log("All example workspaces processed.");
}

/**
 * Update files in an existing workspace
 */
async function updateWorkspace(convexUrl: string, adminKey: string, workspace: SeedWorkspaceConfig): Promise<string> {
  // Read files from workspace directory
  console.log(`  Reading files from ${workspace.dir}...`);
  const files = readFilesRecursively(workspace.dir);
  console.log(`  Found ${files.length} files`);

  for (const file of files) {
    console.log(`  - ${file.path}`);
  }
  console.log();

  // Update the workspace files
  console.log("  Updating workspace files...");
  const result = await runInternalFunction<{ workspaceId: string; updatedFiles: number; deletedFiles: number }>(
    convexUrl,
    adminKey,
    "seed:updateWorkspace",
    {
      slug: workspace.slug,
      files,
    },
  );

  console.log(
    `  Done! Updated ${result.updatedFiles} files, deleted ${result.deletedFiles} files in workspace '${workspace.slug}'.`,
  );
  console.log(`  Workspace ID: ${result.workspaceId}`);
  return result.workspaceId;
}

/**
 * Seed credentials for a workspace
 */
async function seedCredentials(
  convexUrl: string,
  adminKey: string,
  workspaceId: string,
  credentials: readonly SeedCredential[],
): Promise<void> {
  for (const cred of credentials) {
    const envValue = process.env[cred.envVar];
    if (!envValue) {
      console.log(`  Credential '${cred.credentialId}': skipped (${cred.envVar} not set)`);
      continue;
    }

    await runInternalFunction(convexUrl, adminKey, "credentials:seedUpsertWorkspaceCredentialInternal", {
      workspaceId,
      credentialId: cred.credentialId,
      kind: "secret",
      value: { value: envValue },
    });
    console.log(`  Credential '${cred.credentialId}': seeded from ${cred.envVar}`);
  }
}

// Run
seed().catch((error) => {
  console.error("\nSeed failed:", error.message);
  process.exit(1);
});
