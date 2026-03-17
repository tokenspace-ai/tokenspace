import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import type { ConvexLogger } from "@tokenspace/convex-local-dev";
import type { Subprocess } from "bun";
import { checkBunVersion } from "./lib/bun-version";
import { runConvexLocalDev } from "./lib/convex-local-dev";
import { getAdminKey, seedConfiguredWorkspaces } from "./lib/seed";

const PID_FILE = "dev.pid";
const childProcesses: Subprocess[] = [];
let convexHandle: { stop: () => Promise<void> } | undefined;

const LOG_PREFIX_LENGTH = 8;

// ANSI color helpers (colored backgrounds with black text for readability)
const reset = "\x1b[0m";
const black = "\x1b[30m";
const c = {
  yellow: (t: string) => `\x1b[43m${black}${t}${reset}`,
  cyan: (t: string) => `\x1b[46m${black}${t}${reset}`,
  green: (t: string) => `\x1b[42m${black}${t}${reset}`,
  blue: (t: string) => `\x1b[44m${black}${t}${reset}`,
  magenta: (t: string) => `\x1b[45m${black}${t}${reset}`,
  red: (t: string) => `\x1b[41m${black}${t}${reset}`,
};

// Foreground colors (for text coloring, e.g., error messages)
const fg = {
  red: (t: string) => `\x1b[31m${t}${reset}`,
  yellow: (t: string) => `\x1b[33m${t}${reset}`,
  cyan: (t: string) => `\x1b[36m${t}${reset}`,
  blue: (t: string) => `\x1b[34m${t}${reset}`,
};

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 doesn't kill the process, just checks if it exists
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let shuttingDown = false;
let restarting = false;

async function killChildProcesses() {
  for (const proc of childProcesses) {
    proc.kill();
  }

  const GRACEFUL_TIMEOUT_MS = 5000;
  const POLL_INTERVAL_MS = 100;

  await Promise.all(
    childProcesses.map(async (proc) => {
      let elapsed = 0;
      while (elapsed < GRACEFUL_TIMEOUT_MS) {
        if (proc.exitCode !== null) return;
        await Bun.sleep(POLL_INTERVAL_MS);
        elapsed += POLL_INTERVAL_MS;
      }
      console.log(c.red(`Child process ${proc.pid} did not exit gracefully, force killing...`));
      proc.kill(9);
    }),
  );
}

async function stopServices() {
  await Promise.all([killChildProcesses(), convexHandle?.stop()]).catch((e) => {
    console.error(c.red(`Error during stop: ${e}`));
  });
  childProcesses.length = 0;
  convexHandle = undefined;
}

async function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(c.red("Shutting down..."));
  await stopServices();
  await deletePidFile();
}

async function deletePidFile(): Promise<void> {
  try {
    await unlink(PID_FILE);
  } catch {
    // Ignore errors if file doesn't exist
  }
}

async function checkExistingProcess(): Promise<boolean> {
  const pidFile = Bun.file(PID_FILE);
  if (await pidFile.exists()) {
    const pidStr = await pidFile.text();
    const pid = Number.parseInt(pidStr.trim(), 10);

    if (!Number.isNaN(pid) && isProcessAlive(pid)) {
      console.error(c.red(`ERROR: Dev server is already running (PID: ${pid})`));
      console.error("");
      console.error(
        "The dev server is already running in another process (don't kill unless a restart is absolutely required).",
      );
      console.error("To view the output, check the log files:");
      console.error(`  - ${c.yellow("logs/web.log")} for Vite output`);
      console.error(`  - ${c.magenta("logs/convex.log")} for Convex output`);
      console.error(`  - ${c.cyan("logs/executor.log")} for Executor output`);
      console.error("");
      return true;
    }

    // Stale PID file, remove it
    await deletePidFile();
  }
  return false;
}

interface RunCommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  quiet?: boolean;
  /** When set, `runCommand` returns a promise that resolves once stdout has emitted `readyCount` lines matching `readyPattern`. */
  readyPattern?: RegExp;
  readyCount?: number;
}

