import { existsSync, rmSync } from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

const PID_FILE = "dev.pid";
const CONVEX_STATE_DIR = path.join(import.meta.dir, "../.convex");

// ANSI color helpers
const reset = "\x1b[0m";

const fg = {
  red: (t: string) => `\x1b[31m${t}${reset}`,
  yellow: (t: string) => `\x1b[33m${t}${reset}`,
  green: (t: string) => `\x1b[32m${t}${reset}`,
};

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

async function getRunningDevServer(): Promise<number | null> {
  const pidFile = Bun.file(PID_FILE);
  if (!(await pidFile.exists())) {
    return null;
  }

  const pidStr = await pidFile.text();
  const pid = Number.parseInt(pidStr.trim(), 10);

  if (Number.isNaN(pid) || !isProcessAlive(pid)) {
    return null;
  }

  return pid;
}

async function killDevServer(pid: number): Promise<void> {
  console.log(fg.yellow(`Stopping dev server (PID: ${pid})...`));
  process.kill(pid, "SIGTERM");

  // Wait for the process to exit
  let attempts = 0;
  while (isProcessAlive(pid) && attempts < 50) {
    await Bun.sleep(100);
    attempts++;
  }

  if (isProcessAlive(pid)) {
    console.log(fg.yellow("Process did not exit gracefully, force killing..."));
    process.kill(pid, "SIGKILL");
  }

  console.log(fg.green("Dev server stopped."));
}

async function main() {
  const forceFlag = process.argv.includes("-f") || process.argv.includes("--force");

  // Step 1: Check if dev server is running
  const devServerPid = await getRunningDevServer();
  if (devServerPid !== null) {
    console.log(fg.yellow(`Dev server is running (PID: ${devServerPid})`));

    if (forceFlag) {
      await killDevServer(devServerPid);
    } else {
      const shouldKill = await confirm("Kill the dev server?");
      if (shouldKill) {
        await killDevServer(devServerPid);
      } else {
        console.log(fg.red("Aborted: dev server must be stopped before nuking the database."));
        process.exit(1);
      }
    }
  }

  // Step 2: Check if .convex directory exists
  if (existsSync(CONVEX_STATE_DIR)) {
    console.log(fg.yellow(`Database directory exists: ${CONVEX_STATE_DIR}`));

    let shouldDelete = forceFlag;
    if (!forceFlag) {
      shouldDelete = await confirm("Delete the database directory?");
    }

    if (shouldDelete) {
      rmSync(CONVEX_STATE_DIR, { recursive: true, force: true });
      console.log(fg.green("Database directory deleted."));
    } else {
      console.log(fg.red("Aborted: database directory not deleted."));
      process.exit(1);
    }
  } else {
    console.log(fg.green("No database directory found, nothing to delete."));
  }

  console.log(fg.green("Done!"));
}

main().catch((e) => {
  console.error(fg.red(`Error: ${e.message}`));
  process.exit(1);
});
