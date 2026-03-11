import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTINS } from "@tokenspace/types";
import { build } from "esbuild";
import YAML from "yaml";
import { type CompilationDiagnostic, compileDeclarations, type SourceFile } from "./compiler";
import { type CredentialRequirementSummary, extractCredentialRequirementsFromWorkspace } from "./credential-extraction";

const CAPABILITY_ENTRYPOINT_RE = /^src\/capabilities\/([^/]+)\/capability\.ts$/;
const CAPABILITY_DECLARATION_RE = /^capabilities\/([^/]+)\/capability\.d\.ts$/;
const COMMAND_ENTRYPOINT_RE = /^src\/commands\/([^/]+)\/command\.ts$/;
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const RESERVED_NAMESPACE_GLOBALS = new Set([
  "__tokenspace",
  "session",
  "fs",
  "bash",
  "sleep",
  "debug",
  "DEBUG_ENABLED",
  "TokenspaceError",
  "ApprovalRequiredError",
  "isApprovalRequest",
  "console",
  "setTimeout",
  "clearTimeout",
]);

const RESERVED_NAMESPACE_KEYWORDS = new Set([
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
]);

const RESERVED_DIRS = ["capabilities", "system"];
const INCLUDED_ROOT_DIRS = new Set(["src", "docs", "memory", "skills"]);
const INCLUDED_ROOT_FILES = new Set(["TOKENSPACE.md", "package.json", "bun.lock", "bun.lockb"]);
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".pdf",
  ".zip",
  ".lockb",
]);

export type WorkspaceModelDefinition = {
  id?: string;
  modelId: string;
  label?: string;
  isDefault: boolean;
  systemPrompt?: string;
  providerOptions?: Record<string, unknown>;
};

export type CapabilitySummary = {
  path: string;
  typesPath: string;
  name: string;
  description: string;
};

export type SkillSummary = {
  path: string;
  name: string;
  description: string;
};

export type RevisionFilesystemArtifact = {
  declarations: Array<{ fileName: string; content: string }>;
  files: Array<{ path: string; content: string; binary?: boolean }>;
  system: Array<{ path: string; content: string }>;
  builtins: string;
};

export type RevisionDepsArtifact = {
  packageJson?: string;
  bunLock?: string;
  bunLockbBase64?: string;
};

export type MetadataArtifact = {
  capabilities: CapabilitySummary[];
  skills: SkillSummary[];
  tokenspaceMd?: string;
  credentialRequirements: CredentialRequirementSummary[];
  models: WorkspaceModelDefinition[];
};

export type DiagnosticsArtifact = {
  declarationDiagnostics: Array<{ file?: string; message: string; line?: number; column?: number; code: number }>;
  timingsMs: Record<string, number>;
  warnings: string[];
};

export type BuildManifest = {
  schemaVersion: number;
  compilerVersion: string;
  mode: "local" | "server";
  workspaceRoot: string;
  sourceFingerprint: string;
  createdAt: string;
  artifacts: {
    revisionFs: { path: string; hash: string; size: number };
    bundle: { path: string; hash: string; size: number };
    metadata: { path: string; hash: string; size: number };
    diagnostics: { path: string; hash: string; size: number };
    deps?: { path: string; hash: string; size: number };
  };
};

export type BuildWorkspaceOptions = {
  workspaceDir: string;
  outDir: string;
  mode?: "local" | "server";
  credentialEvalTimeoutMs?: number;
  onProgress?: (event: BuildProgressEvent) => void;
};

export type BuildWorkspaceResult = {
  manifest: BuildManifest;
  revisionFs: RevisionFilesystemArtifact;
  bundleCode: string;
  metadata: MetadataArtifact;
  diagnostics: DiagnosticsArtifact;
  deps: RevisionDepsArtifact | null;
};

type WorkspaceSourceEntry = {
  path: string;
  content: string;
  size: number;
  binary?: boolean;
};

export type BuildProgressEvent = {
  phase:
    | "start"
    | "readWorkspace"
    | "compileDeclarations"
    | "bundle"
    | "extractPromptMetadata"
    | "extractCredentials"
    | "resolveModels"
    | "writeArtifacts"
    | "done";
  message?: string;
  details?: Record<string, unknown>;
};