async function runCommand(
  name: string,
  color: (t: string) => string,
  command: Array<string>,
  { cwd, env, quiet, readyPattern, readyCount }: RunCommandOptions,
) {
  const prefix = `${color(name.padEnd(LOG_PREFIX_LENGTH, " "))}`;
  const logPath = `logs/${name}.log`;

  // Truncate the log file at start
  await Bun.write(logPath, "");
  const logFile = Bun.file(logPath);
  const logWriter = logFile.writer();

  const spawnEnv = {
    ...process.env,
    ...env,
  };

  let readyResolve: (() => void) | undefined;
  let readyPromise: Promise<void> | undefined;
  if (readyPattern && readyCount && readyCount > 0) {
    let hits = 0;
    readyPromise = new Promise<void>((resolve) => {
      readyResolve = () => {
        hits++;
        if (hits >= readyCount) resolve();
      };
    });
  }

  const proc = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    cwd: cwd,
    env: spawnEnv,
  });

  childProcesses.push(proc);

  pipeOutput(
    proc.stdout,
    prefix,
    logWriter,
    quiet,
    readyResolve ? { pattern: readyPattern!, onMatch: readyResolve } : undefined,
  );
  pipeOutput(proc.stderr, prefix, logWriter, false);

  proc.exited.then((code) => {
    if (!shuttingDown && !restarting) {
      if (quiet && code !== 0) {
        console.log(`${prefix} ${c.red(`Failed — see logs/${name}.log for full output`)}`);
      }
      console.log(`${prefix} ${c.red(`Exited with code ${code}`)}`);
      cleanup();
    }
  });

  return readyPromise;
}

async function pipeOutput(
  stream: ReadableStream<Uint8Array>,
  prefix: string,
  logWriter: ReturnType<ReturnType<typeof Bun.file>["writer"]>,
  quiet?: boolean,
  readyDetector?: { pattern: RegExp; onMatch: () => void },
) {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });

    // Process complete lines only
    const lines = buffer.split("\n");
    // Keep the last part (incomplete line) in the buffer
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.length === 0) continue;
      if (!quiet) console.log(`${prefix} ${line}`);
      logWriter.write(`${line}\n`);
      if (readyDetector?.pattern.test(line)) readyDetector.onMatch();
    }
    logWriter.flush();
  }

  // Flush any remaining buffer content
  if (buffer.length > 0) {
    if (!quiet) console.log(`${prefix} ${buffer}`);
    logWriter.write(`${buffer}\n`);
    logWriter.flush();
    if (readyDetector?.pattern.test(buffer)) readyDetector.onMatch();
  }
}

async function stopExistingProcess(): Promise<boolean> {
  const pidFile = Bun.file(PID_FILE);
  if (await pidFile.exists()) {
    const pidStr = await pidFile.text();
    const pid = Number.parseInt(pidStr.trim(), 10);

    if (!Number.isNaN(pid) && isProcessAlive(pid)) {
      console.log(c.yellow(`Stopping dev server (PID: ${pid})...`));
      process.kill(pid, "SIGTERM");

      // Wait for the process to exit
      let attempts = 0;
      while (isProcessAlive(pid) && attempts < 50) {
        await Bun.sleep(100);
        attempts++;
      }

      if (isProcessAlive(pid)) {
        console.log(c.red("Process did not exit gracefully, force killing..."));
        process.kill(pid, "SIGKILL");
      }

      console.log(c.green("Dev server stopped."));
      return true;
    }

    // Stale PID file, remove it
    cleanup();
    console.log(c.yellow("No running dev server found (stale PID file removed)."));
    return false;
  }

  console.log(c.yellow("No running dev server found."));
  return false;
}

function countLibWatchers(): number {
  const workspaceDirs = ["packages", "services", "apps"];
  let count = 0;
  for (const dir of workspaceDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgPath = `${dir}/${entry.name}/package.json`;
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      if (pkg.scripts?.["dev:lib"]) count++;
    }
  }
  return count;
}

const levelColors = {
  debug: fg.cyan,
  info: fg.blue,
  warn: fg.yellow,
  error: fg.red,
};

async function getDotEnvVariables(): Promise<Record<string, string>> {
  const vars: Record<string, string> = {};

  const dotEnv = await Bun.file(".env").text();
  for (const line of dotEnv.split("\n")) {
    const [key, _v] = line.split("=");
    if (key) {
      const value = process.env[key];
      if (value) {
        vars[key] = value;
      }
    }
  }

  return vars;
}

