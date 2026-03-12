#!/usr/bin/env bun
/**
 * Tokenspace CLI - Sync workspace files with local filesystem
 */
import { createRequire } from "node:module";
import { program } from "commander";
import { login, logout, requireAuth, setVerbose } from "./auth.js";
import { compileWorkspace } from "./commands/compile.js";
import { listCredentials, setWorkspaceCredential } from "./commands/credentials.js";
import { initWorkspace } from "./commands/init.js";
import { linkWorkspace } from "./commands/link.js";
import { pull } from "./commands/pull.js";
import { push } from "./commands/push.js";
import { whoami } from "./commands/whoami.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

program
  .name("tokenspace")
  .description("CLI for syncing Tokenspace workspace files with local filesystem")
  .version(version)
  .option("-v, --verbose", "Enable verbose debug logging")
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.verbose) {
      setVerbose(true);
    }
  });

// Authentication commands
program
  .command("init")
  .description("Initialize a new local Tokenspace workspace")
  .argument("[directory]", "Target directory")
  .option("-n, --name <name>", "Workspace name")
  .option("-t, --template <template>", "Workspace template", "default")
  .option("--install-skill", "Install the capability-authoring skill without prompting")
  .option("--skip-install-skill", "Skip installing the capability-authoring skill")
  .option("--git-init", "Initialize a git repository without prompting")
  .option("--skip-git-init", "Skip initializing a git repository")
  .option("--bun-install", "Run bun install without prompting")
  .option("--skip-bun-install", "Skip running bun install")
  .option("-y, --yes", "Accept defaults and skip optional prompts")
  .action(async (directory: string | undefined, options) => {
    try {
      await initWorkspace({
        directory,
        name: options.name,
        template: options.template,
        yes: options.yes,
        installSkill: options.installSkill,
        skipInstallSkill: options.skipInstallSkill,
        gitInit: options.gitInit,
        skipGitInit: options.skipGitInit,
        bunInstall: options.bunInstall,
        skipBunInstall: options.skipBunInstall,
      });
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command("login")
  .description("Authenticate with Tokenspace using your browser")
  .option("--url <url>", "Web app URL to authenticate against", undefined)
  .action(async (options) => {
    try {
      await login(options.url);
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command("logout")
  .description("Sign out and clear stored credentials")
  .action(async () => {
    try {
      await logout();
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command("whoami")
  .description("Show current authentication status")
  .action(async () => {
    try {
      await requireAuth();
      await whoami();
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Workspace sync commands
program
  .command("link")
  .description("Link the current directory to an existing or newly created tokenspace")
  .argument("[slug]", "Existing tokenspace slug")
  .option("--create", "Create a new tokenspace before linking")
  .option("-n, --name <name>", "Tokenspace name when creating")
  .option("-s, --slug <slug>", "Tokenspace slug when creating or linking directly")
  .option("--relink", "Replace an existing link without prompting")
  .action(async (slug: string | undefined, options) => {
    try {
      await requireAuth();
      await linkWorkspace({
        slug: options.slug ?? slug,
        create: options.create,
        name: options.name,
        relink: options.relink,
      });
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command("pull")
  .description("Pull the linked tokenspace into the current workspace")
  .option("-n, --dry-run", "Show what would be done without making changes")
  .action(async (options) => {
    try {
      await requireAuth();
      await pull({
        dryRun: options.dryRun,
      });
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command("push")
  .description("Sync local files, build the workspace, and push a revision for the linked tokenspace")
  .option("-n, --dry-run", "Show what would be done without making changes")
  .option("--open", "Open the pushed revision in the browser")
  .action(async (options) => {
    try {
      await requireAuth();
      await push({
        dryRun: options.dryRun,
        open: options.open,
      });
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command("compile")
  .description("Compile the local tokenspace into build artifacts")
  .option("-d, --out-dir <dir>", "Output directory", "build/tokenspace")
  .action(async (options) => {
    try {
      await compileWorkspace({
        outDir: options.outDir,
      });
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

const credentials = program.command("credentials").description("List and set workspace credentials");

credentials
  .command("list")
  .description("List declared credentials for the linked tokenspace revision")
  .action(async () => {
    try {
      await requireAuth();
      await listCredentials();
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

credentials
  .command("set")
  .description("Set a workspace-scoped secret credential")
  .argument("<credential-id>", "Credential id declared in the current revision")
  .option("--stdin", "Read the secret value from stdin instead of prompting")
  .action(async (credentialId: string, options) => {
    try {
      await requireAuth();
      await setWorkspaceCredential(credentialId, {
        stdin: options.stdin,
      });
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
