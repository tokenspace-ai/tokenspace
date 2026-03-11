#!/usr/bin/env bun
/**
 * Script to update the pinned Convex backend version to the latest release.
 *
 * Usage:
 *   bun run scripts/update-convex-binary-version.ts
 *   bun run scripts/update-convex-binary-version.ts --check  # Check if update is available without applying
 *   bun run scripts/update-convex-binary-version.ts <version>  # Pin to a specific version
 */

import * as fs from "node:fs";
import * as path from "node:path";

const PACKAGE_JSON_PATH = path.join(import.meta.dir, "../packages/convex-local-dev/package.json");
const GITHUB_RELEASES_URL = "https://api.github.com/repos/get-convex/convex-backend/releases?per_page=20";

interface GitHubRelease {
  tag_name: string;
  published_at: string;
  html_url: string;
  assets: Array<{ name: string }>;
}

async function fetchReleases(): Promise<GitHubRelease[]> {
  const headers: HeadersInit = {
    "User-Agent": "tokenspace-update-script",
  };

  const githubToken = process.env.GITHUB_TOKEN;
  if (githubToken) {
    headers.Authorization = `Bearer ${githubToken}`;
  }

  const response = await fetch(GITHUB_RELEASES_URL, { headers });
  if (!response.ok) {
    throw new Error(`Failed to fetch releases: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function getCurrentVersion(): string {
  const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf-8"));
  return packageJson.convexBackendVersion;
}

function updateVersion(newVersion: string): void {
  const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf-8"));
  packageJson.convexBackendVersion = newVersion;
  fs.writeFileSync(PACKAGE_JSON_PATH, `${JSON.stringify(packageJson, null, 2)}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const specificVersion = args.find((arg) => !arg.startsWith("--"));

  const currentVersion = getCurrentVersion();
  console.log(`Current version: ${currentVersion}`);

  if (specificVersion) {
    // Pin to a specific version
    const releases = await fetchReleases();
    const release = releases.find((r) => r.tag_name === specificVersion);

    if (!release) {
      console.error(`\nError: Version '${specificVersion}' not found in recent releases.`);
      console.log("\nAvailable versions:");
      for (const r of releases.slice(0, 10)) {
        console.log(`  - ${r.tag_name}`);
      }
      process.exit(1);
    }

    if (currentVersion === specificVersion) {
      console.log(`\nAlready at version ${specificVersion}`);
      return;
    }

    updateVersion(specificVersion);
    console.log(`\nUpdated to version: ${specificVersion}`);
    console.log(`Release URL: ${release.html_url}`);
    return;
  }

  // Find the latest release with precompiled binaries
  console.log("\nFetching latest releases from GitHub...");
  const releases = await fetchReleases();

  // Find the latest precompiled release (they start with "precompiled-")
  const latestRelease = releases.find(
    (r) => r.tag_name.startsWith("precompiled-") && r.assets.some((a) => a.name.includes("convex-local-backend")),
  );

  if (!latestRelease) {
    console.error("No precompiled releases found with convex-local-backend binaries");
    process.exit(1);
  }

  const latestVersion = latestRelease.tag_name;
  console.log(`Latest version:  ${latestVersion}`);

  if (currentVersion === latestVersion) {
    console.log("\nAlready at the latest version!");
    return;
  }

  console.log(`\nNew version available: ${currentVersion} -> ${latestVersion}`);
  console.log(`Release URL: ${latestRelease.html_url}`);
  console.log(`Published: ${new Date(latestRelease.published_at).toLocaleDateString()}`);

  if (checkOnly) {
    console.log("\nRun without --check to apply the update.");
    process.exit(1); // Exit with error code to indicate update is available
  }

  updateVersion(latestVersion);
  console.log(`\nUpdated packages/convex-local-dev/package.json to version: ${latestVersion}`);
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
