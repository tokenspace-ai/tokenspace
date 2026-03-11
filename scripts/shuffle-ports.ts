import { basename, resolve } from "node:path";
import { readEnvFile, updateEnvValue, writeEnvFile } from "./lib/env";
import { getAvailableConvexPort, getAvailablePort } from "./lib/ports";

function getProjectFolderName(): string {
  // Get the workspace root (parent of scripts directory)
  const workspaceRoot = resolve(__dirname, "..");
  return basename(workspaceRoot);
}

async function main() {
  console.log("🔀 Shuffling dev server ports...\n");

  // Generate random available ports
  console.log("Finding available ports...");
  const convexPort = await getAvailableConvexPort();
  const webPort = await getAvailablePort([convexPort, convexPort + 1, convexPort + 2]);

  // Get project folder name for CONVEX_DEPLOYMENT
  const projectFolder = getProjectFolderName();

  // Read current .env file
  let envContent = await readEnvFile();

  // Update values
  envContent = updateEnvValue(envContent, "CONVEX_URL", `http://127.0.0.1:${convexPort}`);
  envContent = updateEnvValue(envContent, "WEB_PORT", String(webPort));
  envContent = updateEnvValue(envContent, "TOKENSPACE_APP_URL", `http://localhost:${webPort}`);
  envContent = updateEnvValue(envContent, "CONVEX_DEPLOYMENT", projectFolder);

  // Write updated .env file
  await writeEnvFile(envContent);

  console.log("\nUpdated .env with:");
  console.log(`  CONVEX_URL=http://127.0.0.1:${convexPort}`);
  console.log(`  WEB_PORT=${webPort}`);
  console.log(`  TOKENSPACE_APP_URL=http://localhost:${webPort}`);
  console.log(`  CONVEX_DEPLOYMENT=${projectFolder}`);
  console.log("\n✅ Done! Run 'bun run dev' to start the dev server with new ports.");
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
