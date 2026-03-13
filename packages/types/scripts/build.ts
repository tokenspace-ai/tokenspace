/**
 * Build script that reads .d.ts source files and generates
 * a TypeScript module that exports them as strings.
 *
 * This allows the type definitions to be:
 * 1. Easy to read and edit as regular source files
 * 2. Consumed by the compiler package and frontend as string constants
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const DEFS_DIR = join(import.meta.dirname, "../defs");
const SRC_DIR = join(import.meta.dirname, "../src");
const OUTPUT_FILE = join(SRC_DIR, "generated.ts");
const BUILTINS_SOURCE = join(import.meta.dirname, "../../sdk/src/builtin-types.ts");
const SERVER_ONLY_START = "// @tokenspace-builtins-server-only:start";
const SERVER_ONLY_END = "// @tokenspace-builtins-server-only:end";

function makeGlobalDeclarations(content: string): string {
  const globalContent = content
    // Convert "export declare function" to "declare function"
    .replace(/^export\s+declare\s+/gm, "declare ")
    // Convert "export declare class" to "declare class"
    .replace(/^export\s+declare\s+class\s+/gm, "declare class ")
    // Convert "export declare const/let/var" to "declare const/let/var"
    .replace(/^export\s+declare\s+(const|let|var)\s+/gm, "declare $1 ")
    // Convert "export type" to "type" (ambient global)
    .replace(/^export\s+type\s+/gm, "type ")
    // Convert "export interface" to "interface"
    .replace(/^export\s+interface\s+/gm, "interface ")
    // Convert "export enum" to "enum"
    .replace(/^export\s+enum\s+/gm, "enum ")
    // Convert "export const enum" to "const enum"
    .replace(/^export\s+const\s+enum\s+/gm, "const enum ")
    // Convert "export namespace" to "namespace"
    .replace(/^export\s+namespace\s+/gm, "namespace ")
    // Remove any remaining standalone export statements
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, "")
    // Collapse large empty blocks
    .replace(/\n{3,}/g, "\n\n");

  return `${globalContent.trim()}\n`;
}

function escapeForTemplateLiteral(content: string): string {
  return content.replaceAll("// @ts-nocheck", "").replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function splitBuiltins(content: string): { local: string; server: string } {
  const startIndex = content.indexOf(SERVER_ONLY_START);
  const endIndex = content.indexOf(SERVER_ONLY_END);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error("packages/sdk/src/builtin-types.ts is missing valid server-only builtin markers");
  }

  const before = content.slice(0, startIndex);
  const serverOnly = content.slice(startIndex + SERVER_ONLY_START.length, endIndex);
  const after = content.slice(endIndex + SERVER_ONLY_END.length);

  return {
    local: `${before}${after}`,
    server: `${before}${serverOnly}${after}`,
  };
}

async function build() {
  const files = await readdir(DEFS_DIR);
  // builtins are sourced from @tokenspace/sdk (single source of truth)
  const dtsFiles = files.filter((f) => f.endsWith(".d.ts") && f !== "builtins.d.ts");

  const exports: string[] = [
    "/**",
    " * Auto-generated file - DO NOT EDIT",
    " * Run `bun run build` to regenerate",
    " */",
    "",
  ];

  const allTypes: string[] = [];

  // Builtins (from sdk, converted to ambient globals)
  const builtinsRaw = await readFile(BUILTINS_SOURCE, "utf-8");
  const builtins = splitBuiltins(builtinsRaw);
  const builtinsLocal = makeGlobalDeclarations(builtins.local);
  const builtinsServer = makeGlobalDeclarations(builtins.server);
  const escapedBuiltinsLocal = escapeForTemplateLiteral(builtinsLocal);
  const escapedBuiltinsServer = escapeForTemplateLiteral(builtinsServer);
  allTypes.push(escapedBuiltinsServer);
  exports.push("/** Source: packages/sdk/src/builtin-types.ts (processed) */");
  exports.push(`export const BUILTINS_LOCAL = \`${escapedBuiltinsLocal}\`;`);
  exports.push(`export const BUILTINS_SERVER = \`${escapedBuiltinsServer}\`;`);
  exports.push("export const BUILTINS = BUILTINS_SERVER;");
  exports.push("");

  for (const file of dtsFiles.sort()) {
    const filePath = join(DEFS_DIR, file);
    const content = await readFile(filePath, "utf-8");

    // Convert filename to export name: minimal-lib.d.ts -> MINIMAL_LIB
    const exportName = basename(file, ".d.ts").toUpperCase().replace(/-/g, "_");

    const escapedContent = escapeForTemplateLiteral(content);
    allTypes.push(escapedContent);
    exports.push(`/** Source: ${file} */`);
    exports.push(`export const ${exportName} = \`${escapedContent}\`;`);
    exports.push("");
  }

  exports.push(`export const SANDBOX_TYPES = \`${allTypes.join("\n")}\`;`);

  await writeFile(OUTPUT_FILE, `${exports.join("\n")}\n`);

  console.log(
    `Generated ${OUTPUT_FILE} with exports: SANDBOX_TYPES, BUILTINS_LOCAL, BUILTINS_SERVER, BUILTINS, ${dtsFiles.map((f) => basename(f, ".d.ts").toUpperCase().replace(/-/g, "_")).join(", ")}`,
  );
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