const DEFAULT_MODELS: WorkspaceModelDefinition[] = [
  { isDefault: true, modelId: "anthropic/claude-haiku-4.5" },
  { isDefault: false, modelId: "anthropic/claude-opus-4.6" },
  { isDefault: false, modelId: "google/gemini-3-pro-preview" },
];

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function sha256(content: string | Uint8Array): string {
  const hash = createHash("sha256");
  hash.update(content);
  return hash.digest("hex");
}

function isBinaryPath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

function assertValidCapabilityNamespace(capabilityName: string): void {
  if (!IDENTIFIER_RE.test(capabilityName)) {
    throw new Error(`Invalid capability namespace "${capabilityName}".`);
  }
  if (RESERVED_NAMESPACE_GLOBALS.has(capabilityName)) {
    throw new Error(`Capability namespace "${capabilityName}" is reserved and cannot be used.`);
  }
  if (RESERVED_NAMESPACE_KEYWORDS.has(capabilityName)) {
    throw new Error(`Capability namespace "${capabilityName}" is a reserved keyword and cannot be used.`);
  }
}

function wrapCapabilityDeclarationsInNamespace(capabilityName: string, declaration: string): string {
  const declarationWithoutImports = declaration.replace(/^\s*import[\s\S]*?;\s*$/gm, "");
  const trimmed = declarationWithoutImports.trim();
  if (!trimmed) {
    return `declare namespace ${capabilityName} {}\n`;
  }

  const declarationWithoutComments = trimmed.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  if (/\bdeclare\s+function\b/.test(declarationWithoutComments)) {
    throw new Error(
      `Capability "${capabilityName}" exports one or more functions using "export function". Export actions via action(schema, handler) instead.`,
    );
  }

  const indented = trimmed
    .split("\n")
    .map((line) => (line.length > 0 ? `  ${line}` : line))
    .join("\n");
  return `declare namespace ${capabilityName} {\n${indented}\n}\n`;
}

async function walkFiles(root: string, current: string, outDirNormalized: string): Promise<WorkspaceSourceEntry[]> {
  const files: WorkspaceSourceEntry[] = [];
  const entries = await readdir(current, { withFileTypes: true });
  const atWorkspaceRoot = normalizePath(path.relative(root, current)) === "";
  const outDirRoot = outDirNormalized ? outDirNormalized.split("/")[0] : "";

  for (const entry of entries) {
    const entryName = entry.name;
    if (!entryName || entryName === "." || entryName === "..") continue;
    if (entryName === "node_modules" || entryName === ".git") continue;
    if (atWorkspaceRoot) {
      if (entry.isDirectory() && !INCLUDED_ROOT_DIRS.has(entryName) && entryName !== outDirRoot) {
        continue;
      }
      if (entry.isFile() && !INCLUDED_ROOT_FILES.has(entryName)) {
        continue;
      }
    }

    const fullPath = path.join(current, entryName);
    const fileStat = await lstat(fullPath);

    if (fileStat.isSymbolicLink()) continue;

    if (fileStat.isDirectory()) {
      const relativeDir = normalizePath(path.relative(root, fullPath));
      if (relativeDir && outDirNormalized && relativeDir === outDirNormalized) continue;
      files.push(...(await walkFiles(root, fullPath, outDirNormalized)));
      continue;
    }

    if (!fileStat.isFile()) continue;

    const relativePath = normalizePath(path.relative(root, fullPath));
    if (!relativePath || relativePath.startsWith(".")) continue;

    const binary = isBinaryPath(relativePath);
    if (binary) {
      const content = (await readFile(fullPath)).toString("base64");
      files.push({ path: relativePath, content, size: fileStat.size, binary: true });
    } else {
      const content = await readFile(fullPath, "utf8");
      files.push({ path: relativePath, content, size: fileStat.size, binary: false });
    }
  }

  return files;
}

async function readWorkspaceSourceEntries(
  workspaceDir: string,
  outDirRelativeToWorkspace = "",
): Promise<WorkspaceSourceEntry[]> {
  const allFiles = await walkFiles(workspaceDir, workspaceDir, outDirRelativeToWorkspace);
  validateWorkspaceStructure(allFiles);
  return allFiles;
}

function validateWorkspaceStructure(files: Array<{ path: string }>): void {
  for (const file of files) {
    const topDir = file.path.split("/")[0];
    if (topDir && RESERVED_DIRS.includes(topDir)) {
      throw new Error(`Reserved directory "${topDir}/" cannot be used at workspace root. Use src/${topDir}/ instead.`);
    }
  }
}

