import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import pc from "picocolors";

const DEFAULT_TEMPLATE = "default";
const DEFAULT_INTERNAL_PACKAGE_VERSION = "0.1.0";
const DEFAULT_ZOD_VERSION = "^4.3.5";
const DEFAULT_TYPESCRIPT_VERSION = "^5.9.3";
const DEFAULT_TYPES_BUN_VERSION = "^1.3.6";
const VALID_IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED_IDENTIFIERS = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "__tokenspace",
  "capabilities",
  "system",
]);

interface JsonObject {
  [key: string]: unknown;
}

interface DependencyVersions {
  tokenspaceCompiler: string;
  tokenspaceSdk: string;
  typescript: string;
  typesBun: string;
  zod: string;
}

interface PackageContext {
  dependencyVersionsPath: string;
  packageJsonPath: string;
}

let packageContextPromise: Promise<PackageContext> | undefined;
let activePromptInterface: readline.Interface | null = null;
let bufferedPromptLinesPromise: Promise<string[]> | null = null;
let bufferedPromptLines: string[] | null = null;

const CAPABILITY_AUTHORING_SKILL_REPO = "https://github.com/tokenspace-ai/skills";
const CAPABILITY_AUTHORING_SKILL_NAME = "capability-authoring";
const CAPABILITY_AUTHORING_SKILL_AGENT = "claude-code";
const BUNX_BIN = process.env.TOKENSPACE_BUNX_BIN ?? "bunx";
const GIT_BIN = process.env.TOKENSPACE_GIT_BIN ?? "git";
const BUN_INSTALL_BIN = process.env.TOKENSPACE_BUN_INSTALL_BIN ?? process.execPath;
const CAPABILITY_AUTHORING_SKILL_INSTALL_COMMAND = {
  display: `bunx skills add ${CAPABILITY_AUTHORING_SKILL_REPO} --skill ${CAPABILITY_AUTHORING_SKILL_NAME} --agent ${CAPABILITY_AUTHORING_SKILL_AGENT} -y`,
  command: [
    BUNX_BIN,
    "skills",
    "add",
    CAPABILITY_AUTHORING_SKILL_REPO,
    "--skill",
    CAPABILITY_AUTHORING_SKILL_NAME,
    "--agent",
    CAPABILITY_AUTHORING_SKILL_AGENT,
    "-y",
  ],
};
const GIT_INIT_COMMAND = {
  display: 'git init && git add . && git commit -m "init tokenspace"',
  commands: [
    [GIT_BIN, "init"],
    [GIT_BIN, "add", "."],
    [GIT_BIN, "commit", "-m", "init tokenspace"],
  ],
};
const BUN_INSTALL_COMMAND = {
  display: "bun install",
  command: [BUN_INSTALL_BIN, "install"],
};

type SetupChoice = "prompt" | "run" | "skip";

export interface InitOptions {
  directory?: string;
  name?: string;
  template?: string;
  yes?: boolean;
  installSkill?: boolean;
  skipInstallSkill?: boolean;
  gitInit?: boolean;
  skipGitInit?: boolean;
  bunInstall?: boolean;
  skipBunInstall?: boolean;
}