async function runConvex(startingPort: number) {
  const consolePrefix = c.green("convex".padEnd(LOG_PREFIX_LENGTH, " "));
  const logPath = "logs/convex.log";

  // Truncate the log file at start (same as runCommand does)
  await Bun.write(logPath, "");
  const logFile = Bun.file(logPath);
  const logWriter = logFile.writer();

  const writeLog = (level: "debug" | "info" | "warn" | "error", message: string, error?: string | Error) => {
    let fullMessage = `${levelColors[level](level.toUpperCase())} ${message}`;
    if (error) {
      const errorStr = typeof error === "string" ? error : (error.stack ?? error.toString());
      fullMessage += `\n${errorStr}`;
    }
    logWriter.write(`${fullMessage}\n`);
    logWriter.flush();
    for (const line of fullMessage.split("\n")) {
      console.log(`${consolePrefix} ${line}`);
    }
  };

  const logger: ConvexLogger = {
    debug: (message, _opts) => writeLog("debug", message),
    info: (message, _opts) => writeLog("info", message),
    warn: (message, _opts) => writeLog("warn", message),
    error: (message, opts) => writeLog("error", message, opts?.error),
  };

  if (!process.env.CONVEX_DEPLOYMENT) {
    throw new Error("CONVEX_DEPLOYMENT environment variable is not set");
  }

  convexHandle = await runConvexLocalDev({
    port: startingPort,
    siteProxyPort: startingPort + 1,
    dashboardPort: startingPort + 2,
    startDashboard: true,
    logger,
    instanceName: process.env.CONVEX_DEPLOYMENT!,
    env: await getDotEnvVariables(),
  });

  logger.info("Convex local dev server started");
}

function extractPortsFromEnvironment() {
  const webPort = Number.parseInt(process.env.WEB_PORT ?? "----", 10);
  if (Number.isNaN(webPort)) {
    throw new Error("WEB_PORT environment variable is not defined");
  }
  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    throw new Error("CONVEX_URL environment variable is not defined");
  }
  const convexPort = Number.parseInt(new URL(convexUrl).port ?? "----", 10);
  if (Number.isNaN(convexPort)) {
    throw new Error("CONVEX_URL is not a valid URL");
  }
  return {
    webPort,
    convexPort,
  };
}

function openUrl(url: string) {
  Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
}

interface StartServicesOptions {
  shouldSeed: boolean;
}

async function startServices({ shouldSeed }: StartServicesOptions) {
  const ports = extractPortsFromEnvironment();

  const libWatcherCount = countLibWatchers();
  const LIB_SETTLE_TIMEOUT_MS = 120_000;

  const libsPrefix = c.blue("libs".padEnd(LOG_PREFIX_LENGTH, " "));
  console.log(`${libsPrefix} Starting ${libWatcherCount} library watchers...`);

  const libsReady = runCommand("libs", c.blue, ["bunx", "turbo", "dev:lib"], {
    quiet: true,
    readyPattern: /Watching for file changes/,
    readyCount: libWatcherCount,
  });

  const libsSettled = await Promise.race([
    libsReady!.then(() => true),
    Bun.sleep(LIB_SETTLE_TIMEOUT_MS).then(() => false),
  ]);

  if (libsSettled) {
    console.log(`${libsPrefix} All library watchers ready`);
  } else {
    console.log(`${libsPrefix} ${c.yellow("Timed out waiting for library watchers — continuing anyway")}`);
  }

  await runConvex(ports.convexPort);
  await Bun.sleep(1000);

  const seedPrefix = c.magenta("seed".padEnd(LOG_PREFIX_LENGTH, " "));
  const log = (message: string) => console.log(`${seedPrefix} ${message}`);
  const convexUrl = process.env.CONVEX_URL!;
  const adminKey = getAdminKey();
  const seedResult = await seedConfiguredWorkspaces({
    convexUrl,
    adminKey,
    seedWorkspaces: shouldSeed,
    executorMode: "assignAndRotateBootstrap",
    log,
  });
  const bootstrapToken = seedResult.executor.bootstrapToken;
  if (!bootstrapToken) {
    throw new Error("Local dev executor bootstrap token was not returned");
  }

  runCommand("webapp", c.cyan, ["bun", "run", "dev"], {
    cwd: "apps/web",
    env: { VITE_CONVEX_URL: process.env.CONVEX_URL! },
  });
  runCommand("executor", c.yellow, ["bun", "run", "dev"], {
    cwd: "services/executor",
    env: { TOKENSPACE_TOKEN: bootstrapToken, TOKENSPACE_API_URL: process.env.CONVEX_URL! },
  });

  return ports;
}

