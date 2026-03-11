/**
 * Codegen script that launches a temporary Convex backend to update the _generated folder.
 *
 * Usage:
 *   cd services/backend
 *   bun run codegen
 */

import * as path from "node:path";
import { launchConvexBackend } from "@tokenspace/convex-local-dev";

const BACKEND_DIR = __dirname;

async function main() {
  console.log("Launching temporary Convex backend for codegen...");

  const backend = await launchConvexBackend(
    {
      projectDir: BACKEND_DIR,
      port: 3399, // Use a unique port to avoid conflicts
      siteProxyPort: 3398,
      instanceName: "codegen",
    },
    path.join(BACKEND_DIR, ".convex-codegen"),
  );

  try {
    // Set required environment variables (auth.config.ts requires these)
    console.log("Setting environment variables...");
    await backend.setEnv("WORKOS_CLIENT_ID", "codegen-placeholder");
    await backend.setEnv("RESEND_API_KEY", "codegen-placeholder");
    await backend.setEnv("RESEND_FROM_EMAIL", "TokenSpace <onboarding@resend.dev>");
    await backend.setEnv("TOKENSPACE_APP_URL", "https://app.tokenspace.ai");

    // Deploy to generate _generated files
    console.log("Running deploy to generate _generated files...");
    backend.deploy();

    console.log("Codegen complete!");
  } finally {
    // Stop and cleanup the temporary backend
    console.log("Cleaning up temporary backend...");
    await backend.stop(true);
  }
}

main().catch((error) => {
  console.error("Codegen failed:", error);
  process.exit(1);
});
