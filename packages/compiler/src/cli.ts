#!/usr/bin/env bun
import path from "node:path";
import { type BuildProgressEvent, buildWorkspace } from "./workspace-build";

function printUsage(): void {
  console.error("Usage:\n  tokenspace-compiler build [--workspace <dir>] [--out-dir <dir>] [--mode local|server]");
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
        if (typeof entry === "object" && entry !== null) {
          lines.push(`    - ${JSON.stringify(entry)}`);
        } else {
          lines.push(`    - ${String(entry)}`);
        }
      }
      continue;
    }

    if (typeof value === "object" && value !== null) {
      lines.push(`  ${key}: ${JSON.stringify(value)}`);
      continue;
    }

    lines.push(`  ${key}: ${String(value)}`);
  }

  return lines;
}

function printProgress(event: BuildProgressEvent): void {
  if (event.message) console.log(`${event.message}`);
  for (const line of formatProgressDetails(event.details)) {
    console.log(line);
  }
}

function parseArgs(argv: string[]): {
  command: string;
  workspaceDir: string;
  outDir: string;
  mode: "local" | "server";
} {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h") {
    throw new Error("HELP");
  }

  if (!command) {
    throw new Error("Missing command");
  }

  let workspaceDir = ".";
  let outDir = "build/tokenspace";
  let mode: "local" | "server" = "local";

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--workspace") {
      const next = rest[i + 1];
      if (!next || next.startsWith("-")) {
        throw new Error("--workspace requires a value");
      }
      workspaceDir = next;
      i++;
      continue;
    }
    if (arg === "--out-dir") {
      const next = rest[i + 1];
      if (!next || next.startsWith("-")) {
        throw new Error("--out-dir requires a value");
      }
      outDir = next;
      i++;
      continue;
    }
    if (arg === "--mode") {
      const next = rest[++i];
      if (next === "local" || next === "server") {
        mode = next;
        continue;
      }
      throw new Error(`Invalid mode: ${next}`);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    command,
    workspaceDir: path.resolve(workspaceDir),
    outDir: path.resolve(outDir),
    mode,
  };
}

async function main() {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(process.argv.slice(2));
    if (parsed.command !== "build") {
      throw new Error(`Unknown command: ${parsed.command}`);
    }
  } catch (error) {
    printUsage();
    const message = error instanceof Error ? error.message : String(error);
    if (message !== "HELP") {
      console.error(message);
      process.exit(1);
    }
    return;
  }

  try {
    const result = await buildWorkspace({
      workspaceDir: parsed.workspaceDir,
      outDir: parsed.outDir,
      mode: parsed.mode,
      onProgress: printProgress,
    });

    console.log(`Built workspace artifacts in ${parsed.outDir}`);
    console.log(`Source fingerprint: ${result.manifest.sourceFingerprint}`);
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

void main();
