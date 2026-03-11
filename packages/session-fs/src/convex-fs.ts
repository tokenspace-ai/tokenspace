/**
 * ConvexFs - Convex-backed overlay filesystem implementing IFileSystem
 *
 * Provides lazy-loading filesystem access backed by Convex session overlay.
 * Files are loaded on-demand and cached locally. Writes go to the overlay.
 */

import { api } from "@tokenspace/backend/convex/_generated/api";
import {
  type BufferEncoding,
  type CpOptions,
  type FileContent,
  type FsStat,
  type IFileSystem,
  InMemoryFs,
  type MkdirOptions,
  type RmOptions,
} from "just-bash";
import type { ConvexClient, ConvexFsOptions, Id } from "./types";

// DirentEntry type from just-bash
interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

// ReadFileOptions type
interface ReadFileOptions {
  encoding?: BufferEncoding | null;
}

// WriteFileOptions type
interface WriteFileOptions {
  encoding?: BufferEncoding;
}

// Helper to get encoding from options
function getEncoding(options?: ReadFileOptions | WriteFileOptions | BufferEncoding | null): BufferEncoding {
  if (!options) return "utf8";
  if (typeof options === "string") return options;
  return options.encoding ?? "utf8";
}

// Helper to convert string/Uint8Array to buffer
function toBuffer(content: FileContent): Uint8Array {
  if (content instanceof Uint8Array) return content;
  return new TextEncoder().encode(content);
}

// Helper to convert buffer to string
function fromBuffer(buffer: Uint8Array, encoding: BufferEncoding): string {
  if (encoding === "base64") {
    // Convert Uint8Array to base64
    let binary = "";
    for (let i = 0; i < buffer.length; i++) {
      binary += String.fromCharCode(buffer[i]!);
    }
    return btoa(binary);
  }
  if (encoding === "hex") {
    return Array.from(buffer)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  if (encoding === "binary" || encoding === "latin1" || encoding === "ascii") {
    let result = "";
    for (let i = 0; i < buffer.length; i++) {
      result += String.fromCharCode(buffer[i]!);
    }
    return result;
  }
  // utf8 and utf-8
  return new TextDecoder("utf-8").decode(buffer);
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const data = new Uint8Array(bytes);
    const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", data.buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
}

async function uploadToStorage(uploadUrl: string, data: Uint8Array, binary: boolean): Promise<Id<"_storage">> {
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Type": binary ? "application/octet-stream" : "text/plain; charset=utf-8",
    },
    body: data,
  });
  if (!response.ok) {
    throw new Error(`Failed to upload file content (${response.status})`);
  }
  const payload = (await response.json()) as { storageId?: string };
  if (!payload.storageId) {
    throw new Error("Upload response missing storageId");
  }
  return payload.storageId as Id<"_storage">;
}

