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

import { getAdminKey, getConvexUrl, SEED_WORKSPACES, seedConfiguredWorkspaces } from "./lib/seed";

// Check for flags
const FORCE_RESEED = process.argv.includes("--force") || process.argv.includes("-f");
const UPDATE_WORKSPACE = process.argv.includes("--update") || process.argv.includes("-u");

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

  await seedConfiguredWorkspaces({
    convexUrl,
    adminKey,
    forceReseed: FORCE_RESEED,
    updateExisting: UPDATE_WORKSPACE,
    seedWorkspaces: true,
    executorMode: "assignOnly",
    log: console.log,
  });

  console.log("All example workspaces processed.");
}

// Run
seed().catch((error) => {
  console.error("\nSeed failed:", error.message);
  process.exit(1);
});
