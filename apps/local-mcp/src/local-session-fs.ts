import { lstatSync } from "node:fs";
import path from "node:path";
import type { BufferEncoding, CpOptions, FileContent, FsStat, IFileSystem, MkdirOptions, RmOptions } from "just-bash";
import { ReadWriteFs } from "just-bash";
import { resolveSandboxPath, SandboxPathError } from "./path-safety";

interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

interface ReadFileOptions {
  encoding?: BufferEncoding | null;
}

interface WriteFileOptions {
  encoding?: BufferEncoding;
}

export class LocalSessionFs implements IFileSystem {
  private readonly sandboxRoot: string;
  private readonly fs: ReadWriteFs;

  constructor(sandboxRoot: string) {
    this.sandboxRoot = sandboxRoot;
    this.fs = new ReadWriteFs({ root: sandboxRoot });
  }

  private async normalizePath(filePath: string): Promise<string> {
    const { relativePath } = await resolveSandboxPath({
      sandboxRoot: this.sandboxRoot,
      path: filePath,
      allowRootAbsolute: true,
    });
    return relativePath ? `/${relativePath}` : "/";
  }

  private normalizePathSync(filePath: string): string {
    if (filePath.includes("\0")) {
      throw new SandboxPathError("Sandbox paths cannot contain NUL bytes.");
    }

    const normalizedInput = filePath.replace(/\\/g, "/").trim();
    const absoluteish = normalizedInput === "" ? "/" : normalizedInput;
    const candidate = absoluteish.startsWith("/") ? absoluteish : `/${absoluteish}`;
    const parts = candidate.split("/");
    const resolved: string[] = [];

    for (const part of parts) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (resolved.length === 0) {
          throw new SandboxPathError(`Sandbox path escapes the sandbox root: ${filePath}`);
        }
        resolved.pop();
        continue;
      }
      resolved.push(part);
    }

    let current = this.sandboxRoot;
    for (const segment of resolved) {
      current = path.join(current, segment);
      try {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink()) {
          throw new SandboxPathError(`Sandbox path traverses a symbolic link: ${filePath}`);
        }
      } catch (error) {
        if (error instanceof SandboxPathError) throw error;
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          break;
        }
        throw error;
      }
    }

    return resolved.length ? `/${resolved.join("/")}` : "/";
  }

  async readFile(filePath: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    return await this.fs.readFile(await this.normalizePath(filePath), options);
  }

  async readFileBuffer(filePath: string): Promise<Uint8Array> {
    return await this.fs.readFileBuffer(await this.normalizePath(filePath));
  }

  async writeFile(filePath: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    await this.fs.writeFile(await this.normalizePath(filePath), content, options);
  }

  async appendFile(filePath: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    await this.fs.appendFile(await this.normalizePath(filePath), content, options);
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      return await this.fs.exists(await this.normalizePath(filePath));
    } catch (error) {
      if (error instanceof SandboxPathError) return false;
      throw error;
    }
  }

  async stat(filePath: string): Promise<FsStat> {
    return await this.fs.stat(await this.normalizePath(filePath));
  }

  async lstat(filePath: string): Promise<FsStat> {
    return await this.fs.lstat(await this.normalizePath(filePath));
  }

  async mkdir(filePath: string, options?: MkdirOptions): Promise<void> {
    await this.fs.mkdir(await this.normalizePath(filePath), options);
  }

  async readdir(filePath: string): Promise<string[]> {
    return await this.fs.readdir(await this.normalizePath(filePath));
  }

  async readdirWithFileTypes(filePath: string): Promise<DirentEntry[]> {
    return await this.fs.readdirWithFileTypes(await this.normalizePath(filePath));
  }

  async rm(filePath: string, options?: RmOptions): Promise<void> {
    await this.fs.rm(await this.normalizePath(filePath), options);
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    await this.fs.cp(await this.normalizePath(src), await this.normalizePath(dest), options);
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.fs.mv(await this.normalizePath(src), await this.normalizePath(dest));
  }

  resolvePath(base: string, targetPath: string): string {
    return this.normalizePathSync(this.fs.resolvePath(this.normalizePathSync(base), targetPath));
  }

  getAllPaths(): string[] {
    return this.fs.getAllPaths().filter((entry) => {
      try {
        this.normalizePathSync(entry);
        return true;
      } catch {
        return false;
      }
    });
  }

  async chmod(filePath: string, mode: number): Promise<void> {
    await this.fs.chmod(await this.normalizePath(filePath), mode);
  }

  async symlink(_target: string, _linkPath: string): Promise<void> {
    throw new SandboxPathError("Symbolic links are not allowed in the local session sandbox.");
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    await this.fs.link(await this.normalizePath(existingPath), await this.normalizePath(newPath));
  }

  async readlink(filePath: string): Promise<string> {
    return await this.fs.readlink(await this.normalizePath(filePath));
  }

  async realpath(filePath: string): Promise<string> {
    return await this.fs.realpath(await this.normalizePath(filePath));
  }

  async utimes(filePath: string, atime: Date, mtime: Date): Promise<void> {
    await this.fs.utimes(await this.normalizePath(filePath), atime, mtime);
  }
}
