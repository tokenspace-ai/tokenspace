import * as fs from "node:fs";
import * as path from "node:path";
import pc from "picocolors";
import { buildRevisionUrl, openUrl } from "../browser.js";
import { buildLocalWorkspace } from "../build.js";
import {
  discardAllWorkingFiles,
  exitWithError,
  getAllFilesInTree,
  getCommit,
  getDefaultBranch,
  getFileContent,
  getWorkspaceBySlug,
  initializeWorkspace,
  markWorkingFileDeleted,
  saveWorkingFile,
} from "../client.js";
import {
  DEFAULT_BUILD_DIR,
  findNearestLinkedWorkspaceRoot,
  formatDisplayPath,
  getLocalFiles,
  printWorkspaceResolution,
  readLinkedWorkspaceConfig,
} from "../local-workspace.js";
import { pushRevisionArtifacts } from "./revision.js";

interface PushOptions {
  dryRun?: boolean;
  open?: boolean;
}

export async function push(options: PushOptions): Promise<void> {
  const resolvedDir = await findNearestLinkedWorkspaceRoot(process.cwd());
  if (!resolvedDir) {
    exitWithError("No linked tokenspace found. Run `tokenspace link` first.");
  }
  const linked = await readLinkedWorkspaceConfig(resolvedDir);
  if (!linked) {
    exitWithError("Linked tokenspace metadata is missing or invalid.");
  }

  console.log(pc.cyan(`Pushing linked tokenspace ${pc.bold(linked.workspaceSlug)}`));
  printWorkspaceResolution("Workspace", resolvedDir);

  const workspace = await getWorkspaceBySlug(linked.workspaceSlug);
  if (!workspace) {
    exitWithError(`Tokenspace '${linked.workspaceSlug}' not found`);
  }

  let branch = await getDefaultBranch(workspace._id);
  if (!branch) {
    console.log(pc.yellow("  Initializing tokenspace with default 'main' branch..."));
    if (!options.dryRun) {
      await initializeWorkspace(workspace._id);
      branch = await getDefaultBranch(workspace._id);
    }
  }

  if (!branch) {
    exitWithError(`Could not find or initialize the default branch for '${linked.workspaceSlug}'`);
  }

  console.log(pc.dim(`  Branch: ${branch.name}`));

  // Get current commit tree
  let workspaceFilePaths = new Set<string>();
  let treeId: string | null = null;

  if (branch) {
    const commit = await getCommit(branch.commitId);
    if (commit) {
      treeId = commit.treeId;
      const treeFiles = await getAllFilesInTree(commit.treeId);
      workspaceFilePaths = new Set(treeFiles.map((f) => f.path));
    }
  }

  // Get local files
  const localFiles = await getLocalFiles(resolvedDir);
  const localPresentFiles = await getLocalFiles(resolvedDir, { includeBinary: true });
  const localFilePaths = new Set(localPresentFiles);

  // Calculate changes
  const filesToAdd: string[] = [];
  const filesToUpdate: string[] = [];
  const filesToDelete: string[] = [];

  // Check which local files need to be added or updated
  for (const localFile of localFiles) {
    if (!workspaceFilePaths.has(localFile)) {
      filesToAdd.push(localFile);
    } else {
      filesToUpdate.push(localFile);
    }
  }

  // Check which workspace files need to be deleted
  for (const wsFile of workspaceFilePaths) {
    if (!localFilePaths.has(wsFile)) {
      filesToDelete.push(wsFile);
    }
  }

  // Summary
  console.log("");
  console.log(pc.bold("Changes:"));
  console.log(`  ${pc.green(`+ ${filesToAdd.length} files to add`)}`);
  console.log(`  ${pc.yellow(`~ ${filesToUpdate.length} files to check`)}`);
  console.log(`  ${pc.red(`- ${filesToDelete.length} files to delete`)}`);
  console.log("");

  if (options.dryRun) {
    console.log(pc.yellow("Dry run - no changes made"));

    if (filesToAdd.length > 0) {
      console.log(pc.green("\nFiles to add:"));
      for (const f of filesToAdd) {
        console.log(pc.green(`  + ${f}`));
      }
    }

    if (filesToDelete.length > 0) {
      console.log(pc.red("\nFiles to delete:"));
      for (const f of filesToDelete) {
        console.log(pc.red(`  - ${f}`));
      }
    }

    return;
  }

  // First, clear any existing working changes
  await discardAllWorkingFiles(branch._id);

  let changesCount = 0;

  // Add new files
  for (const localFile of filesToAdd) {
    const localPath = path.join(resolvedDir, localFile);
    const content = fs.readFileSync(localPath, "utf-8");

    await saveWorkingFile(workspace._id, branch._id, localFile, content);
    changesCount++;
    console.log(pc.green(`  + ${localFile}`));
  }

  // Update existing files (only if content differs)
  for (const localFile of filesToUpdate) {
    const localPath = path.join(resolvedDir, localFile);
    const localContent = fs.readFileSync(localPath, "utf-8");

    // Get workspace content to compare
    if (treeId) {
      const wsFile = await getFileContent(treeId as any, localFile);
      if (wsFile && wsFile.content === localContent) {
        continue; // Skip unchanged files
      }
    }

    await saveWorkingFile(workspace._id, branch._id, localFile, localContent);
    changesCount++;
    console.log(pc.yellow(`  ~ ${localFile}`));
  }

  // Delete files not in local
  for (const wsFile of filesToDelete) {
    await markWorkingFileDeleted(workspace._id, branch._id, wsFile);
    changesCount++;
    console.log(pc.red(`  - ${wsFile}`));
  }

  console.log("");
  if (changesCount === 0) {
    console.log(pc.dim("No source sync changes detected."));
  } else {
    console.log(pc.green(`Synced ${changesCount} source change(s) to ${linked.workspaceSlug}/${branch.name}`));
  }

  const buildDir = path.resolve(resolvedDir, DEFAULT_BUILD_DIR);

  console.log();
  console.log(pc.cyan("Building local workspace artifacts"));
  console.log(pc.dim(`  Output: ${formatDisplayPath(resolvedDir, buildDir)}`));
  await buildLocalWorkspace(resolvedDir, buildDir);

  console.log();
  console.log(pc.cyan("Pushing revision artifacts"));
  const revision = await pushRevisionArtifacts({
    workspaceId: workspace._id,
    branchId: branch._id,
    buildDir,
  });
  const revisionUrl = buildRevisionUrl(linked.workspaceSlug, revision.revisionId);

  console.log(pc.green("✓ Revision ready"));
  console.log(pc.dim(`  Revision ID: ${revision.revisionId}`));
  console.log(pc.dim(`  Created: ${revision.created}`));
  console.log(pc.dim(`  URL: ${revisionUrl}`));

  if (options.open) {
    await openUrl(revisionUrl);
  }
}
