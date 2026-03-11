import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { $ } from "bun";

type InstallTarget = "claude-code" | "claude-desktop";

type InstallOptions = {
  target: InstallTarget;
  workspace: string;
  name: string;
  skipBuild: boolean;
  dryRun: boolean;
  sessionsRootDir?: string;
  buildCacheDir?: string;
  systemDir?: string;
  claudeCodeConfig?: string;
  claudeDesktopConfig?: string;
};

type McpServerConfig = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

function usage(): string {
  return `Usage: bun run scripts/install-local-mcp.ts --target <claude-code|claude-desktop> [options]

Options:
  --workspace <path>              Workspace to run (default: ./examples/testing)
  --name <server-name>            MCP server name (default: tokenspace-local-mcp)
  --sessions-root-dir <dir>       Optional session root override
  --build-cache-dir <dir>         Optional build cache override
  --system-dir <dir>              Optional system content override
  --claude-code-config <path>     Override Claude Code config path (default: <repo>/.mcp.json)
  --claude-desktop-config <path>  Override Claude Desktop config path
  --skip-build                    Skip bun run --cwd apps/local-mcp build
  --dry-run                       Print the config update without writing it
  --help                          Show this help
`;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv: string[]): InstallOptions {
  const repoRoot = resolve(import.meta.dir, "..");
  const options: Partial<InstallOptions> = {
    workspace: resolve(process.cwd(), "examples/testing"),
    name: "tokenspace-local-mcp",
    skipBuild: false,
    dryRun: false,
    claudeCodeConfig: join(repoRoot, ".mcp.json"),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;

    if (arg === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--target") {
      const value = argv[index + 1];
      if (value !== "claude-code" && value !== "claude-desktop") {
        fail(`Invalid --target value: ${value ?? "<missing>"}`);
      }
      options.target = value;
      index += 1;
      continue;
    }
    if (arg === "--workspace") {
      options.workspace = resolve(process.cwd(), argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (arg === "--name") {
      options.name = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--sessions-root-dir") {
      options.sessionsRootDir = resolve(process.cwd(), argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (arg === "--build-cache-dir") {
      options.buildCacheDir = resolve(process.cwd(), argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (arg === "--system-dir") {
      options.systemDir = resolve(process.cwd(), argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (arg === "--claude-code-config") {
      options.claudeCodeConfig = resolve(process.cwd(), argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (arg === "--claude-desktop-config") {
      options.claudeDesktopConfig = resolve(process.cwd(), argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (arg === "--skip-build") {
      options.skipBuild = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    fail(`Unknown argument: ${arg}`);
  }

  if (!options.target) {
    fail("Missing required --target <claude-code|claude-desktop>");
  }
  if (!options.name) {
    fail("Missing server name");
  }
  if (!options.workspace) {
    fail("Missing workspace path");
  }

  return options as InstallOptions;
}

function getRepoRoot(): string {
  return resolve(import.meta.dir, "..");
}

function getCliPath(repoRoot: string): string {
  return join(repoRoot, "apps/local-mcp/dist/cli.js");
}

function getDefaultClaudeDesktopConfigPath(): string {
  const home = homedir();
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appData, "Claude", "claude_desktop_config.json");
  }
  return join(home, ".config", "Claude", "claude_desktop_config.json");
}

function buildServerArgs(options: InstallOptions, cliPath: string): string[] {
  const args = [cliPath, options.workspace];
  if (options.sessionsRootDir) {
    args.push("--sessions-root-dir", options.sessionsRootDir);
  }
  if (options.buildCacheDir) {
    args.push("--build-cache-dir", options.buildCacheDir);
  }
  if (options.systemDir) {
    args.push("--system-dir", options.systemDir);
  }
  return args;
}

async function ensureBuild(repoRoot: string, skipBuild: boolean, dryRun: boolean): Promise<void> {
  if (skipBuild || dryRun) {
    return;
  }
  await $`bun run --cwd ${join(repoRoot, "apps/local-mcp")} build`;
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail(`Config file is not a JSON object: ${filePath}`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeJsonObject(filePath: string, value: Record<string, unknown>, dryRun: boolean): Promise<void> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (dryRun) {
    console.log(`# Dry run: ${filePath}`);
    console.log(content);
    return;
  }
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

function upsertServer(
  config: Record<string, unknown>,
  serverName: string,
  serverConfig: McpServerConfig,
): Record<string, unknown> {
  const next = { ...config };
  const existingServers =
    config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)
      ? (config.mcpServers as Record<string, unknown>)
      : {};

  next.mcpServers = {
    ...existingServers,
    [serverName]: serverConfig,
  };
  return next;
}

async function installClaudeCode(options: InstallOptions, serverConfig: McpServerConfig): Promise<void> {
  const configPath = options.claudeCodeConfig ?? join(getRepoRoot(), ".mcp.json");
  const current = await readJsonObject(configPath);
  const next = upsertServer(current, options.name, serverConfig);
  await writeJsonObject(configPath, next, options.dryRun);
  console.log(`Claude Code project config ${options.dryRun ? "previewed" : "updated"}: ${configPath}`);
}

async function installClaudeDesktop(options: InstallOptions, serverConfig: McpServerConfig): Promise<void> {
  const configPath = options.claudeDesktopConfig ?? getDefaultClaudeDesktopConfigPath();
  const current = await readJsonObject(configPath);
  const next = upsertServer(current, options.name, serverConfig);
  await writeJsonObject(configPath, next, options.dryRun);
  console.log(`Claude Desktop config ${options.dryRun ? "previewed" : "updated"}: ${configPath}`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = getRepoRoot();
  const cliPath = getCliPath(repoRoot);
  const serverConfig: McpServerConfig = {
    command: Bun.which("bun") ?? "bun",
    args: buildServerArgs(options, cliPath),
  };

  await ensureBuild(repoRoot, options.skipBuild, options.dryRun);

  if (options.target === "claude-code") {
    await installClaudeCode(options, serverConfig);
  } else {
    await installClaudeDesktop(options, serverConfig);
  }

  console.log(`Server name: ${options.name}`);
  console.log(`Workspace: ${options.workspace}`);
  console.log(`Command: ${serverConfig.command} ${serverConfig.args.join(" ")}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
