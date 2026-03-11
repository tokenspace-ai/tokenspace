import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import pc from "picocolors";

export const LINK_DIRNAME = ".tokenspace";
export const LINK_FILENAME = "link.json";
export const LINK_VERSION = 1 as const;
export const LINK_GITIGNORE_ENTRY = `${LINK_DIRNAME}/`;
export const DEFAULT_BUILD_DIR = "build/tokenspace";

const BUILT_IN_IGNORED_DIRS = new Set([LINK_DIRNAME, ".git", "node_modules"]);
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".webp",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".rar",
  ".mp3",
  ".mp4",
  ".wav",
  ".avi",
  ".mov",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
]);

export interface LinkedWorkspaceConfig {
  version: typeof LINK_VERSION;
  workspaceSlug: string;
}

export function getLinkFilePath(workspaceDir: string): string {
  return path.join(workspaceDir, LINK_DIRNAME, LINK_FILENAME);
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function readLinkedWorkspaceConfig(workspaceDir: string): Promise<LinkedWorkspaceConfig | null> {
  const linkPath = getLinkFilePath(workspaceDir);
  if (!(await pathExists(linkPath))) {
    return null;
  }

  const raw = await readFile(linkPath, "utf8");
  const parsed = JSON.parse(raw) as Partial<LinkedWorkspaceConfig>;
  if (
    parsed.version !== LINK_VERSION ||
    typeof parsed.workspaceSlug !== "string" ||
    parsed.workspaceSlug.length === 0
  ) {
    throw new Error(`Invalid linked tokenspace metadata in ${linkPath}`);
  }

  return {
    version: LINK_VERSION,
    workspaceSlug: parsed.workspaceSlug,
  };
}

export async function writeLinkedWorkspaceConfig(workspaceDir: string, workspaceSlug: string): Promise<void> {
  const config: LinkedWorkspaceConfig = {
    version: LINK_VERSION,
    workspaceSlug,
  };
  const linkDir = path.join(workspaceDir, LINK_DIRNAME);
  await mkdir(linkDir, { recursive: true });
  await writeFile(getLinkFilePath(workspaceDir), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function ensureGitignoreEntry(workspaceDir: string, entry: string = LINK_GITIGNORE_ENTRY): Promise<void> {
  const gitignorePath = path.join(workspaceDir, ".gitignore");
  const current = (await pathExists(gitignorePath)) ? await readFile(gitignorePath, "utf8") : "";
  const lines = current.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.includes(entry)) {
    return;
  }
  const next = current.endsWith("\n") || current.length === 0 ? `${current}${entry}\n` : `${current}\n${entry}\n`;
  await writeFile(gitignorePath, next, "utf8");
}

export async function findNearestLinkedWorkspaceRoot(startDir: string): Promise<string | null> {
  let current = path.resolve(startDir);
  while (true) {
    if (await pathExists(getLinkFilePath(current))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export async function findNearestTokenspaceWorkspaceRoot(startDir: string): Promise<string | null> {
  const linkedRoot = await findNearestLinkedWorkspaceRoot(startDir);
  if (linkedRoot) {
    return linkedRoot;
  }

  let current = path.resolve(startDir);
  while (true) {
    if (await pathExists(path.join(current, "TOKENSPACE.md"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function shouldIgnoreRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath === ".") {
    return false;
  }
  const normalized = relativePath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.some(
    (part, index) => part.startsWith(".") || BUILT_IN_IGNORED_DIRS.has(part) || (part === "build" && index === 0),
  );
}

export function isBinaryFile(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export async function getLocalFiles(
  dir: string,
  options: { includeBinary?: boolean } = {},
  baseDir: string = dir,
): Promise<string[]> {
  if (!(await pathExists(dir))) {
    return [];
  }
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath);
    if (shouldIgnoreRelativePath(relativePath)) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await getLocalFiles(fullPath, options, baseDir)));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!options.includeBinary && isBinaryFile(relativePath)) {
      continue;
    }
    files.push(relativePath);
  }

  return files.sort();
}

export function formatDisplayPath(fromCwd: string, targetPath: string): string {
  const relative = path.relative(fromCwd, targetPath);
  if (!relative) {
    return ".";
  }
  if (!relative.startsWith(".") && !path.isAbsolute(relative)) {
    return `./${relative}`;
  }
  return relative;
}

export function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value == null) {
    throw new Error(message);
  }
  return value;
}

export function printWorkspaceResolution(label: string, dir: string): void {
  console.log(pc.dim(`  ${label}: ${formatDisplayPath(process.cwd(), dir)}`));
}
