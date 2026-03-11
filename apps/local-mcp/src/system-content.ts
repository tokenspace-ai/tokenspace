import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalSystemContentFile } from "./types";

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === ".DS_Store") continue;
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(absolutePath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(absolutePath);
    }
  }

  return files;
}

export function getDefaultLocalSystemDir(): string {
  return path.resolve(fileURLToPath(new URL("../system", import.meta.url)));
}

export async function loadLocalSystemContent(
  systemDir: string = getDefaultLocalSystemDir(),
): Promise<LocalSystemContentFile[]> {
  const absFiles = await listFilesRecursive(systemDir);
  const files = await Promise.all(
    absFiles.map(async (absolutePath) => ({
      path: toPosixPath(path.relative(systemDir, absolutePath)),
      content: await readFile(absolutePath, "utf8"),
    })),
  );

  return files.sort((a, b) => a.path.localeCompare(b.path));
}
