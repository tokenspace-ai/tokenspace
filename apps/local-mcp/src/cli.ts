#!/usr/bin/env bun

import { spawn } from "node:child_process";
import process from "node:process";
import { createLocalApprovalStore } from "./approvals";
import { createLocalControlServer } from "./control-server";
import { createLocalCredentialManager } from "./credential-store";
import { createLocalMcpServer } from "./server";
import { createLocalSession } from "./session";

function openInBrowser(url: string): void {
  const child =
    process.platform === "win32"
      ? spawn("cmd", ["/c", "start", "", url], {
          stdio: "ignore",
          detached: true,
          windowsHide: true,
        })
      : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
          stdio: "ignore",
          detached: true,
        });
  child.on("error", (error) => {
    console.error(`Failed to open browser: ${error.message}`);
  });
  child.unref();
}

type ParsedArgs = {
  workspaceDir: string;
  sessionsRootDir?: string;
  buildCacheDir?: string;
  systemDir?: string;
};

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  if (args[0] === "--help" || args[0] === "-h") {
    console.log(
      "Usage: tokenspace-local-mcp <workspace-dir> [--sessions-root-dir <dir>] [--build-cache-dir <dir>] [--system-dir <dir>]",
    );
    process.exit(0);
  }
  const workspaceDir = args.shift();
  if (!workspaceDir) {
    throw new Error(
      "Usage: tokenspace-local-mcp <workspace-dir> [--sessions-root-dir <dir>] [--build-cache-dir <dir>] [--system-dir <dir>]",
    );
  }

  const parsed: ParsedArgs = { workspaceDir };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--sessions-root-dir") {
      parsed.sessionsRootDir = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--build-cache-dir") {
      parsed.buildCacheDir = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--system-dir") {
      parsed.systemDir = args[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const session = await createLocalSession({
    workspaceDir: args.workspaceDir,
    sessionsRootDir: args.sessionsRootDir,
    buildCacheDir: args.buildCacheDir,
    systemDir: args.systemDir,
  });
  const approvalStore = await createLocalApprovalStore(session);
  const credentialManager = createLocalCredentialManager(session);
  const controlServer = await createLocalControlServer({
    session,
    approvalStore,
    credentialManager,
  });
  let handle: Awaited<ReturnType<typeof createLocalMcpServer>>;
  try {
    handle = await createLocalMcpServer(session, {
      approvalStore,
      controlServer,
      credentialManager,
    });
  } catch (error) {
    await controlServer.close();
    throw error;
  }

  console.error("Tokenspace local MCP ready on stdio");
  console.error(`Workspace: ${session.manifest.workspaceName} (${session.manifest.workspaceDir})`);
  console.error(`Fingerprint: ${session.manifest.sourceFingerprint}`);
  console.error(`Build: ${session.manifest.buildOrigin}`);
  console.error(`Startup: ${Date.now() - startedAt}ms`);
  console.error(`Session: ${session.sessionRoot}`);
  console.error(`Sandbox: ${session.sandboxDir}`);
  console.error(`Bundle: ${session.bundlePath}`);
  console.error(`Control: ${controlServer.baseUrl}`);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await Promise.all([handle.close(), controlServer.close()]);
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void close().finally(() => process.exit(0));
    });
  }

  process.once("disconnect", () => {
    console.error("Parent process disconnected, exiting");
    void close().finally(() => process.exit(2));
  });

  try {
    const credentials = await credentialManager.listCredentials();
    const hasMissing = credentials.some((c) => c.status === "missing" && !c.optional);
    if (hasMissing) {
      const credentialsUrl = `${controlServer.baseUrl}/credentials`;
      console.error(`Missing credentials detected — opening ${credentialsUrl}`);
      if (!process.env.TOKENSPACE_NO_OPEN) {
        openInBrowser(credentialsUrl);
      }
    }
  } catch {
    // Non-fatal: don't block startup if credential check fails
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