async function fetchFromUrl(url: string, binary: boolean): Promise<string | Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download file content (${response.status})`);
  }
  if (binary) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    return buffer;
  }
  return await response.text();
}

/**
 * Convex-backed overlay filesystem
 */
export class ConvexSessionFs implements IFileSystem {
  private readonly client: ConvexClient;
  private readonly sessionId: Id<"sessions">;
  private readonly allowWrites: boolean;
  private readonly cache: InMemoryFs;

  // Tracking state
  private readonly loadedFiles: Set<string> = new Set();
  private readonly loadedDirs: Set<string> = new Set();
  private readonly notExistsAsFile: Set<string> = new Set();
  private readonly notExistsAsDir: Set<string> = new Set();
  private readonly modified: Set<string> = new Set();
  private readonly deleted: Set<string> = new Set();

  constructor(options: ConvexFsOptions) {
    this.client = options.client;
    this.sessionId = options.sessionId as Id<"sessions">;
    this.allowWrites = options.allowWrites ?? true;
    this.cache = new InMemoryFs();
  }

  private normalizePath(path: string): string {
    if (!path || path === "/") return "/";

    let normalized = path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;

    if (!normalized.startsWith("/")) {
      normalized = `/${normalized}`;
    }

    const parts = normalized.split("/").filter((p) => p && p !== ".");
    const resolved: string[] = [];

    for (const part of parts) {
      if (part === "..") {
        resolved.pop();
      } else {
        resolved.push(part);
      }
    }

    return `/${resolved.join("/")}` || "/";
  }

  private dirname(path: string): string {
    const normalized = this.normalizePath(path);
    if (normalized === "/") return "/";
    const lastSlash = normalized.lastIndexOf("/");
    return lastSlash === 0 ? "/" : normalized.slice(0, lastSlash);
  }

  /**
   * Convert normalized path to Convex path format (no leading slash)
   */
  private toConvexPath(path: string): string {
    const normalized = this.normalizePath(path);
    return normalized === "/" ? "" : normalized.slice(1);
  }

  private assertWritable(operation: string): void {
    if (!this.allowWrites) {
      throw new Error(`EROFS: read-only file system, ${operation}`);
    }
  }

  private markParentsModified(path: string): void {
    let parent = this.dirname(path);
    while (parent !== "/" && !this.modified.has(parent)) {
      this.modified.add(parent);
      this.loadedDirs.add(parent);
      this.deleted.delete(parent);
      this.notExistsAsDir.delete(parent);
      parent = this.dirname(parent);
    }
  }

  private async persistToOverlay(
    convexPath: string,
    buffer: Uint8Array,
    contentStr: string | undefined,
    binary: boolean,
  ): Promise<void> {
    const hash = await hashBytes(buffer);
    const size = buffer.length;

    const metadata = await this.client.action(api.fs.overlay.getUploadMetadata, {
      sessionId: this.sessionId,
      hash,
      size,
      binary,
    });

    if (metadata.kind === "existing") {
      await this.client.action(api.fs.overlay.writeFile, {
        sessionId: this.sessionId,
        path: convexPath,
        blobId: metadata.blobId,
        binary,
      });
      return;
    }

    if (metadata.kind === "inline") {
      if (binary) {
        throw new Error("Inline upload not supported for binary content");
      }
      await this.client.action(api.fs.overlay.writeFile, {
        sessionId: this.sessionId,
        path: convexPath,
        content: contentStr ?? "",
        binary: false,
      });
      return;
    }

    const storageId = await uploadToStorage(metadata.uploadUrl, buffer, binary);
    await this.client.action(api.fs.overlay.writeFile, {
      sessionId: this.sessionId,
      path: convexPath,
      storageId,
      hash,
      size,
      binary,
    });
  }

  /**
   * Load a file from Convex and cache it
   */
  private async ensureFileLoaded(path: string): Promise<boolean> {
    const normalized = this.normalizePath(path);

    if (this.deleted.has(normalized)) {
      return false;
    }

    if (this.modified.has(normalized)) {
      return true;
    }

    if (this.loadedFiles.has(normalized)) {
      return true;
    }

    if (this.notExistsAsFile.has(normalized)) {
      return false;
    }

    // Query Convex for the file
    const convexPath = this.toConvexPath(normalized);
    const result = await this.client.query(api.fs.overlay.readFile, {
      sessionId: this.sessionId,
      path: convexPath,
    });

    if (result === null) {
      this.notExistsAsFile.add(normalized);
      return false;
    }

    // Store in cache
    this.loadedFiles.add(normalized);

    // Ensure parent directories exist in cache
    const parent = this.dirname(normalized);
    if (parent !== "/") {
      try {
        const parentExists = await this.cache.exists(parent);
        if (!parentExists) {
          await this.cache.mkdir(parent, { recursive: true });
        }
      } catch {
        // Parent might already exist
      }
    }

    // Write file to cache
    if (result.binary) {
      if (result.content !== undefined) {
        // Decode base64 content
        const binary = atob(result.content);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        await this.cache.writeFile(normalized, bytes);
      } else if (result.downloadUrl) {
        const bytes = await fetchFromUrl(result.downloadUrl, true);
        await this.cache.writeFile(normalized, bytes as Uint8Array);
      } else {
        this.notExistsAsFile.add(normalized);
        return false;
      }
    } else {
      if (result.content !== undefined) {
        await this.cache.writeFile(normalized, result.content);
      } else if (result.downloadUrl) {
        const text = await fetchFromUrl(result.downloadUrl, false);
        await this.cache.writeFile(normalized, text as string);
      } else {
        this.notExistsAsFile.add(normalized);
        return false;
      }
    }

    return true;
  }

  /**
   * Load directory listing from Convex
   */
  private async ensureDirLoaded(path: string): Promise<boolean> {
    const normalized = this.normalizePath(path);

    if (this.deleted.has(normalized)) {
      return false;
    }

    if (this.modified.has(normalized)) {
      return true;
    }

    if (this.loadedDirs.has(normalized)) {
      return true;
    }

    if (this.notExistsAsDir.has(normalized)) {
      return false;
    }

    // Query Convex for directory listing
    const convexPath = this.toConvexPath(normalized);
    const entries = await this.client.query(api.fs.overlay.listDirectory, {
      sessionId: this.sessionId,
      parent: convexPath || undefined,
    });

    if (entries.length === 0) {
      // Check if directory exists by checking if path is a valid parent
      const stat = await this.client.query(api.fs.overlay.fileStat, {
        sessionId: this.sessionId,
        path: convexPath,
      });

      if (!stat || !stat.isDirectory) {
        // Root directory always exists
        if (normalized !== "/") {
          this.notExistsAsDir.add(normalized);
          return false;
        }
      }
    }

    // Create directory in cache if needed
    try {
      const exists = await this.cache.exists(normalized);
      if (!exists) {
        await this.cache.mkdir(normalized, { recursive: true });
      }
    } catch {
      // Directory might already exist
    }

    // Store entries as placeholders
    for (const entry of entries) {
      const childPath = normalized === "/" ? `/${entry.name}` : `${normalized}/${entry.name}`;

      if (this.modified.has(childPath) || this.loadedFiles.has(childPath) || this.loadedDirs.has(childPath)) {
        continue;
      }

      if (entry.type === "directory") {
        try {
          const exists = await this.cache.exists(childPath);
          if (!exists) {
            await this.cache.mkdir(childPath, { recursive: true });
          }
        } catch {
          // Directory might already exist
        }
      }
    }

    this.loadedDirs.add(normalized);
    return true;
  }

  async readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    const buffer = await this.readFileBuffer(path);
    const encoding = getEncoding(options);
    return fromBuffer(buffer, encoding);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const normalized = this.normalizePath(path);

    if (this.deleted.has(normalized)) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }

    if (this.modified.has(normalized)) {
      return this.cache.readFileBuffer(normalized);
    }

    const loaded = await this.ensureFileLoaded(normalized);
    if (!loaded) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }

    return this.cache.readFileBuffer(normalized);
  }

  async writeFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    this.assertWritable(`write '${path}'`);
    const normalized = this.normalizePath(path);

    // Ensure parent directory exists
    const parent = this.dirname(normalized);
    if (parent !== "/") {
      await this.ensureDirLoaded(parent);
      try {
        const parentExists = await this.cache.exists(parent);
        if (!parentExists) {
          await this.cache.mkdir(parent, { recursive: true });
        }
      } catch {
        // Parent might already exist
      }
    }

    // Write to cache
    await this.cache.writeFile(normalized, content, options);

    // Write to Convex
    const convexPath = this.toConvexPath(normalized);
    const buffer = toBuffer(content);
    const isBinary =
      content instanceof Uint8Array || (typeof content === "string" && getEncoding(options) === "binary");

    const contentStr = isBinary ? undefined : typeof content === "string" ? content : fromBuffer(buffer, "utf8");
    await this.persistToOverlay(convexPath, buffer, contentStr, isBinary);

    // Mark as modified
    this.modified.add(normalized);
    this.markParentsModified(normalized);
    this.deleted.delete(normalized);
    this.notExistsAsFile.delete(normalized);
    this.notExistsAsDir.delete(normalized);
  }

  async appendFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    this.assertWritable(`append '${path}'`);
    const normalized = this.normalizePath(path);

    // Try to load existing content first
    if (!this.modified.has(normalized)) {
      await this.ensureFileLoaded(normalized);
    }

    // Check if file exists
    const exists = await this.cache.exists(normalized);
    if (exists) {
      // Append to existing
      await this.cache.appendFile(normalized, content, options);
      const newContent = await this.cache.readFile(normalized);

      // Write full content to Convex
      const convexPath = this.toConvexPath(normalized);
      const buffer = new TextEncoder().encode(newContent);
      await this.persistToOverlay(convexPath, buffer, newContent, false);
    } else {
      // Create new file
      await this.writeFile(normalized, content, options);
    }

    this.modified.add(normalized);
    this.deleted.delete(normalized);
  }

  async exists(path: string): Promise<boolean> {
    const normalized = this.normalizePath(path);

    if (this.deleted.has(normalized)) {
      return false;
    }

    if (this.modified.has(normalized)) {
      return this.cache.exists(normalized);
    }

    if (this.loadedFiles.has(normalized) || this.loadedDirs.has(normalized)) {
      return this.cache.exists(normalized);
    }

    if (this.notExistsAsFile.has(normalized) && this.notExistsAsDir.has(normalized)) {
      return false;
    }

    // Try loading as file first
    const fileLoaded = await this.ensureFileLoaded(normalized);
    if (fileLoaded) {
      return true;
    }

    // Try loading as directory
    const dirLoaded = await this.ensureDirLoaded(normalized);
    return dirLoaded;
  }

  async stat(path: string): Promise<FsStat> {
    const normalized = this.normalizePath(path);

    if (this.deleted.has(normalized)) {
      throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    }

    if (this.modified.has(normalized) || this.loadedFiles.has(normalized) || this.loadedDirs.has(normalized)) {
      return this.cache.stat(normalized);
    }

    // Try to load file first
    const fileLoaded = await this.ensureFileLoaded(normalized);
    if (fileLoaded) {
      return this.cache.stat(normalized);
    }

    // Try to load as directory
    const dirLoaded = await this.ensureDirLoaded(normalized);
    if (dirLoaded) {
      return this.cache.stat(normalized);
    }

    throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
  }

  async lstat(path: string): Promise<FsStat> {
    const normalized = this.normalizePath(path);

    if (this.deleted.has(normalized)) {
      throw new Error(`ENOENT: no such file or directory, lstat '${path}'`);
    }

    if (this.modified.has(normalized) || this.loadedFiles.has(normalized) || this.loadedDirs.has(normalized)) {
      return this.cache.lstat(normalized);
    }

    const fileLoaded = await this.ensureFileLoaded(normalized);
    if (fileLoaded) {
      return this.cache.lstat(normalized);
    }

    const dirLoaded = await this.ensureDirLoaded(normalized);
    if (dirLoaded) {
      return this.cache.lstat(normalized);
    }

    throw new Error(`ENOENT: no such file or directory, lstat '${path}'`);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    this.assertWritable(`mkdir '${path}'`);
    const normalized = this.normalizePath(path);

    const exists = await this.exists(normalized);
    if (exists) {
      if (!options?.recursive) {
        throw new Error(`EEXIST: directory already exists, mkdir '${path}'`);
      }
      return;
    }

    const parent = this.dirname(normalized);
    if (parent !== "/") {
      if (options?.recursive) {
        await this.mkdir(parent, { recursive: true });
      } else {
        const parentExists = await this.exists(parent);
        if (!parentExists) {
          throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
        }
      }
    }

    await this.cache.mkdir(normalized);

    this.modified.add(normalized);
    this.loadedDirs.add(normalized);
    this.deleted.delete(normalized);
    this.notExistsAsFile.delete(normalized);
    this.notExistsAsDir.delete(normalized);
  }

  async readdir(path: string): Promise<string[]> {
    const entries = await this.readdirWithFileTypes(path);
    return entries.map((e) => e.name);
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const normalized = this.normalizePath(path);

    if (this.deleted.has(normalized)) {
      throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    }

    // Ensure directory is loaded
    const loaded = await this.ensureDirLoaded(normalized);
    if (!loaded && normalized !== "/") {
      throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    }

    // Get entries from Convex
    const convexPath = this.toConvexPath(normalized);
    const convexEntries = await this.client.query(api.fs.overlay.listDirectory, {
      sessionId: this.sessionId,
      parent: convexPath || undefined,
    });

    const entriesMap = new Map<string, DirentEntry>();

    // Add Convex entries
    for (const entry of convexEntries) {
      const childPath = normalized === "/" ? `/${entry.name}` : `${normalized}/${entry.name}`;

      if (this.deleted.has(childPath)) {
        continue;
      }

      entriesMap.set(entry.name, {
        name: entry.name,
        isFile: entry.type === "file",
        isDirectory: entry.type === "directory",
        isSymbolicLink: false,
      });
    }

    // Add locally modified entries
    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    for (const modPath of Array.from(this.modified)) {
      if (modPath.startsWith(prefix)) {
        const rest = modPath.slice(prefix.length);
        const name = rest.split("/")[0];
        if (name && !rest.includes("/", 1) && !entriesMap.has(name)) {
          try {
            const stat = await this.cache.lstat(modPath);
            entriesMap.set(name, {
              name,
              isFile: stat.isFile,
              isDirectory: stat.isDirectory,
              isSymbolicLink: stat.isSymbolicLink,
            });
          } catch {
            // Entry doesn't exist in cache
          }
        }
      }
    }

    return Array.from(entriesMap.values()).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    this.assertWritable(`rm '${path}'`);
    const normalized = this.normalizePath(path);

    const exists = await this.exists(normalized);
    if (!exists) {
      if (options?.force) return;
      throw new Error(`ENOENT: no such file or directory, rm '${path}'`);
    }

    const stat = await this.stat(normalized);
    if (stat.isDirectory) {
      const children = await this.readdir(normalized);
      if (children.length > 0) {
        if (!options?.recursive) {
          throw new Error(`ENOTEMPTY: directory not empty, rm '${path}'`);
        }
        for (const child of children) {
          const childPath = normalized === "/" ? `/${child}` : `${normalized}/${child}`;
          await this.rm(childPath, options);
        }
      }
    }

    // Delete from Convex
    const convexPath = this.toConvexPath(normalized);
    await this.client.mutation(api.fs.overlay.deleteFile, {
      sessionId: this.sessionId,
      path: convexPath,
    });

    // Mark as deleted
    this.deleted.add(normalized);
    this.modified.delete(normalized);
    this.loadedFiles.delete(normalized);
    this.loadedDirs.delete(normalized);

    // Remove from cache
    try {
      await this.cache.rm(normalized, { force: true });
    } catch {
      // Ignore errors
    }
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    this.assertWritable(`cp '${dest}'`);
    const srcNorm = this.normalizePath(src);
    const destNorm = this.normalizePath(dest);

    const srcExists = await this.exists(srcNorm);
    if (!srcExists) {
      throw new Error(`ENOENT: no such file or directory, cp '${src}'`);
    }

    const srcStat = await this.stat(srcNorm);

    if (srcStat.isFile) {
      const content = await this.readFileBuffer(srcNorm);
      await this.writeFile(destNorm, content);
    } else if (srcStat.isDirectory) {
      if (!options?.recursive) {
        throw new Error(`EISDIR: is a directory, cp '${src}'`);
      }
      await this.mkdir(destNorm, { recursive: true });
      const children = await this.readdir(srcNorm);
      for (const child of children) {
        const srcChild = srcNorm === "/" ? `/${child}` : `${srcNorm}/${child}`;
        const destChild = destNorm === "/" ? `/${child}` : `${destNorm}/${child}`;
        await this.cp(srcChild, destChild, options);
      }
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    this.assertWritable(`mv '${dest}'`);
    await this.cp(src, dest, { recursive: true });
    await this.rm(src, { recursive: true });
  }

  resolvePath(base: string, path: string): string {
    if (path.startsWith("/")) {
      return this.normalizePath(path);
    }
    const combined = base === "/" ? `/${path}` : `${base}/${path}`;
    return this.normalizePath(combined);
  }

  getAllPaths(): string[] {
    const paths = new Set<string>();

    for (const p of Array.from(this.loadedFiles)) {
      if (!this.deleted.has(p)) {
        paths.add(p);
      }
    }

    for (const p of Array.from(this.loadedDirs)) {
      if (!this.deleted.has(p)) {
        paths.add(p);
      }
    }

    for (const p of Array.from(this.modified)) {
      if (!this.deleted.has(p)) {
        paths.add(p);
      }
    }

    return Array.from(paths);
  }

  async chmod(path: string, mode: number): Promise<void> {
    this.assertWritable(`chmod '${path}'`);
    const normalized = this.normalizePath(path);

    const exists = await this.exists(normalized);
    if (!exists) {
      throw new Error(`ENOENT: no such file or directory, chmod '${path}'`);
    }

    if (!this.modified.has(normalized) && !this.loadedFiles.has(normalized) && !this.loadedDirs.has(normalized)) {
      await this.ensureFileLoaded(normalized);
    }

    await this.cache.chmod(normalized, mode);
    this.modified.add(normalized);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    this.assertWritable(`symlink '${linkPath}'`);
    const normalized = this.normalizePath(linkPath);

    const exists = await this.exists(normalized);
    if (exists) {
      throw new Error(`EEXIST: file already exists, symlink '${linkPath}'`);
    }

    const parent = this.dirname(normalized);
    if (parent !== "/") {
      await this.ensureDirLoaded(parent);
    }

    await this.cache.symlink(target, normalized);
    this.modified.add(normalized);
    this.markParentsModified(normalized);
    this.loadedFiles.add(normalized);
    this.deleted.delete(normalized);
    this.notExistsAsFile.delete(normalized);
    this.notExistsAsDir.delete(normalized);
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    this.assertWritable(`link '${newPath}'`);
    const existingNorm = this.normalizePath(existingPath);
    const newNorm = this.normalizePath(newPath);

    const srcExists = await this.exists(existingNorm);
    if (!srcExists) {
      throw new Error(`ENOENT: no such file or directory, link '${existingPath}'`);
    }

    const srcStat = await this.stat(existingNorm);
    if (!srcStat.isFile) {
      throw new Error(`EPERM: operation not permitted, link '${existingPath}'`);
    }

    const destExists = await this.exists(newNorm);
    if (destExists) {
      throw new Error(`EEXIST: file already exists, link '${newPath}'`);
    }

    const parent = this.dirname(newNorm);
    if (parent !== "/") {
      await this.ensureDirLoaded(parent);
    }

    await this.ensureFileLoaded(existingNorm);
    await this.cache.link(existingNorm, newNorm);

    this.modified.add(newNorm);
    this.markParentsModified(newNorm);
    this.loadedFiles.add(newNorm);
    this.deleted.delete(newNorm);
    this.notExistsAsFile.delete(newNorm);
    this.notExistsAsDir.delete(newNorm);
  }

  async readlink(path: string): Promise<string> {
    const normalized = this.normalizePath(path);

    if (this.deleted.has(normalized)) {
      throw new Error(`ENOENT: no such file or directory, readlink '${path}'`);
    }

    if (!this.modified.has(normalized) && !this.loadedFiles.has(normalized)) {
      const loaded = await this.ensureFileLoaded(normalized);
      if (!loaded) {
        throw new Error(`ENOENT: no such file or directory, readlink '${path}'`);
      }
    }

    return this.cache.readlink(normalized);
  }

  async realpath(path: string): Promise<string> {
    const normalized = this.normalizePath(path);

    const exists = await this.exists(normalized);
    if (!exists) {
      throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
    }

    if (!this.modified.has(normalized) && !this.loadedFiles.has(normalized) && !this.loadedDirs.has(normalized)) {
      await this.ensureFileLoaded(normalized);
    }

    const stat = await this.cache.lstat(normalized);
    if (stat.isSymbolicLink) {
      const target = await this.cache.readlink(normalized);
      const resolvedTarget = target.startsWith("/") ? target : this.resolvePath(this.dirname(normalized), target);

      const targetExists = await this.exists(resolvedTarget);
      if (!targetExists) {
        throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
      }

      return this.realpath(resolvedTarget);
    }

    return normalized;
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    this.assertWritable(`utimes '${path}'`);
    const normalized = this.normalizePath(path);

    const exists = await this.exists(normalized);
    if (!exists) {
      throw new Error(`ENOENT: no such file or directory, utimes '${path}'`);
    }

    if (!this.modified.has(normalized) && !this.loadedFiles.has(normalized) && !this.loadedDirs.has(normalized)) {
      await this.ensureFileLoaded(normalized);
    }

    await this.cache.utimes(normalized, atime, mtime);
    this.modified.add(normalized);
  }
}
