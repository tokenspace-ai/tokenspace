"use node";
/**
 * High-level filesystem operations
 *
 * Provides overlay-aware file operations that automatically route to
 * the appropriate layer (revision filesystem base or overlay) based on session context.
 */

import { compileAgentCode } from "@tokenspace/compiler";
import { v } from "convex/values";
import { Bash } from "just-bash";
import ts from "typescript";
import { internal } from "../_generated/api";
import { action, internalAction } from "../_generated/server";
import { normalizePath, type OverlayFile, parsePath, type RevisionFile } from "./index";

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

async function fetchContentFromUrl(url: string, binary: boolean): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download file content (${response.status})`);
  }
  if (binary) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    return bytesToBase64(buffer);
  }
  return await response.text();
}

// ============================================================================
// File Operations
// ============================================================================

/**
 * List files in a directory (overlay-aware)
 */
export const listFiles = internalAction({
  args: {
    revisionId: v.id("revisions"),
    path: v.optional(v.string()),
    sessionId: v.optional(v.id("sessions")),
  },
  handler: async (ctx, args): Promise<string> => {
    const normalizedPath = args.path ? normalizePath(args.path) : undefined;
    const prefix = normalizedPath === "" ? "" : normalizedPath ? `${normalizedPath}/` : "";

    // Use overlay-aware listing if sessionId is provided
    const allFiles = args.sessionId
      ? await ctx.runQuery(internal.fs.overlay.list, {
          sessionId: args.sessionId,
          revisionId: args.revisionId,
        })
      : await ctx.runQuery(internal.fs.revision.list, {
          revisionId: args.revisionId,
        });

    const dirs = new Set<string>();
    const files = [];

    for (const file of allFiles) {
      if (!prefix || file.startsWith(prefix)) {
        const relativePath = prefix ? file.slice(prefix.length) : file;
        const parts = relativePath.split("/");
        if (parts.length > 1) dirs.add(parts[0]!);
        if (parts.length === 1 && parts[0]) files.push(file);
      }
    }

    const result = [];
    for (const dir of dirs) {
      result.push(`[dir] ${dir}`);
    }
    for (const file of files) {
      result.push(`[file] ${file}`);
    }
    return result.join("\n");
  },
});

/**
 * Read a file (overlay-aware)
 */
export const readFile = internalAction({
  args: {
    revisionId: v.id("revisions"),
    path: v.string(),
    startLine: v.optional(v.number()),
    lineCount: v.optional(v.number()),
    sessionId: v.optional(v.id("sessions")),
  },
  handler: async (ctx, args): Promise<string> => {
    const parsed = parsePath(normalizePath(args.path));

    // Use overlay-aware reading if sessionId is provided
    let content: string | undefined;
    let downloadUrl: string | undefined;
    let binary = false;

    if (args.sessionId) {
      const overlayFile: OverlayFile | null = await ctx.runQuery(internal.fs.overlay.read, {
        sessionId: args.sessionId,
        revisionId: args.revisionId,
        ...parsed,
      });
      if (!overlayFile) {
        return `Error: File does not exist: ${args.path}`;
      }
      content = overlayFile.content;
      downloadUrl = overlayFile.downloadUrl;
      binary = overlayFile.binary;
    } else {
      const file: RevisionFile | null = await ctx.runQuery(internal.fs.revision.read, {
        revisionId: args.revisionId,
        ...parsed,
      });
      if (!file) {
        return `Error: File does not exist: ${args.path}`;
      }
      content = file.content;
      downloadUrl = file.downloadUrl;
      binary = file.binary;
    }

    if (content === undefined && downloadUrl) {
      content = await fetchContentFromUrl(downloadUrl, binary);
    }

    if (content === undefined) {
      return `Error: File does not exist: ${args.path}`;
    }

    if (args.startLine !== undefined || args.lineCount !== undefined) {
      const lines = content.split("\n");
      const startIdx = (args.startLine ?? 1) - 1;
      const endIdx = args.lineCount !== undefined ? startIdx + args.lineCount : lines.length;

      if (startIdx < 0 || startIdx >= lines.length) {
        return `Error: Start line ${args.startLine} is out of range (file has ${lines.length} lines)`;
      }

      const selectedLines = lines.slice(startIdx, endIdx);
      const lineNumbers = selectedLines.map((line, i) => `${startIdx + i + 1}| ${line}`);
      return lineNumbers.join("\n");
    }
    return content;
  },
});

/**
 * Write a file (overlay-aware)
 */
export const writeFile = internalAction({
  args: {
    revisionId: v.id("revisions"),
    path: v.string(),
    content: v.string(),
    append: v.boolean(),
    sessionId: v.optional(v.id("sessions")),
  },
  handler: async (ctx, args) => {
    const parsed = parsePath(normalizePath(args.path));
    let fullContent = args.content;

    if (args.append) {
      // Read existing content (from overlay or base)
      if (args.sessionId) {
        const overlayFile: OverlayFile | null = await ctx.runQuery(internal.fs.overlay.read, {
          sessionId: args.sessionId,
          revisionId: args.revisionId,
          ...parsed,
        });
        if (overlayFile?.content !== undefined) {
          fullContent = overlayFile.content + args.content;
        } else if (overlayFile?.downloadUrl) {
          const existing = await fetchContentFromUrl(overlayFile.downloadUrl, false);
          fullContent = existing + args.content;
        }
      } else {
        const file: RevisionFile | null = await ctx.runQuery(internal.fs.revision.read, {
          revisionId: args.revisionId,
          ...parsed,
        });
        if (file?.content !== undefined) {
          fullContent = file.content + args.content;
        } else if (file?.downloadUrl) {
          const existing = await fetchContentFromUrl(file.downloadUrl, false);
          fullContent = existing + args.content;
        }
      }
    }

    // Write to overlay if sessionId is provided, otherwise to base
    if (args.sessionId) {
      await ctx.runAction(internal.fs.overlay.write, {
        sessionId: args.sessionId,
        ...parsed,
        content: fullContent,
        binary: false,
      });
    } else {
      await ctx.runAction(internal.fs.revision.write, {
        revisionId: args.revisionId,
        ...parsed,
        content: fullContent,
        binary: false,
      });
    }
  },
});

// ============================================================================
// Search Operations
// ============================================================================

/**
 * Converts a glob pattern to a regex pattern
 */
function globToRegex(pattern: string): RegExp {
  let regexStr = "^";
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i]!;

    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // ** matches anything including /
        if (pattern[i + 2] === "/") {
          regexStr += "(?:.*/)?";
          i += 3;
        } else {
          regexStr += ".*";
          i += 2;
        }
      } else {
        // * matches anything except /
        regexStr += "[^/]*";
        i++;
      }
    } else if (char === "?") {
      regexStr += "[^/]";
      i++;
    } else if (char === "[") {
      // Character class - find closing bracket
      let j = i + 1;
      while (j < pattern.length && pattern[j] !== "]") j++;
      regexStr += pattern.slice(i, j + 1);
      i = j + 1;
    } else if (".+^$}{()|\\".includes(char)) {
      regexStr += `\\${char}`;
      i++;
    } else {
      regexStr += char;
      i++;
    }
  }

  regexStr += "$";
  return new RegExp(regexStr);
}

/**
 * Glob pattern matching (overlay-aware)
 */
export const glob = internalAction({
  args: {
    revisionId: v.id("revisions"),
    pattern: v.string(),
    path: v.optional(v.string()),
    sessionId: v.optional(v.id("sessions")),
  },
  handler: async (ctx, args): Promise<string> => {
    const normalizedPath = args.path ? normalizePath(args.path) : undefined;
    const prefix = normalizedPath ? `${normalizedPath}/` : "";

    // Use overlay-aware listing if sessionId is provided
    const allFiles = args.sessionId
      ? await ctx.runQuery(internal.fs.overlay.list, {
          sessionId: args.sessionId,
          revisionId: args.revisionId,
        })
      : await ctx.runQuery(internal.fs.revision.list, {
          revisionId: args.revisionId,
        });

    // Prepend ** if pattern doesn't start with it for recursive matching
    let pattern = args.pattern;
    if (!pattern.startsWith("**/") && !pattern.startsWith("/")) {
      pattern = `**/${pattern}`;
    }

    const regex = globToRegex(pattern);
    const matches: string[] = [];

    for (const file of allFiles) {
      // If path is provided, only search within that directory
      if (prefix && !file.startsWith(prefix)) continue;

      const searchPath = prefix ? file.slice(prefix.length) : file;
      if (regex.test(searchPath) || regex.test(file)) {
        matches.push(file);
      }
    }

    if (matches.length === 0) {
      return `No files matching pattern: ${args.pattern}`;
    }

    return matches.sort().join("\n");
  },
});

/**
 * Regex search across files (overlay-aware)
 */
export const grep = internalAction({
  args: {
    revisionId: v.id("revisions"),
    pattern: v.string(),
    path: v.optional(v.string()),
    ignoreCase: v.optional(v.boolean()),
    contextLines: v.optional(v.number()),
    filesOnly: v.optional(v.boolean()),
    sessionId: v.optional(v.id("sessions")),
  },
  handler: async (ctx, args): Promise<string> => {
    const normalizedPath = args.path ? normalizePath(args.path) : undefined;
    const pathPrefix = normalizedPath ? `${normalizedPath}/` : "";

    // Use overlay-aware listing if sessionId is provided
    const allFiles = args.sessionId
      ? await ctx.runQuery(internal.fs.overlay.list, {
          sessionId: args.sessionId,
          revisionId: args.revisionId,
        })
      : await ctx.runQuery(internal.fs.revision.list, {
          revisionId: args.revisionId,
        });

    const flags = args.ignoreCase ? "gi" : "g";
    let regex: RegExp;
    try {
      regex = new RegExp(args.pattern, flags);
    } catch {
      return `Error: Invalid regex pattern: ${args.pattern}`;
    }

    const contextLines = args.contextLines ?? 0;
    const results: string[] = [];
    const matchingFiles: string[] = [];

    for (const filePath of allFiles) {
      // If path is provided, only search within that directory
      if (pathPrefix && !filePath.startsWith(pathPrefix)) continue;

      // Skip binary-looking files
      if (/\.(png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|pdf|zip|tar|gz)$/i.test(filePath)) {
        continue;
      }

      const parsed = parsePath(filePath);

      // Use overlay-aware reading if sessionId is provided
      let fileContent: string | undefined;
      let downloadUrl: string | undefined;
      let binary = false;

      if (args.sessionId) {
        const overlayFile: OverlayFile | null = await ctx.runQuery(internal.fs.overlay.read, {
          sessionId: args.sessionId,
          revisionId: args.revisionId,
          ...parsed,
        });
        if (overlayFile) {
          fileContent = overlayFile.content;
          downloadUrl = overlayFile.downloadUrl;
          binary = overlayFile.binary;
        }
      } else {
        const file = await ctx.runQuery(internal.fs.revision.read, {
          revisionId: args.revisionId,
          ...parsed,
        });
        if (file) {
          fileContent = file.content;
          downloadUrl = file.downloadUrl;
          binary = file.binary;
        }
      }

      if (binary) continue;

      if (fileContent === undefined && downloadUrl) {
        fileContent = await fetchContentFromUrl(downloadUrl, false);
      }

      if (fileContent === undefined) continue;

      const lines = fileContent.split("\n");
      const fileMatches: { lineNum: number; line: string }[] = [];

      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        const line = lines[i]!;
        if (regex.test(line)) {
          fileMatches.push({ lineNum: i + 1, line });
        }
      }

      if (fileMatches.length > 0) {
        matchingFiles.push(filePath);

        if (!args.filesOnly) {
          results.push(`\n${filePath}:`);

          if (contextLines > 0) {
            // With context, show ranges
            const shownLines = new Set<number>();
            for (const match of fileMatches) {
              const start = Math.max(0, match.lineNum - 1 - contextLines);
              const end = Math.min(lines.length, match.lineNum + contextLines);
              for (let i = start; i < end; i++) {
                shownLines.add(i);
              }
            }

            const sortedLines = Array.from(shownLines).sort((a, b) => a - b);
            let lastLine = -2;
            for (const lineIdx of sortedLines) {
              if (lineIdx > lastLine + 1) {
                results.push("--");
              }
              const lineNum = lineIdx + 1;
              const isMatch = fileMatches.some((m) => m.lineNum === lineNum);
              const linePrefix = isMatch ? ">" : " ";
              results.push(`${linePrefix} ${lineNum}: ${lines[lineIdx]}`);
              lastLine = lineIdx;
            }
          } else {
            // Without context, just show matching lines
            for (const match of fileMatches) {
              results.push(`  ${match.lineNum}: ${match.line}`);
            }
          }
        }
      }
    }

    if (matchingFiles.length === 0) {
      return `No matches found for pattern: ${args.pattern}`;
    }

    if (args.filesOnly) {
      return matchingFiles.sort().join("\n");
    }

    return `Found ${matchingFiles.length} file(s) with matches:${results.join("\n")}`;
  },
});

// ============================================================================
// Code Operations
// ============================================================================

/**
 * Compile TypeScript code with revision filesystem type definitions
 */
export const compileCode = internalAction({
  args: {
    revisionId: v.id("revisions"),
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const sandboxApis: { fileName: string; content: string }[] = [];

    // Load all revision filesystem files and filter for .d.ts files in capabilities/
    const allFiles = await ctx.runQuery(internal.fs.revision.list, {
      revisionId: args.revisionId,
    });

    // Load all .d.ts files from capabilities/ directory
    for (const filePath of allFiles) {
      if (filePath.startsWith("capabilities/") && filePath.endsWith(".d.ts")) {
        const parsed = parsePath(filePath);
        const fsFile: RevisionFile | null = await ctx.runQuery(internal.fs.revision.read, {
          revisionId: args.revisionId,
          parent: parsed.parent,
          name: parsed.name,
        });
        if (fsFile) {
          let content = fsFile.content;
          if (content === undefined && fsFile.downloadUrl) {
            content = await fetchContentFromUrl(fsFile.downloadUrl, false);
          }
          if (content !== undefined) {
            sandboxApis.push({ fileName: filePath, content });
          }
        }
      }
    }

    // Also load builtins.d.ts from root
    const builtinsFile = await ctx.runQuery(internal.fs.revision.read, {
      revisionId: args.revisionId,
      parent: undefined,
      name: "builtins.d.ts",
    });
    if (builtinsFile) {
      let content = builtinsFile.content;
      if (content === undefined && builtinsFile.downloadUrl) {
        content = await fetchContentFromUrl(builtinsFile.downloadUrl, false);
      }
      if (content !== undefined) {
        sandboxApis.push({ fileName: "builtins.d.ts", content });
      }
    }

    // Step 1: Compile (typecheck) the code
    const compilationResult = compileAgentCode(args.code, {
      sandboxApis,
    });

    if (!compilationResult.success) {
      const errors = compilationResult.diagnostics
        .map((d) => {
          const location = d.line && d.column ? `Line ${d.line}:${d.column}: ` : "";
          return `${location}${d.message} (TS${d.code})`;
        })
        .join("\n");
      return { success: false, error: `TypeScript compilation failed:\n${errors}` };
    }

    // Step 2: Transpile TypeScript to JavaScript
    const transpiled = ts.transpileModule(args.code, {
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.CommonJS,
      },
    });

    return { success: true, code: transpiled.outputText };
  },
});

// ============================================================================
// Bash Execution
// ============================================================================

/**
 * Simple hash function for content comparison
 */
function hashContent(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(16);
}

/**
 * Execute bash commands in a virtual bash environment with access to the overlayed revision filesystem.
 * Uses just-bash library for a secure, sandboxed bash environment.
 */
export const executeBash = internalAction({
  args: {
    revisionId: v.id("revisions"),
    sessionId: v.id("sessions"),
    command: v.string(),
    cwd: v.optional(v.string()),
    timeoutMs: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    filesChanged: string[];
  }> => {
    // Build the overlay snapshot - merges base revision filesystem files with session overlay
    const snapshot: Record<string, string> = await ctx.runAction(internal.fs.overlay.buildSnapshot, {
      sessionId: args.sessionId,
      revisionId: args.revisionId,
    });

    // Convert snapshot paths to be under /sandbox root
    const files: Record<string, string> = {};
    for (const [path, content] of Object.entries(snapshot)) {
      // Paths in snapshot are like "/capabilities/github/capability.d.ts", mount them at /sandbox
      files[`/sandbox${path}`] = content;
    }

    // Track original file checksums for change detection
    const originalChecksums = new Map<string, string>();
    for (const [path, content] of Object.entries(files)) {
      originalChecksums.set(path, hashContent(content));
    }

    const timeoutMs =
      typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
        ? Math.max(1, Math.floor(args.timeoutMs))
        : null;
    const deadlineMs = timeoutMs != null ? Date.now() + timeoutMs : null;

    // Create the bash environment with the files
    const bash = new Bash({
      files,
      cwd: args.cwd ? `/sandbox/${args.cwd}` : "/sandbox",
      env: {
        HOME: "/sandbox",
        USER: "agent",
        PATH: "/usr/bin:/bin",
        SANDBOX_ROOT: "/sandbox",
      },
      executionLimits:
        timeoutMs != null
          ? {
              // Align command-level limits (python/sqlite) to the overall requested timeout.
              maxPythonTimeoutMs: timeoutMs,
              maxSqliteTimeoutMs: timeoutMs,
            }
          : undefined,
      sleep:
        deadlineMs != null
          ? async (ms: number) => {
              const now = Date.now();
              const remaining = deadlineMs - now;
              if (remaining <= 0) {
                throw new Error(`Bash execution timed out after ${timeoutMs}ms`);
              }
              const step = Math.min(ms, remaining);
              await new Promise<void>((resolve) => setTimeout(resolve, step));
              if (ms > step) {
                throw new Error(`Bash execution timed out after ${timeoutMs}ms`);
              }
            }
          : undefined,
    });

    // Execute the command
    const result = await bash.exec(args.command);

    // Track files that were changed/created
    const filesChanged: string[] = [];

    // The bash instance maintains state between execs, so we can list files
    // by running a find command to discover what files exist now
    const findResult = await bash.exec("find /sandbox -type f 2>/dev/null || true");
    const currentFiles = findResult.stdout
      .split("\n")
      .map((p: string) => p.trim())
      .filter((p: string) => p.startsWith("/sandbox/"));

    // Check each current file for changes
    for (const filePath of currentFiles) {
      const catResult = await bash.exec(`cat "${filePath}" 2>/dev/null || echo "__FILE_READ_ERROR__"`);
      const content = catResult.stdout;

      if (content === "__FILE_READ_ERROR__\n" || content === "__FILE_READ_ERROR__") {
        continue;
      }

      const currentChecksum = hashContent(content);
      const originalChecksum = originalChecksums.get(filePath);

      // Remove trailing newline that cat adds
      const normalizedContent = content.endsWith("\n") ? content.slice(0, -1) : content;
      const sandboxPath = filePath.slice("/sandbox".length); // Remove /sandbox prefix

      if (originalChecksum === undefined || originalChecksum !== currentChecksum) {
        // File was created or modified
        filesChanged.push(sandboxPath);

        // Write the change to the overlay
        const parsed = parsePath(sandboxPath.startsWith("/") ? sandboxPath.slice(1) : sandboxPath);
        await ctx.runAction(internal.fs.overlay.write, {
          sessionId: args.sessionId,
          ...parsed,
          content: normalizedContent,
          binary: false,
        });
      }
    }

    // Check for deleted files
    for (const originalPath of originalChecksums.keys()) {
      if (!currentFiles.includes(originalPath)) {
        const sandboxPath = originalPath.slice("/sandbox".length);
        filesChanged.push(`${sandboxPath} (deleted)`);

        // Mark as deleted in overlay
        const parsed = parsePath(sandboxPath.startsWith("/") ? sandboxPath.slice(1) : sandboxPath);
        await ctx.runMutation(internal.fs.overlay.remove, {
          sessionId: args.sessionId,
          ...parsed,
        });
      }
    }

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      filesChanged,
    };
  },
});

// ============================================================================
// Public Actions
// ============================================================================

/**
 * Ensure revision filesystem files are materialized for a revision
 */
export const ensureMaterialized = action({
  args: {
    revisionId: v.id("revisions"),
  },
  handler: async (ctx, args) => {
    await ctx.runAction(internal.compile.materializeRevisionFiles, {
      revisionId: args.revisionId,
    });
  },
});
