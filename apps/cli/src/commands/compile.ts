import path from "node:path";
import pc from "picocolors";
import { buildLocalWorkspace } from "../build.js";
import {
  DEFAULT_BUILD_DIR,
  findNearestTokenspaceWorkspaceRoot,
  formatDisplayPath,
  printWorkspaceResolution,
} from "../local-workspace.js";

interface CompileOptions {
  outDir?: string;
}

export async function compileWorkspace(options: CompileOptions): Promise<void> {
  const workspaceDir = await findNearestTokenspaceWorkspaceRoot(process.cwd());
  if (!workspaceDir) {
    throw new Error("No local tokenspace workspace found. Run this inside a workspace created with `tokenspace init`.");
  }

  const outDir = path.resolve(workspaceDir, options.outDir ?? DEFAULT_BUILD_DIR);

  console.log(pc.cyan("Compiling local tokenspace"));
  printWorkspaceResolution("Workspace", workspaceDir);
  console.log(pc.dim(`  Output: ${formatDisplayPath(workspaceDir, outDir)}`));

  const result = await buildLocalWorkspace(workspaceDir, outDir);

  console.log();
  console.log(pc.green("✓ Build complete"));
  console.log(pc.dim(`  Manifest: ${formatDisplayPath(workspaceDir, path.join(outDir, "manifest.json"))}`));
  console.log(pc.dim(`  Source fingerprint: ${result.manifest.sourceFingerprint}`));
}
