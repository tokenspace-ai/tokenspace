/**
 * Preload script for integration tests.
 *
 * This script starts the Convex backend and executor service ONCE before all tests run,
 * and tears them down after all tests complete. This avoids the overhead of starting
 * a new backend for each test file.
 *
 * Usage: Configure in bunfig.toml:
 *   [test]
 *   preload = ["./src/setup.ts"]
 */

import { afterAll, beforeAll } from "bun:test";
import { IntegrationTestHarness, type TestContext } from "./test-utils";

// Global harness instance shared across all test files
let globalHarness: IntegrationTestHarness | null = null;
let globalContext: TestContext | null = null;
let setupPromise: Promise<void> | null = null;

/**
 * Get the shared harness instance.
 * Call this in your test file instead of creating a new IntegrationTestHarness.
 */
export function getSharedHarness(): IntegrationTestHarness {
  if (!globalHarness) {
    throw new Error("Shared harness not initialized. Ensure setup.ts is loaded via preload.");
  }
  return globalHarness;
}

/**
 * Get the shared test context (workspaceId, branchId, revisionId).
 * Call this in your test file instead of calling seedWorkspace().
 */
export function getSharedContext(): TestContext {
  if (!globalContext) {
    throw new Error("Shared context not initialized. Ensure setup.ts is loaded via preload.");
  }
  return globalContext;
}

/**
 * Wait for the shared setup to complete.
 * Call this in beforeAll() of each test file to ensure the backend is ready.
 */
export async function waitForSetup(): Promise<void> {
  if (setupPromise) {
    await setupPromise;
  }
}

// Start the backend once before all tests
beforeAll(async () => {
  console.log("[setup] Starting shared backend for all integration tests...");

  globalHarness = new IntegrationTestHarness();

  setupPromise = (async () => {
    await globalHarness!.setup();
    globalContext = await globalHarness!.seedWorkspace();
    console.log("[setup] Shared backend ready!");
  })();

  await setupPromise;
}, 120000); // 2 minute timeout for setup

// Tear down after all tests complete
afterAll(async () => {
  console.log("[setup] Tearing down shared backend...");
  if (globalHarness) {
    await globalHarness.teardown();
    globalHarness = null;
    globalContext = null;
  }
  console.log("[setup] Shared backend stopped.");
});
