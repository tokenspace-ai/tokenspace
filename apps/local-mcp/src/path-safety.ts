import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export class SandboxPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxPathError";
  }
}

export type ResolvedSandboxPath = {
  relativePath: string;
  absolutePath: string;
};

type ResolveSandboxPathOptions = {
  sandboxRoot: string;
  path: string;
  allowRootAbsolute?: boolean;
};

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function normalizeVirtualPath(inputPath: string, allowRootAbsolute: boolean): string {
  if (inputPath.includes("\0")) {
    throw new SandboxPathError("Sandbox paths cannot contain NUL bytes.");
  }

  const normalizedInput = inputPath.replace(/\\/g, "/").trim();
  if (normalizedInput === "" || normalizedInput === "." || normalizedInput === "/" || normalizedInput === "/sandbox") {
    return "";
  }

  let candidate = normalizedInput;
  if (candidate.startsWith("/sandbox/")) {
    candidate = candidate.slice("/sandbox/".length);
  } else if (allowRootAbsolute && candidate.startsWith("/")) {
    candidate = candidate.slice(1);
  } else if (candidate.startsWith("/")) {
    throw new SandboxPathError(`Sandbox path must be relative or start with /sandbox: ${inputPath}`);
  }

  const parts = candidate.split("/");
  const resolved: string[] = [];

  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part || part === ".") continue;
    if (part === "..") {
      if (resolved.length === 0) {
        throw new SandboxPathError(`Sandbox path escapes the sandbox root: ${inputPath}`);
      }
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }

  return resolved.join("/");
}

async function getCanonicalSandboxRoot(sandboxRoot: string): Promise<string> {
  const resolvedRoot = path.resolve(sandboxRoot);
  try {
    return await realpath(resolvedRoot);
  } catch (error) {
    if (isNotFoundError(error)) return resolvedRoot;
    throw error;
  }
}

async function assertNoSymlinkTraversal(sandboxRoot: string, relativePath: string): Promise<void> {
  let currentPath = sandboxRoot;
  if (!relativePath) return;

  for (const segment of relativePath.split("/")) {
    currentPath = path.join(currentPath, segment);
    try {
      const stats = await lstat(currentPath);
      if (stats.isSymbolicLink()) {
        throw new SandboxPathError(`Sandbox path traverses a symbolic link: ${relativePath}`);
      }
    } catch (error) {
      if (isNotFoundError(error)) {
        return;
      }
      throw error;
    }
  }
}

export async function resolveSandboxPath(options: ResolveSandboxPathOptions): Promise<ResolvedSandboxPath> {
  const sandboxRoot = await getCanonicalSandboxRoot(options.sandboxRoot);
  const relativePath = normalizeVirtualPath(options.path, options.allowRootAbsolute ?? false);
  const absolutePath = relativePath ? path.resolve(sandboxRoot, relativePath) : sandboxRoot;
  const relativeToRoot = path.relative(sandboxRoot, absolutePath);

  if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
    throw new SandboxPathError(`Sandbox path escapes the sandbox root: ${options.path}`);
  }

  await assertNoSymlinkTraversal(sandboxRoot, relativePath);

  return { relativePath, absolutePath };
}