async function prompt(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    process.stdout.write(question);
    const lines = await getBufferedPromptLines();
    return (lines.shift() ?? "").trim();
  }

  if (!activePromptInterface) {
    activePromptInterface = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  return new Promise((resolve) => {
    activePromptInterface!.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function getBufferedPromptLines(): Promise<string[]> {
  if (bufferedPromptLines) {
    return bufferedPromptLines;
  }

  if (!bufferedPromptLinesPromise) {
    bufferedPromptLinesPromise = new Promise((resolve, reject) => {
      const chunks: string[] = [];
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk: string) => {
        chunks.push(chunk);
      });
      process.stdin.on("end", () => {
        const joined = chunks.join("");
        resolve(joined.split(/\r?\n/));
      });
      process.stdin.on("error", reject);
      process.stdin.resume();
    });
  }

  bufferedPromptLines = await bufferedPromptLinesPromise;
  return bufferedPromptLines;
}

function closePromptInterface(): void {
  if (!activePromptInterface) {
    return;
  }
  activePromptInterface.close();
  activePromptInterface = null;
}

async function confirm(question: string, defaultValue = true): Promise<boolean> {
  const suffix = defaultValue ? " [Y/n] " : " [y/N] ";
  const answer = (await prompt(pc.cyan(`${question}${suffix}`))).toLowerCase();
  if (!answer) {
    return defaultValue;
  }
  if (["y", "yes"].includes(answer)) {
    return true;
  }
  if (["n", "no"].includes(answer)) {
    return false;
  }
  throw new Error(`Invalid response '${answer}'. Expected yes or no.`);
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function toDisplayPath(targetDir: string): string {
  const relative = path.relative(process.cwd(), targetDir);
  if (!relative) {
    return ".";
  }
  if (!relative.startsWith(".") && !path.isAbsolute(relative)) {
    return `./${relative}`;
  }
  return relative;
}

function toWorkspacePackageName(slug: string): string {
  return slug.endsWith("-workspace") ? slug : `${slug}-workspace`;
}

function toCapabilityName(slug: string): string {
  const parts = slug
    .split(/[^A-Za-z0-9_$]+/)
    .map((part) => part.replace(/^[^A-Za-z_$]+/, ""))
    .filter(Boolean);

  if (parts.length === 0) {
    return "workspace";
  }

  const [first, ...rest] = parts;
  const candidate = [first!.toLowerCase(), ...rest.map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`)].join("");

  if (!VALID_IDENTIFIER_RE.test(candidate) || RESERVED_IDENTIFIERS.has(candidate)) {
    return "workspace";
  }

  return candidate;
}

function toTitleCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

async function readJsonFile(filePath: string): Promise<JsonObject> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as JsonObject;
}

async function readJsonFileIfExists(filePath: string): Promise<JsonObject | undefined> {
  try {
    return await readJsonFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function getNestedString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function getFromDependencyBlock(record: JsonObject, block: string, dependency: string): string | undefined {
  const value = record[block];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const dependencyValue = (value as JsonObject)[dependency];
  return typeof dependencyValue === "string" ? dependencyValue : undefined;
}

function toSemverRange(version: string | undefined, fallback: string): string {
  if (!version) {
    return fallback;
  }
  return version.startsWith("^") || version.startsWith("~") ? version : `^${version}`;
}

function resolveSetupChoice(args: { enable?: boolean; skip?: boolean; yes?: boolean; label: string }): SetupChoice {
  if (args.enable && args.skip) {
    throw new Error(`Cannot combine --${args.label} and --skip-${args.label}`);
  }
  if (args.skip) {
    return "skip";
  }
  if (args.enable || args.yes) {
    return "run";
  }
  return "prompt";
}

async function runExternalCommand(args: { command: string[]; cwd: string; failureMessage: string }): Promise<void> {
  const proc = Bun.spawn(args.command, {
    cwd: args.cwd,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
    env: process.env,
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`${args.failureMessage}\nCommand: ${args.command.join(" ")}`);
  }
}

async function maybeRunSetupStep(args: {
  choice: SetupChoice;
  cwd: string;
  heading: string;
  question: string;
  commands: string[][];
  display: string;
  failureMessage: string;
}): Promise<boolean> {
  let shouldRun = args.choice === "run";
  if (args.choice === "prompt") {
    console.log();
    console.log(args.heading);
    console.log(`  ${pc.dim("Command:")} ${args.display}`);
    shouldRun = await confirm(args.question, true);
  }

  if (!shouldRun) {
    return false;
  }

  console.log();
  console.log(args.heading);
  console.log(`  ${pc.dim("Command:")} ${args.display}`);
  for (const command of args.commands) {
    await runExternalCommand({
      command,
      cwd: args.cwd,
      failureMessage: args.failureMessage,
    });
  }
  return true;
}

async function resolvePackageContext(): Promise<PackageContext> {
  if (packageContextPromise) {
    return packageContextPromise;
  }

  packageContextPromise = (async () => {
    let currentDir = path.dirname(fileURLToPath(import.meta.url));
    while (true) {
      const packageJsonPath = path.join(currentDir, "package.json");
      try {
        await stat(packageJsonPath);
        const initAssetsDir = path.join(currentDir, "assets/init");
        return {
          packageJsonPath,
          dependencyVersionsPath: path.join(initAssetsDir, "dependency-versions.json"),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        throw new Error("Unable to resolve the tokenspace CLI package root");
      }
      currentDir = parentDir;
    }
  })();

  return packageContextPromise;
}

async function loadDependencyVersions(): Promise<DependencyVersions> {
  const { dependencyVersionsPath, packageJsonPath } = await resolvePackageContext();
  const [cliPackage, packagedVersions] = await Promise.all([
    readJsonFile(packageJsonPath),
    readJsonFileIfExists(dependencyVersionsPath),
  ]);

  const internalVersion =
    getNestedString(packagedVersions ?? {}, "tokenspaceCompiler") ??
    getNestedString(packagedVersions ?? {}, "tokenspaceSdk") ??
    getNestedString(cliPackage, "version") ??
    DEFAULT_INTERNAL_PACKAGE_VERSION;

  return {
    tokenspaceCompiler: toSemverRange(
      getNestedString(packagedVersions ?? {}, "tokenspaceCompiler") ?? internalVersion,
      "^0.1.0",
    ),
    tokenspaceSdk: toSemverRange(getNestedString(packagedVersions ?? {}, "tokenspaceSdk") ?? internalVersion, "^0.1.0"),
    typescript:
      getNestedString(packagedVersions ?? {}, "typescript") ??
      getFromDependencyBlock(cliPackage, "devDependencies", "typescript") ??
      DEFAULT_TYPESCRIPT_VERSION,
    typesBun:
      getNestedString(packagedVersions ?? {}, "typesBun") ??
      getFromDependencyBlock(cliPackage, "devDependencies", "@types/bun") ??
      DEFAULT_TYPES_BUN_VERSION,
    zod: getNestedString(packagedVersions ?? {}, "zod") ?? DEFAULT_ZOD_VERSION,
  };
}

function renderPackageJson(slug: string, versions: DependencyVersions): string {
  return `${JSON.stringify(
    {
      name: toWorkspacePackageName(slug),
      private: true,
      scripts: {
        build: "tokenspace-compiler build --workspace . --out-dir build/tokenspace",
      },
      dependencies: {
        "@tokenspace/sdk": versions.tokenspaceSdk,
        zod: versions.zod,
      },
      devDependencies: {
        "@tokenspace/compiler": versions.tokenspaceCompiler,
        "@types/bun": versions.typesBun,
        typescript: versions.typescript,
      },
    },
    null,
    2,
  )}\n`;
}

function renderGitignore(): string {
  return `${["node_modules/", "build/", ".turbo/", ".tokenspace/"].join("\n")}\n`;
}

function renderTsconfig(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        rootDir: ".",
        target: "ES2022",
        module: "CommonJS",
        moduleResolution: "node",
        strict: true,
        skipLibCheck: true,
        allowJs: true,
        allowSyntheticDefaultImports: true,
        esModuleInterop: true,
      },
    },
    null,
    2,
  )}\n`;
}

function renderTokenspaceMd(workspaceName: string): string {
  return `# ${workspaceName}

This tokenspace was created with \`tokenspace init\`. Change this file to give the AI agent instructions on how to use this tokenspace.
`;
}

function renderReadmeMd(workspaceName: string, capabilityName: string): string {
  return `# ${workspaceName}

## Starter Contents

- \`src/capabilities/${capabilityName}/\` contains a placeholder capability.
- \`src/credentials.ts\` is where workspace credential definitions live.
- Claude Code and standards-compatible agents can install \`capability-authoring\` during setup to help author new capabilities safely.

## Next Steps

1. Replace the starter capability with actions for your domain.
2. Add credentials in \`src/credentials.ts\` when external systems need auth.
3. Update TOKENSPACE.md to give the AI agent instructions on how to use this tokenspace.
4. Run \`bun run build\` to compile the workspace for local MCP or cloud usage.
`;
}

function renderCredentialsTs(): string {
  return `// Define workspace credentials here when a capability needs secrets, env vars, or OAuth.
//
// import { credentials } from "@tokenspace/sdk";
//
// export const exampleApiKey = credentials.secret({
//   id: "example-api-key",
//   group: "Example",
//   label: "API Key",
//   scope: "workspace",
// });

export {};
`;
}

function renderCapabilityTs(workspaceName: string): string {
  return `import { action } from "@tokenspace/sdk";
import z from "zod";

export const hello = action(z.object({}), async () => {
  return {
    ok: true as const,
    message: ${JSON.stringify(`The ${workspaceName} workspace scaffold is ready.`)},
  };
});
`;
}

function renderCapabilityMd(capabilityName: string): string {
  const title = toTitleCase(capabilityName) || "Workspace";
  return `---
name: ${title}
description: Starter capability scaffold for this workspace
---

## When to Use This Capability

- Use it as a safe starting point for your first workspace actions.
- Replace it once you know the real domain and operations you want to expose.

## Scope and Guardrails

- This starter capability is intentionally minimal and does not call external systems.
- Add runtime input validation and domain checks before introducing real integrations.

## Available Operations

### Read Actions (autonomous)

- \`hello\` - confirms the scaffold is wired correctly. (approval: not required)
`;
}

async function ensureMissingTargetDirectory(targetDir: string): Promise<void> {
  try {
    await stat(targetDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`Target directory already exists: ${targetDir}`);
}

async function writeWorkspaceFiles(args: {
  targetDir: string;
  slug: string;
  workspaceName: string;
  capabilityName: string;
  versions: DependencyVersions;
}): Promise<void> {
  const capabilityDir = path.join(args.targetDir, "src/capabilities", args.capabilityName);
  await mkdir(capabilityDir, { recursive: true });

  await Promise.all([
    writeFile(path.join(args.targetDir, "package.json"), renderPackageJson(args.slug, args.versions), "utf8"),
    writeFile(path.join(args.targetDir, ".gitignore"), renderGitignore(), "utf8"),
    writeFile(path.join(args.targetDir, "TOKENSPACE.md"), renderTokenspaceMd(args.workspaceName), "utf8"),
    writeFile(path.join(args.targetDir, "README.md"), renderReadmeMd(args.workspaceName, args.capabilityName), "utf8"),
    writeFile(path.join(args.targetDir, "tsconfig.json"), renderTsconfig(), "utf8"),
    writeFile(path.join(args.targetDir, "src/credentials.ts"), renderCredentialsTs(), "utf8"),
    writeFile(path.join(capabilityDir, "capability.ts"), renderCapabilityTs(args.workspaceName), "utf8"),
    writeFile(path.join(capabilityDir, "CAPABILITY.md"), renderCapabilityMd(args.capabilityName), "utf8"),
  ]);
}

function printNextSteps(args: {
  displayDir: string;
  workspaceName: string;
  slug: string;
  installedDependencies: boolean;
  installedSkill: boolean;
}): void {
  console.log();
  console.log(pc.green("Workspace scaffold created."));
  console.log();
  console.log(pc.bold("Local"));
  console.log(`  cd ${args.displayDir}`);
  if (!args.installedDependencies) {
    console.log("  bun install");
  }
  console.log("  bun run build");
  console.log("  bunx @tokenspace/local-mcp .");
  if (!args.installedSkill) {
    console.log(`  ${CAPABILITY_AUTHORING_SKILL_INSTALL_COMMAND.display}`);
  }
  console.log();
  console.log(pc.bold("Cloud"));
  console.log("  tokenspace login");
  console.log(
    `  tokenspace link --create --name ${JSON.stringify(args.workspaceName)} --slug ${JSON.stringify(args.slug)}`,
  );
  console.log("  tokenspace push");
}

export async function initWorkspace(options: InitOptions): Promise<void> {
  try {
    const template = options.template ?? DEFAULT_TEMPLATE;
    if (template !== DEFAULT_TEMPLATE) {
      throw new Error(`Unknown template '${template}'. Available templates: ${DEFAULT_TEMPLATE}`);
    }

    let workspaceName = options.name;
    if (!workspaceName) {
      workspaceName = await prompt(pc.cyan("Workspace name: "));
    }

    if (!workspaceName) {
      throw new Error("Workspace name is required");
    }

    const slug = slugify(workspaceName) || "workspace";
    const capabilityName = toCapabilityName(slug);
    const targetDir = path.resolve(options.directory ?? slug);
    const displayDir = toDisplayPath(targetDir);

    console.log();
    console.log(pc.bold("Initializing Tokenspace workspace"));
    console.log(`  ${pc.dim("Template:")} ${DEFAULT_TEMPLATE}`);
    console.log(`  ${pc.dim("Directory:")} ${displayDir}`);

    await ensureMissingTargetDirectory(targetDir);

    const versions = await loadDependencyVersions();
    await writeWorkspaceFiles({
      targetDir,
      slug,
      workspaceName,
      capabilityName,
      versions,
    });

    const installSkillChoice = resolveSetupChoice({
      enable: options.installSkill,
      skip: options.skipInstallSkill,
      yes: options.yes,
      label: "install-skill",
    });
    const gitInitChoice = resolveSetupChoice({
      enable: options.gitInit,
      skip: options.skipGitInit,
      yes: options.yes,
      label: "git-init",
    });
    const bunInstallChoice = resolveSetupChoice({
      enable: options.bunInstall,
      skip: options.skipBunInstall,
      yes: options.yes,
      label: "bun-install",
    });

    const installedSkill = await maybeRunSetupStep({
      choice: installSkillChoice,
      cwd: targetDir,
      heading: pc.bold("Install capability-authoring skill"),
      question: "Run this command?",
      commands: [CAPABILITY_AUTHORING_SKILL_INSTALL_COMMAND.command],
      display: CAPABILITY_AUTHORING_SKILL_INSTALL_COMMAND.display,
      failureMessage: "Failed to install the capability-authoring skill.",
    });

    const installedDependencies = await maybeRunSetupStep({
      choice: bunInstallChoice,
      cwd: targetDir,
      heading: pc.bold("Install workspace dependencies"),
      question: "Run this command?",
      commands: [BUN_INSTALL_COMMAND.command],
      display: BUN_INSTALL_COMMAND.display,
      failureMessage: "Failed to install workspace dependencies.",
    });

    await maybeRunSetupStep({
      choice: gitInitChoice,
      cwd: targetDir,
      heading: pc.bold("Initialize git repository and create the first commit"),
      question: "Run this command?",
      commands: GIT_INIT_COMMAND.commands,
      display: GIT_INIT_COMMAND.display,
      failureMessage: "Failed to initialize a git repository.",
    });

    printNextSteps({
      displayDir,
      workspaceName,
      slug,
      installedDependencies,
      installedSkill,
    });
  } finally {
    closePromptInterface();
  }
}