async function restart(opts: StartServicesOptions) {
  if (restarting) return;
  restarting = true;
  const prefix = c.red("restart".padEnd(LOG_PREFIX_LENGTH, " "));
  console.log(`${prefix} Restarting all services...`);
  await stopServices();
  await startServices(opts);
  restarting = false;
  console.log(`${prefix} All services restarted`);
}

function startKeyboardShortcuts(urls: { web: string; dashboard: string }, onRestart: () => void) {
  if (!process.stdin.isTTY) return;

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  const prefix = c.blue("keys".padEnd(LOG_PREFIX_LENGTH, " "));

  process.stdin.on("data", (key: string) => {
    // Ctrl+C
    if (key === "\x03") {
      process.emit("SIGINT");
      return;
    }
    if (key === "o") {
      console.log(`${prefix} Opening webapp: ${fg.cyan(urls.web)}`);
      openUrl(urls.web);
    } else if (key === "c") {
      console.log(`${prefix} Opening Convex dashboard: ${fg.cyan(urls.dashboard)}`);
      openUrl(urls.dashboard);
    } else if (key === "m") {
      const now = new Date().toLocaleString();
      console.log("\n\n\n");
      console.log(`${prefix} ---- ${fg.cyan(`marker: ${now}`)} ----`);
    } else if (key === "h") {
      printKeyboardShortcuts();
    } else if (key === "r") {
      onRestart();
    }
  });
}

function printKeyboardShortcuts() {
  const prefix = c.blue("keys".padEnd(LOG_PREFIX_LENGTH, " "));
  console.log(`${prefix} Keyboard shortcuts:`);
  console.log(`${prefix}   ${fg.cyan("r")} - restart all services`);
  console.log(`${prefix}   ${fg.cyan("o")} - open webapp in browser`);
  console.log(`${prefix}   ${fg.cyan("c")} - open Convex dashboard in browser`);
  console.log(`${prefix}   ${fg.cyan("m")} - insert a visual marker with timestamp`);
  console.log(`${prefix}   ${fg.cyan("h")} - show this help`);
}

async function waitForSignal() {
  return new Promise((resolve) => {
    process.on("SIGINT", () => {
      resolve(true);
    });
    process.on("SIGTERM", () => {
      resolve(true);
    });
    process.on("exit", () => {
      resolve(true);
    });
  });
}

async function main() {
  try {
    const bunVersionError = checkBunVersion();
    if (bunVersionError) {
      console.error(fg.red(bunVersionError));
      process.exit(1);
    }

    // Handle "stop" argument
    if (process.argv[2] === "stop") {
      await stopExistingProcess();
      process.exit(0);
    }

    // Check flags
    const shouldSeed = process.argv.includes("--seed");
    const shouldOpenAll = process.argv.includes("--open-all");
    const shouldOpen = shouldOpenAll || process.argv.includes("--open");

    // Check if already running
    if (await checkExistingProcess()) {
      process.exit(1);
    }

    // Write PID file
    await Bun.write(PID_FILE, String(process.pid));

    if (!existsSync("logs")) {
      mkdirSync("logs");
    }

    const serviceOpts: StartServicesOptions = { shouldSeed };
    const ports = await startServices(serviceOpts);

    // Open URLs in browser if requested
    const webUrl = `http://localhost:${ports.webPort}`;
    const dashboardUrl = `http://127.0.0.1:${ports.convexPort + 2}`;

    if (shouldOpen) {
      openUrl(webUrl);
      if (shouldOpenAll) {
        openUrl(dashboardUrl);
      }
    }

    // Start keyboard shortcut listener
    startKeyboardShortcuts({ web: webUrl, dashboard: dashboardUrl }, () => {
      restart(serviceOpts);
    });
    printKeyboardShortcuts();

    await waitForSignal();
  } finally {
    await cleanup();
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e.stack);
    process.exit(1);
  },
);