function parseNamedDescriptionFrontmatter(content: string): { name: string; description: string } | null {
  const normalized = content.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---\n")) {
    return null;
  }
  const lines = normalized.split("\n");
  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (line === "---" || line === "...") {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) return null;

  const yamlContent = lines.slice(1, endIndex).join("\n");
  if (!yamlContent.trim()) return null;

  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlContent);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";

  if (!name || !description) {
    return null;
  }

  return { name, description };
}

function extractPromptMetadata(entries: Array<{ path: string; content: string }>): {
  capabilities: CapabilitySummary[];
  skills: SkillSummary[];
} {
  const capabilities: CapabilitySummary[] = [];
  const skills: SkillSummary[] = [];

  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    if (entry.path.startsWith("capabilities/") && entry.path.endsWith("/CAPABILITY.md")) {
      const fm = parseNamedDescriptionFrontmatter(entry.content);
      if (!fm) continue;
      capabilities.push({
        path: entry.path,
        typesPath: entry.path.replace(/CAPABILITY\.md$/, "capability.d.ts"),
        name: fm.name,
        description: fm.description,
      });
      continue;
    }

    if (
      (entry.path.startsWith("skills/") || entry.path.startsWith("system/skills/")) &&
      entry.path.endsWith("/SKILL.md")
    ) {
      const fm = parseNamedDescriptionFrontmatter(entry.content);
      if (!fm) continue;
      skills.push({ path: entry.path, name: fm.name, description: fm.description });
    }
  }

  return { capabilities, skills };
}

function parseWorkspaceModelsYaml(content: string, source = "src/models.yaml"): WorkspaceModelDefinition[] {
  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`${source} is not valid YAML: ${details}`);
  }

  const rawModels = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray((parsed as any).models)
      ? (parsed as any).models
      : undefined;

  if (!rawModels || !Array.isArray(rawModels)) {
    throw new Error(`${source} must contain a top-level "models" array or be an array itself`);
  }

  const normalized = rawModels.map((model, index) => {
    if (!model || typeof model !== "object" || Array.isArray(model)) {
      throw new Error(`${source} entry at index ${index} must be an object`);
    }
    const record = model as Record<string, unknown>;
    const modelId = typeof record.modelId === "string" ? record.modelId.trim() : "";
    if (!modelId) {
      throw new Error(`${source} entry at index ${index} is missing a non-empty modelId`);
    }
    const isDefault = record.isDefault === undefined ? false : record.isDefault;
    if (typeof isDefault !== "boolean") {
      throw new Error(`${source} entry "${modelId}" must set isDefault to true or false`);
    }

    const out: WorkspaceModelDefinition = {
      id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : modelId,
      modelId,
      isDefault,
    };

    if (typeof record.label === "string" && record.label.trim()) {
      out.label = record.label.trim();
    }
    if (typeof record.systemPrompt === "string" && record.systemPrompt.trim()) {
      out.systemPrompt = record.systemPrompt.trim();
    }
    if (
      record.providerOptions &&
      typeof record.providerOptions === "object" &&
      !Array.isArray(record.providerOptions)
    ) {
      out.providerOptions = record.providerOptions as Record<string, unknown>;
    }

    return out;
  });

  if (normalized.length === 0) {
    throw new Error(`${source} must contain at least one model`);
  }

  const defaults = normalized.filter((x) => x.isDefault).length;
  if (defaults !== 1) {
    throw new Error(`${source} must contain exactly one default model (isDefault: true)`);
  }

  return normalized;
}

function getRevisionDepsArtifact(
  files: Array<{ path: string; content: string; binary?: boolean }>,
): RevisionDepsArtifact | null {
  const packageJson = files.find((f) => f.path === "package.json")?.content;
  const bunLock = files.find((f) => f.path === "bun.lock")?.content;
  const bunLockb = files.find((f) => f.path === "bun.lockb");
  const bunLockbBase64 = bunLockb?.binary ? bunLockb.content : undefined;

  if (!packageJson && !bunLock && !bunLockbBase64) {
    return null;
  }

  return { packageJson, bunLock, bunLockbBase64 };
}

