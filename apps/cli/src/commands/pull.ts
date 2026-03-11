import * as fs from "node:fs";
import * as path from "node:path";
import pc from "picocolors";
import {
  exitWithError,
  getAllFilesInTree,
  getCommit,
  getDefaultBranch,
  getFileContent,
  getWorkingFiles,
  getWorkspaceBySlug,
} from "../client.js";
import {
  findNearestLinkedWorkspaceRoot,
  getLocalFiles,
  printWorkspaceResolution,
  readLinkedWorkspaceConfig,
  shouldIgnoreRelativePath,
} from "../local-workspace.js";

interface PullOptions {
  dryRun?: boolean;
}

/**
 * Remove empty directories recursively
 */
function removeEmptyDirs(dir: string, baseDir: string = dir): void {
  if (!fs.existsSync(dir)) return;

  const entries = fs.readdirSync(dir);

  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const relativePath = path.relative(baseDir, fullPath);
    if (shouldIgnoreRelativePath(relativePath)) {
      continue;
    }
    if (fs.statSync(fullPath).isDirectory()) {
      removeEmptyDirs(fullPath, baseDir);
    }
  }

  // Check again after recursive cleanup
  const remainingEntries = fs.readdirSync(dir);
  if (remainingEntries.length === 0) {
    fs.rmdirSync(dir);
  }
}

export async function pull(options: PullOptions): Promise<void> {
  const dryRun = options.dryRun;
  const resolvedDir = await findNearestLinkedWorkspaceRoot(process.cwd());
  if (!resolvedDir) {
    exitWithError("No linked tokenspace found. Run `tokenspace link` first.");
  }
  const linked = await readLinkedWorkspaceConfig(resolvedDir);
  if (!linked) {
    exitWithError("Linked tokenspace metadata is missing or invalid.");
  }

  console.log(pc.cyan(`Pulling linked tokenspace ${pc.bold(linked.workspaceSlug)}`));
  printWorkspaceResolution("Workspace", resolvedDir);

  const workspace = await getWorkspaceBySlug(linked.workspaceSlug);
  if (!workspace) {
    exitWithError(`Tokenspace '${linked.workspaceSlug}' not found`);
  }

  const branch = await getDefaultBranch(workspace._id);
  if (!branch) {
    exitWithError(`No default branch found in tokenspace '${linked.workspaceSlug}'`);
  }

  console.log(pc.dim(`  Branch: ${branch.name}`));

  // Get the commit
  const commit = await getCommit(branch.commitId);
  if (!commit) {
    exitWithError("Could not find branch commit");
  }

  // Get all files in the tree (committed files)
  const treeFiles = await getAllFilesInTree(commit.treeId);

  // Get working files for the current user (uncommitted changes)
  const workingFiles = await getWorkingFiles(branch._id);

  // Build map of working file changes
  const workingFileMap = new Map<string, { content?: string; isDeleted: boolean }>();
  for (const wf of workingFiles) {
    workingFileMap.set(wf.path, { content: wf.content, isDeleted: wf.isDeleted });
  }

  // Report uncommitted changes if any
  if (workingFiles.length > 0) {
    const additions = workingFiles.filter((f) => !f.isDeleted).length;
    const deletions = workingFiles.filter((f) => f.isDeleted).length;
    console.log(pc.dim(`  Working changes: ${additions} modified/added, ${deletions} deleted`));
  }

  // Build set of workspace file paths (committed + working additions, minus working deletions)
  const workspaceFilePaths = new Set<string>();

  // Add committed files (unless deleted in working)
  for (const f of treeFiles) {
    const working = workingFileMap.get(f.path);
    if (!working?.isDeleted) {
      workspaceFilePaths.add(f.path);
    }
  }

  // Add new files from working directory
  for (const wf of workingFiles) {
    if (!wf.isDeleted && wf.content !== undefined) {
      workspaceFilePaths.add(wf.path);
    }
  }

  // Get local files
  const localFiles = await getLocalFiles(resolvedDir, { includeBinary: true });
  const localFilePaths = new Set(localFiles);

  // Calculate changes
  const filesToCreate: string[] = [];
  const filesToUpdate: string[] = [];
  const filesToDelete: string[] = [];

  // Check which workspace files need to be created or updated
  for (const wsFile of workspaceFilePaths) {
    if (!localFilePaths.has(wsFile)) {
      filesToCreate.push(wsFile);
    } else {
      filesToUpdate.push(wsFile);
    }
  }

  // Check which local files need to be deleted
  for (const localFile of localFiles) {
    if (!workspaceFilePaths.has(localFile)) {
      filesToDelete.push(localFile);
    }
  }

  // Summary
  console.log("");
  console.log(pc.bold("Changes:"));
  console.log(`  ${pc.green(`+ ${filesToCreate.length} files to create`)}`);
  console.log(`  ${pc.yellow(`~ ${filesToUpdate.length} files to update`)}`);
  console.log(`  ${pc.red(`- ${filesToDelete.length} files to delete`)}`);
  console.log("");

  if (dryRun) {
    console.log(pc.yellow("Dry run - no changes made"));

    if (filesToCreate.length > 0) {
      console.log(pc.green("\nFiles to create:"));
      for (const f of filesToCreate) {
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

  // Create target directory if needed
  if (!fs.existsSync(resolvedDir)) {
    fs.mkdirSync(resolvedDir, { recursive: true });
  }

  // Download and write files
  let created = 0;
  let updated = 0;

  for (const wsFilePath of [...filesToCreate, ...filesToUpdate]) {
    // Check if there's a working file change for this path
    const working = workingFileMap.get(wsFilePath);
    let content: string;

    if (working && !working.isDeleted && working.content !== undefined) {
      // Use working file content (uncommitted change)
      content = working.content;
    } else {
      // Use committed file content
      const fileData = await getFileContent(commit.treeId, wsFilePath);
      if (!fileData) {
        console.warn(pc.yellow(`  Warning: Could not fetch ${wsFilePath}`));
        continue;
      }
      content = fileData.content;
    }

    const localPath = path.join(resolvedDir, wsFilePath);
    const localDir = path.dirname(localPath);

    // Create directory if needed
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }

    // Check if file exists and has same content
    if (fs.existsSync(localPath)) {
      const existingContent = fs.readFileSync(localPath, "utf-8");
      if (existingContent === content) {
        continue; // Skip unchanged files
      }
      updated++;
      const marker = working && !working.isDeleted ? "*" : "";
      console.log(pc.yellow(`  ~ ${wsFilePath}${marker}`));
    } else {
      created++;
      const marker = working && !working.isDeleted ? "*" : "";
      console.log(pc.green(`  + ${wsFilePath}${marker}`));
    }

    fs.writeFileSync(localPath, content, "utf-8");
  }

  // Delete files not in workspace
  let deleted = 0;
  for (const localFile of filesToDelete) {
    const localPath = path.join(resolvedDir, localFile);
    if (fs.existsSync(localPath)) {
      fs.unlinkSync(localPath);
      deleted++;
      console.log(pc.red(`  - ${localFile}`));
    }
  }

  // Clean up empty directories
  removeEmptyDirs(resolvedDir, resolvedDir);

  console.log("");
  console.log(pc.green(`Done! Created ${created}, updated ${updated}, deleted ${deleted} files.`));
}
