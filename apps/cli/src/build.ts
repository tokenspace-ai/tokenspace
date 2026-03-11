import path from "node:path";
import type { BuildProgressEvent, BuildWorkspaceResult } from "@tokenspace/compiler";
import pc from "picocolors";

type CompilerModule = {
  buildWorkspace: (options: {
    workspaceDir: string;
    outDir: string;
    mode: "local" | "server";
    onProgress?: (event: BuildProgressEvent) => void;
  }) => Promise<BuildWorkspaceResult>;
};

let compilerModulePromise: Promise<CompilerModule> | undefined;

async function loadCompilerModule(): Promise<CompilerModule> {
  if (compilerModulePromise) {
    return compilerModulePromise;
  }

  compilerModulePromise = import("@tokenspace/compiler") as Promise<CompilerModule>;

  return compilerModulePromise;
}

function formatProgressDetails(details: Record<string, unknown> | undefined): string[] {
  if (!details) {
    return [];
  }

  const lines: string[] = [];
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`  ${key}: []`);
        continue;
      }
      lines.push(`  ${key}:`);
      for (const entry of value) {
        lines.push(`    - ${typeof entry === "object" ? JSON.stringify(entry) : String(entry)}`);
      }
      continue;
    }
    lines.push(`  ${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
  }
  return lines;
}

function printProgress(event: BuildProgressEvent): void {
  if (event.message) {
    console.log(pc.dim(event.message));
  }
  for (const line of formatProgressDetails(event.details)) {
    console.log(pc.dim(line));
  }
}

export async function buildLocalWorkspace(workspaceDir: string, outDir: string): Promise<BuildWorkspaceResult> {
  const { buildWorkspace } = await loadCompilerModule();
  return await buildWorkspace({
    workspaceDir: path.resolve(workspaceDir),
    outDir: path.resolve(outDir),
    mode: "local",
    onProgress: printProgress,
  });
}