async function bundleWithEsbuild(
  workspaceDir: string,
  sources: Array<{ path: string; content: string }>,
): Promise<string> {
  if (sources.length === 0) {
    return "";
  }

  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tokenspace-compiler-"));
  const entryPath = path.join(tmpRoot, "bundle-entry.ts");

  try {
    const capabilityEntrypoints = sources
      .map((source) => {
        const match = source.path.match(CAPABILITY_ENTRYPOINT_RE);
        if (!match) return null;
        const capabilityName = match[1]!;
        assertValidCapabilityNamespace(capabilityName);
        return { capabilityName, path: source.path };
      })
      .filter((entry): entry is { capabilityName: string; path: string } => entry !== null)
      .sort((a, b) => a.capabilityName.localeCompare(b.capabilityName));

    const commandModules = sources
      .map((source) => {
        const match = source.path.match(COMMAND_ENTRYPOINT_RE);
        if (!match) return null;
        return { name: match[1]!, path: source.path };
      })
      .filter((entry): entry is { name: string; path: string } => entry !== null)
      .sort((a, b) => a.name.localeCompare(b.name));

    const exportStatements = capabilityEntrypoints
      .map(
        (entry) => `export * as ${entry.capabilityName} from ${JSON.stringify(path.join(workspaceDir, entry.path))};`,
      )
      .join("\n");

    const commandRegistry = `export const __tokenspace = {\n  commands: [\n${commandModules
      .map(
        (command) =>
          `    { name: ${JSON.stringify(command.name)}, load: () => import(${JSON.stringify(path.join(workspaceDir, command.path))}) },`,
      )
      .join("\n")}\n  ],\n};\n`;

    await writeFile(
      entryPath,
      `// Auto-generated bundle entry point\n${exportStatements}\n\n${commandRegistry}\n`,
      "utf8",
    );

    const bareModuleExternalizer = {
      name: "bare-module-externalizer",
      setup(pluginBuild: any) {
        pluginBuild.onResolve({ filter: /^[^./].*/ }, (args: any) => ({ path: args.path, external: true }));
      },
    };

    const result = await build({
      entryPoints: [entryPath],
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      target: ["node18", "es2022"],
      minify: false,
      keepNames: true,
      sourcemap: "inline",
      absWorkingDir: workspaceDir,
      plugins: [bareModuleExternalizer],
      external: [
        "@tokenspace/commands",
        "@tokenspace/sdk",
        "zod",
        "node:*",
        "fs",
        "path",
        "crypto",
        "http",
        "https",
        "url",
        "util",
        "stream",
        "buffer",
        "events",
        "os",
        "child_process",
        "net",
        "tls",
        "dns",
        "querystring",
        "assert",
      ],
    });

    const output = result.outputFiles?.[0];
    if (!output) {
      throw new Error("Bundle produced no output");
    }

    return output.text;
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

function resolveModels(files: Array<{ path: string; content: string; binary?: boolean }>): WorkspaceModelDefinition[] {
  const modelsFile = files.find((f) => f.path === "src/models.yaml");
  if (!modelsFile) {
    return DEFAULT_MODELS.map((model) => ({ ...model }));
  }
  if (modelsFile.binary) {
    throw new Error("Invalid src/models.yaml: file is binary");
  }
  return parseWorkspaceModelsYaml(modelsFile.content);
}

function computeSourceFingerprint(files: Array<{ path: string; content: string; binary?: boolean }>): string {
  const repr = [...files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => `${f.path}:${f.binary ? "1" : "0"}:${sha256(f.content)}`)
    .join("|");
  return sha256(repr);
}

export async function fingerprintWorkspaceSource(options: { workspaceDir: string; outDir?: string }): Promise<string> {
  const workspaceDir = path.resolve(options.workspaceDir);
  const outDir = options.outDir ? path.resolve(options.outDir) : undefined;
  const outDirRelativeToWorkspace = outDir ? normalizePath(path.relative(workspaceDir, outDir)) : "";
  const allFiles = await readWorkspaceSourceEntries(workspaceDir, outDirRelativeToWorkspace);
  return computeSourceFingerprint(allFiles);
}

async function writeJson(filePath: string, value: unknown): Promise<{ hash: string; size: number }> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(filePath, content, "utf8");
  return { hash: sha256(content), size: Buffer.byteLength(content, "utf8") };
}

async function writeText(filePath: string, content: string): Promise<{ hash: string; size: number }> {
  await writeFile(filePath, content, "utf8");
  return { hash: sha256(content), size: Buffer.byteLength(content, "utf8") };
}

function buildDeclarationSourceMap(
  workspaceDir: string,
  declarationSources: SourceFile[],
): Map<string, Array<string | undefined>> {
  const sourceMap = new Map<string, Array<string | undefined>>();
  for (const source of declarationSources) {
    const relativePath = source.fileName.replace(/\\/g, "/");
    const absolutePath = path.resolve(workspaceDir, source.fileName).replace(/\\/g, "/");
    const lines = source.content.split(/\r?\n/);
    sourceMap.set(relativePath, lines);
    sourceMap.set(absolutePath, lines);
  }
  return sourceMap;
}

function formatDeclarationDiagnostic(
  diagnostic: CompilationDiagnostic,
  declarationSourceLinesByPath: Map<string, Array<string | undefined>>,
): string {
  const file = diagnostic.file ?? "<unknown>";
  const line = diagnostic.line ?? "?";
  const column = diagnostic.column ?? "?";
  const header = `TS${diagnostic.code} ${file}:${line}:${column} ${diagnostic.message}`;

  if (!diagnostic.file || !diagnostic.line) {
    return header;
  }

  const lines = declarationSourceLinesByPath.get(diagnostic.file);
  const sourceLine = lines?.[diagnostic.line - 1];
  if (sourceLine === undefined) {
    return header;
  }

  return `${header}\n  > ${diagnostic.line} | ${sourceLine}`;
}

function formatDeclarationCompilationError(
  workspaceDir: string,
  declarationSources: SourceFile[],
  diagnostics: CompilationDiagnostic[],
): string {
  const declarationSourceLinesByPath = buildDeclarationSourceMap(workspaceDir, declarationSources);
  return diagnostics
    .map((diagnostic) => formatDeclarationDiagnostic(diagnostic, declarationSourceLinesByPath))
    .join("\n");
}

export async function buildWorkspace(options: BuildWorkspaceOptions): Promise<BuildWorkspaceResult> {
  const workspaceDir = path.resolve(options.workspaceDir);
  const outDir = path.resolve(options.outDir);
  const mode = options.mode ?? "local";
  const credentialEvalTimeoutMs = options.credentialEvalTimeoutMs ?? 10_000;
  const reportProgress = (event: BuildProgressEvent): void => {
    options.onProgress?.(event);
  };

  reportProgress({
    phase: "start",
    message: "Starting workspace build",
    details: { workspaceDir, outDir, mode },
  });

  await mkdir(outDir, { recursive: true });

  const outDirRelativeToWorkspace = normalizePath(path.relative(workspaceDir, outDir));

  const timingsMs: Record<string, number> = {};
  const warnings: string[] = [];
  const startedAt = Date.now();

  reportProgress({
    phase: "readWorkspace",
    message: "Reading workspace files",
  });
  const t1 = Date.now();
  const allFiles = await readWorkspaceSourceEntries(workspaceDir, outDirRelativeToWorkspace);
  timingsMs.readWorkspace = Date.now() - t1;
  reportProgress({
    phase: "readWorkspace",
    details: { durationMs: timingsMs.readWorkspace, fileCount: allFiles.length },
  });

  const declarationSources: SourceFile[] = [];
  const capabilityEntrypoints = new Set<string>();
  const bundleSources: Array<{ path: string; content: string }> = [];
  const passthroughFiles: Array<{ path: string; content: string; binary?: boolean }> = [];

  for (const file of allFiles) {
    if (file.path.startsWith("src/") && file.path.endsWith(".ts")) {
      declarationSources.push({ fileName: file.path, content: file.content });
      const match = file.path.match(CAPABILITY_ENTRYPOINT_RE);
      if (match) {
        assertValidCapabilityNamespace(match[1]!);
        capabilityEntrypoints.add(file.path);
      }
      bundleSources.push({ path: file.path, content: file.content });
      continue;
    }

    if (file.path.startsWith("src/")) {
      passthroughFiles.push({
        path: file.path.replace(/^src\//, ""),
        content: file.content,
        binary: file.binary,
      });
      continue;
    }

    if (
      file.path.startsWith("docs/") ||
      file.path.startsWith("memory/") ||
      file.path.startsWith("skills/") ||
      file.path === "TOKENSPACE.md"
    ) {
      passthroughFiles.push({ path: file.path, content: file.content, binary: file.binary });
    }
  }

  reportProgress({
    phase: "compileDeclarations",
    message: "Compiling declaration files",
    details: { sourceCount: declarationSources.length },
  });
  const t2 = Date.now();
  const declarationResult = compileDeclarations(declarationSources, {
    projectRoot: workspaceDir,
    resolveNodeModules: true,
  });
  timingsMs.compileDeclarations = Date.now() - t2;
  reportProgress({
    phase: "compileDeclarations",
    details: {
      durationMs: timingsMs.compileDeclarations,
      declarationCount: declarationResult.declarations.length,
      diagnosticCount: declarationResult.diagnostics.length,
    },
  });

  if (!declarationResult.success) {
    const errors = formatDeclarationCompilationError(workspaceDir, declarationSources, declarationResult.diagnostics);
    throw new Error(`Declaration compilation failed:\n${errors}`);
  }

  const declarations: Array<{ fileName: string; content: string }> = [];
  for (const decl of declarationResult.declarations) {
    if (!capabilityEntrypoints.has(decl.sourceFileName)) {
      continue;
    }
    const match = decl.declarationFileName.match(CAPABILITY_DECLARATION_RE);
    declarations.push({
      fileName: decl.declarationFileName,
      content: match ? wrapCapabilityDeclarationsInNamespace(match[1]!, decl.content) : decl.content,
    });
  }

  reportProgress({
    phase: "bundle",
    message: "Bundling workspace code",
    details: { sourceCount: bundleSources.length },
  });
  const t3 = Date.now();
  const bundleCode = await bundleWithEsbuild(workspaceDir, bundleSources);
  timingsMs.bundle = Date.now() - t3;
  reportProgress({
    phase: "bundle",
    details: { durationMs: timingsMs.bundle, bundleBytes: Buffer.byteLength(bundleCode, "utf8") },
  });

  const revisionFs: RevisionFilesystemArtifact = {
    declarations,
    files: passthroughFiles,
    // System content is injected by the server when creating a revision.
    system: [],
    builtins: BUILTINS,
  };

  const metadataEntries: Array<{ path: string; content: string }> = [
    ...revisionFs.files.filter((f) => !f.binary).map((f) => ({ path: f.path, content: f.content })),
  ];

  reportProgress({
    phase: "extractPromptMetadata",
    message: "Extracting prompt metadata",
  });
  const promptMetadata = extractPromptMetadata(metadataEntries);
  reportProgress({
    phase: "extractPromptMetadata",
    details: {
      capabilityCount: promptMetadata.capabilities.length,
      skillCount: promptMetadata.skills.length,
    },
  });

  reportProgress({
    phase: "extractCredentials",
    message: "Extracting credential requirements",
  });
  const t4 = Date.now();
  const credentialRequirements = await extractCredentialRequirementsFromWorkspace(workspaceDir, {
    timeoutMs: credentialEvalTimeoutMs,
  });
  timingsMs.extractCredentialRequirements = Date.now() - t4;
  reportProgress({
    phase: "extractCredentials",
    details: {
      durationMs: timingsMs.extractCredentialRequirements,
      credentialCount: credentialRequirements.length,
      credentials: credentialRequirements.map((credential) => credential.id),
    },
  });

  reportProgress({
    phase: "resolveModels",
    message: "Resolving workspace model configuration",
  });
  const models = resolveModels(allFiles);
  reportProgress({
    phase: "resolveModels",
    details: {
      models: models.map((model) => model.modelId),
      defaultModel: models.find((model) => model.isDefault)?.modelId,
    },
  });

  const metadata: MetadataArtifact = {
    capabilities: promptMetadata.capabilities,
    skills: promptMetadata.skills,
    tokenspaceMd: revisionFs.files.find((file) => file.path === "TOKENSPACE.md" && !file.binary)?.content,
    credentialRequirements,
    models,
  };

  const diagnostics: DiagnosticsArtifact = {
    declarationDiagnostics: declarationResult.diagnostics,
    timingsMs: {
      ...timingsMs,
      total: Date.now() - startedAt,
    },
    warnings,
  };

  const deps = getRevisionDepsArtifact(allFiles);

  reportProgress({
    phase: "writeArtifacts",
    message: "Writing build artifacts",
  });
  const revisionFsResult = await writeJson(path.join(outDir, "revision-files.json"), revisionFs);
  const bundleResult = await writeText(path.join(outDir, "bundle.mjs"), bundleCode);
  const metadataResult = await writeJson(path.join(outDir, "metadata.json"), metadata);
  const diagnosticsResult = await writeJson(path.join(outDir, "diagnostics.json"), diagnostics);

  let depsResult: { hash: string; size: number } | undefined;
  if (deps) {
    depsResult = await writeJson(path.join(outDir, "deps.json"), deps);
  }

  const packageJson = await readFile(path.join(PACKAGE_DIR, "package.json"), "utf8");
  const packageJsonParsed = JSON.parse(packageJson) as { version?: string };
  const compilerVersion = packageJsonParsed.version ?? "0.0.0";

  const manifest: BuildManifest = {
    schemaVersion: 1,
    compilerVersion,
    mode,
    workspaceRoot: workspaceDir,
    sourceFingerprint: computeSourceFingerprint(allFiles),
    createdAt: new Date().toISOString(),
    artifacts: {
      revisionFs: { path: "revision-files.json", ...revisionFsResult },
      bundle: { path: "bundle.mjs", ...bundleResult },
      metadata: { path: "metadata.json", ...metadataResult },
      diagnostics: { path: "diagnostics.json", ...diagnosticsResult },
      ...(depsResult ? { deps: { path: "deps.json", ...depsResult } } : {}),
    },
  };

  await writeJson(path.join(outDir, "manifest.json"), manifest);

  reportProgress({
    phase: "writeArtifacts",
    details: {
      revisionFsBytes: revisionFsResult.size,
      bundleBytes: bundleResult.size,
      metadataBytes: metadataResult.size,
      diagnosticsBytes: diagnosticsResult.size,
      depsBytes: depsResult?.size,
    },
  });

  reportProgress({
    phase: "done",
    message: "Workspace build completed",
    details: {
      sourceFingerprint: manifest.sourceFingerprint,
      totalDurationMs: diagnostics.timingsMs.total,
    },
  });

  return {
    manifest,
    revisionFs,
    bundleCode,
    metadata,
    diagnostics,
    deps,
  };
}

function resolveBuildArtifactPath(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`Invalid artifact path: ${relativePath}`);
  }
  const full = path.resolve(root, relativePath);
  const rel = path.relative(root, full);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Artifact path escapes build directory: ${relativePath}`);
  }
  return full;
}

export async function loadBuildArtifacts(buildDir: string): Promise<{
  manifest: BuildManifest;
  revisionFs: string;
  bundle: string;
  metadata: string;
  diagnostics: string;
  deps?: string;
}> {
  const root = path.resolve(buildDir);
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")) as BuildManifest;

  const revisionFs = await readFile(resolveBuildArtifactPath(root, manifest.artifacts.revisionFs.path), "utf8");
  const bundle = await readFile(resolveBuildArtifactPath(root, manifest.artifacts.bundle.path), "utf8");
  const metadata = await readFile(resolveBuildArtifactPath(root, manifest.artifacts.metadata.path), "utf8");
  const diagnostics = await readFile(resolveBuildArtifactPath(root, manifest.artifacts.diagnostics.path), "utf8");
  const deps = manifest.artifacts.deps
    ? await readFile(resolveBuildArtifactPath(root, manifest.artifacts.deps.path), "utf8")
    : undefined;

  return {
    manifest,
    revisionFs,
    bundle,
    metadata,
    diagnostics,
    deps,
  };
}

export async function loadBuiltWorkspace(buildDir: string): Promise<BuildWorkspaceResult> {
  const loaded = await loadBuildArtifacts(buildDir);
  return {
    manifest: loaded.manifest,
    revisionFs: JSON.parse(loaded.revisionFs) as RevisionFilesystemArtifact,
    bundleCode: loaded.bundle,
    metadata: JSON.parse(loaded.metadata) as MetadataArtifact,
    diagnostics: JSON.parse(loaded.diagnostics) as DiagnosticsArtifact,
    deps: loaded.deps ? (JSON.parse(loaded.deps) as RevisionDepsArtifact) : null,
  };
}
