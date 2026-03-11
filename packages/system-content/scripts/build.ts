/**
 * Generates src/generated.ts from files in system/**.
 *
 * We embed the content as strings so backend code (Convex/actions) can import
 * system content without relying on runtime filesystem access.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const SYSTEM_DIR = join(import.meta.dirname, "../system");
const OUTPUT_FILE = join(import.meta.dirname, "../src/generated.ts");

function escapeForTemplateLiteral(content: string): string {
  return content.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const paths: string[] = [];

  for (const entry of entries) {
    if (entry.name === ".DS_Store") continue;

    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await listFilesRecursive(abs)));
      continue;
    }
    if (entry.isFile()) {
      paths.push(abs);
    }
  }

  return paths;
}

function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

async function build() {
  const absFiles = await listFilesRecursive(SYSTEM_DIR);
  const relFiles = absFiles
    .map((abs) => toPosixPath(relative(SYSTEM_DIR, abs)))
    .filter((p) => p.length > 0)
    .sort((a, b) => a.localeCompare(b));

  const exports: string[] = [
    "/**",
    " * Auto-generated file - DO NOT EDIT",
    " * Run `bun run codegen` in packages/system-content to regenerate",
    " */",
    "",
    "export type SystemContentFile = { path: string; content: string };",
    "",
    "export const SYSTEM_CONTENT_FILES = [",
  ];

  for (const relPath of relFiles) {
    const absPath = join(SYSTEM_DIR, relPath);
    const content = await readFile(absPath, "utf-8");
    const escaped = escapeForTemplateLiteral(content);
    exports.push(`  { path: ${JSON.stringify(relPath)}, content: \`${escaped}\` },`);
  }

  exports.push("] as const satisfies ReadonlyArray<SystemContentFile>;");
  exports.push("");

  await writeFile(OUTPUT_FILE, `${exports.join("\n")}\n`);
  // eslint-disable-next-line no-console
  console.log(`Generated ${OUTPUT_FILE} (${relFiles.length} files)`);
}

build().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("System content build failed:", error);
  process.exit(1);
});
