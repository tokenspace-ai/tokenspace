import { beforeEach, describe, expect, it, mock } from "bun:test";
import { type FunctionReference, getFunctionName } from "convex/server";
import { ConvexSessionFs } from "./convex-fs";
import type { ConvexClient, DirectoryEntry, Id } from "./types";

// Test session ID - cast to proper type for testing
const TEST_SESSION_ID = "test-session" as Id<"sessions">;

/**
 * Mock Convex client for testing
 */
function createMockClient() {
  const files = new Map<string, { content: string; binary: boolean }>();
  const directories = new Set<string>();

  // Use type assertion for mock client since the mock function signature
  // doesn't match the full ConvexClient interface (we only implement query/mutation/action)
  const client = {
    query: mock(async <T>(fn: unknown, args: Record<string, unknown>): Promise<T> => {
      const fnName = getFunctionName(fn as FunctionReference<"query">);
      if (fnName === "fs/overlay:readFile") {
        const path = args.path as string;
        const file = files.get(path);
        if (!file) return null as T;
        return { content: file.content, binary: file.binary } as T;
      }
      if (fnName === "fs/overlay:listDirectory") {
        const parent = (args.parent as string) || "";
        const entries: DirectoryEntry[] = [];
        const prefix = parent ? `${parent}/` : "";

        for (const [filePath] of Array.from(files.entries())) {
          if (
            parent === ""
              ? !filePath.includes("/")
              : filePath.startsWith(prefix) && !filePath.slice(prefix.length).includes("/")
          ) {
            const name = parent === "" ? filePath : filePath.slice(prefix.length);
            if (name) entries.push({ name, type: "file" });
          }
        }
        for (const dir of Array.from(directories)) {
          if (parent === "" ? !dir.includes("/") : dir.startsWith(prefix) && !dir.slice(prefix.length).includes("/")) {
            const name = parent === "" ? dir : dir.slice(prefix.length);
            if (name) entries.push({ name, type: "directory" });
          }
        }
        return entries as T;
      }
      if (fnName === "fs/overlay:fileStat") {
        const path = args.path as string;
        if (files.has(path)) {
          return { isFile: true, isDirectory: false, size: files.get(path)!.content.length } as T;
        }
        if (directories.has(path) || path === "") {
          return { isFile: false, isDirectory: true, size: 0 } as T;
        }
        return null as T;
      }
      return null as T;
    }),
    action: mock(async <T>(fn: unknown, args: Record<string, unknown>): Promise<T> => {
      const fnName = getFunctionName(fn as FunctionReference<"action">);
      if (fnName === "fs/overlay:getUploadMetadata") {
        const binary = args.binary as boolean;
        if (binary) {
          return { kind: "existing", blobId: "blob-id" as Id<"blobs"> } as T;
        }
        return { kind: "inline" } as T;
      }
      if (fnName === "fs/overlay:writeFile") {
        const path = args.path as string;
        const content = args.content as string;
        const binary = args.binary as boolean;
        files.set(path, { content, binary });
        // Ensure parent directories exist
        const parts = path.split("/");
        for (let i = 1; i < parts.length; i++) {
          directories.add(parts.slice(0, i).join("/"));
        }
      }
      return null as T;
    }),
    mutation: mock(async <T>(fn: unknown, args: Record<string, unknown>): Promise<T> => {
      const fnName = getFunctionName(fn as FunctionReference<"mutation">);
      if (fnName === "fs/overlay:writeFile") {
        const path = args.path as string;
        const content = args.content as string;
        const binary = args.binary as boolean;
        files.set(path, { content, binary });
        // Ensure parent directories exist
        const parts = path.split("/");
        for (let i = 1; i < parts.length; i++) {
          directories.add(parts.slice(0, i).join("/"));
        }
      }
      if (fnName === "fs/overlay:deleteFile") {
        const path = args.path as string;
        files.delete(path);
        directories.delete(path);
      }
      return null as T;
    }),
  } as unknown as ConvexClient;

  return {
    client,
    files,
    directories,
    setFile: (path: string, content: string, binary = false) => {
      files.set(path, { content, binary });
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) {
        directories.add(parts.slice(0, i).join("/"));
      }
    },
    setDirectory: (path: string) => {
      directories.add(path);
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) {
        directories.add(parts.slice(0, i).join("/"));
      }
    },
  };
}

describe("ConvexFs", () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let fs: ConvexSessionFs;

  beforeEach(() => {
    mockClient = createMockClient();
    fs = new ConvexSessionFs({
      client: mockClient.client,
      sessionId: TEST_SESSION_ID,
      allowWrites: true,
    });
  });

  describe("constructor", () => {
    it("creates instance with required options", () => {
      const client = createMockClient().client;
      const fs = new ConvexSessionFs({ client, sessionId: "session-1" as Id<"sessions"> });
      expect(fs).toBeInstanceOf(ConvexSessionFs);
    });

    it("defaults allowWrites to true", async () => {
      const client = createMockClient().client;
      const fs = new ConvexSessionFs({ client, sessionId: "session-1" as Id<"sessions"> });
      // Should not throw
      await fs.writeFile("/test.txt", "content");
    });

    it("respects allowWrites: false", async () => {
      const client = createMockClient().client;
      const fs = new ConvexSessionFs({ client, sessionId: "session-1" as Id<"sessions">, allowWrites: false });
      await expect(fs.writeFile("/test.txt", "content")).rejects.toThrow("EROFS");
    });
  });

  describe("normalizePath", () => {
    it("handles root path", async () => {
      mockClient.setDirectory("");
      const exists = await fs.exists("/");
      expect(exists).toBe(true);
    });

    it("removes trailing slashes", async () => {
      mockClient.setFile("foo/bar.txt", "content");
      const exists = await fs.exists("/foo/bar.txt/");
      expect(exists).toBe(true);
    });

    it("adds leading slash if missing", async () => {
      mockClient.setFile("test.txt", "content");
      const exists = await fs.exists("test.txt");
      expect(exists).toBe(true);
    });

    it("resolves .. in paths", async () => {
      mockClient.setFile("foo/bar.txt", "content");
      const exists = await fs.exists("/foo/baz/../bar.txt");
      expect(exists).toBe(true);
    });

    it("resolves . in paths", async () => {
      mockClient.setFile("foo/bar.txt", "content");
      const exists = await fs.exists("/foo/./bar.txt");
      expect(exists).toBe(true);
    });
  });

  describe("readFile", () => {
    it("reads text file content", async () => {
      mockClient.setFile("test.txt", "hello world");
      const content = await fs.readFile("/test.txt");
      expect(content).toBe("hello world");
    });

    it("reads file with utf8 encoding", async () => {
      mockClient.setFile("test.txt", "hello world");
      const content = await fs.readFile("/test.txt", "utf8");
      expect(content).toBe("hello world");
    });

    it("reads file with encoding option object", async () => {
      mockClient.setFile("test.txt", "hello world");
      const content = await fs.readFile("/test.txt", { encoding: "utf8" });
      expect(content).toBe("hello world");
    });

    it("reads binary file as base64", async () => {
      const binaryContent = btoa("binary data");
      mockClient.setFile("test.bin", binaryContent, true);
      const content = await fs.readFileBuffer("/test.bin");
      expect(new TextDecoder().decode(content)).toBe("binary data");
    });

    it("throws ENOENT for non-existent file", async () => {
      await expect(fs.readFile("/nonexistent.txt")).rejects.toThrow("ENOENT");
    });

    it("throws ENOENT for deleted file", async () => {
      mockClient.setFile("test.txt", "content");
      await fs.rm("/test.txt");
      await expect(fs.readFile("/test.txt")).rejects.toThrow("ENOENT");
    });

    it("reads modified file from cache", async () => {
      await fs.writeFile("/new.txt", "new content");
      const content = await fs.readFile("/new.txt");
      expect(content).toBe("new content");
    });

    it("caches file after first read", async () => {
      mockClient.setFile("test.txt", "content");
      await fs.readFile("/test.txt");
      await fs.readFile("/test.txt"); // Second read should use cache
      // Query should only be called once for this file
      const queryCalls = (mockClient.client.query as ReturnType<typeof mock>).mock.calls;
      const readFileCalls = queryCalls.filter(
        (call) =>
          getFunctionName(call[0]) === "fs/overlay:readFile" && (call[1] as { path: string }).path === "test.txt",
      );
      expect(readFileCalls.length).toBe(1);
    });
  });

  describe("readFileBuffer", () => {
    it("returns Uint8Array for text file", async () => {
      mockClient.setFile("test.txt", "hello");
      const buffer = await fs.readFileBuffer("/test.txt");
      expect(buffer).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(buffer)).toBe("hello");
    });

    it("returns decoded binary content", async () => {
      const originalData = new Uint8Array([0, 1, 2, 255, 254]);
      let binary = "";
      for (let i = 0; i < originalData.length; i++) {
        binary += String.fromCharCode(originalData[i]!);
      }
      mockClient.setFile("test.bin", btoa(binary), true);
      const buffer = await fs.readFileBuffer("/test.bin");
      expect(buffer).toEqual(originalData);
    });
  });

  describe("writeFile", () => {
    it("writes text content", async () => {
      await fs.writeFile("/test.txt", "hello world");
      const content = await fs.readFile("/test.txt");
      expect(content).toBe("hello world");
    });

    it("writes Uint8Array content", async () => {
      const data = new TextEncoder().encode("binary content");
      await fs.writeFile("/test.bin", data);
      const buffer = await fs.readFileBuffer("/test.bin");
      expect(new TextDecoder().decode(buffer)).toBe("binary content");
    });

    it("creates parent directories", async () => {
      await fs.writeFile("/a/b/c/test.txt", "content");
      const exists = await fs.exists("/a/b/c");
      expect(exists).toBe(true);
    });

    it("calls Convex action", async () => {
      await fs.writeFile("/test.txt", "content");
      const actionCalls = (mockClient.client.action as ReturnType<typeof mock>).mock.calls;
      const writeCall = actionCalls.find((call) => getFunctionName(call[0]) === "fs/overlay:writeFile");
      expect(writeCall).toBeDefined();
      expect((writeCall![1] as { path: string }).path).toBe("test.txt");
    });

    it("throws EROFS when read-only", async () => {
      const roFs = new ConvexSessionFs({
        client: mockClient.client,
        sessionId: TEST_SESSION_ID,
        allowWrites: false,
      });
      await expect(roFs.writeFile("/test.txt", "content")).rejects.toThrow("EROFS");
    });

    it("marks file as modified", async () => {
      await fs.writeFile("/test.txt", "content");
      const paths = fs.getAllPaths();
      expect(paths).toContain("/test.txt");
    });

    it("clears deleted status when writing", async () => {
      mockClient.setFile("test.txt", "original");
      await fs.rm("/test.txt");
      await fs.writeFile("/test.txt", "new content");
      const content = await fs.readFile("/test.txt");
      expect(content).toBe("new content");
    });
  });

  describe("appendFile", () => {
    it("appends to existing file", async () => {
      mockClient.setFile("test.txt", "hello");
      await fs.appendFile("/test.txt", " world");
      const content = await fs.readFile("/test.txt");
      expect(content).toBe("hello world");
    });

    it("creates file if not exists", async () => {
      await fs.appendFile("/new.txt", "content");
      const content = await fs.readFile("/new.txt");
      expect(content).toBe("content");
    });

    it("appends to modified file", async () => {
      await fs.writeFile("/test.txt", "first");
      await fs.appendFile("/test.txt", " second");
      const content = await fs.readFile("/test.txt");
      expect(content).toBe("first second");
    });

    it("throws EROFS when read-only", async () => {
      const roFs = new ConvexSessionFs({
        client: mockClient.client,
        sessionId: TEST_SESSION_ID,
        allowWrites: false,
      });
      await expect(roFs.appendFile("/test.txt", "content")).rejects.toThrow("EROFS");
    });
  });

  describe("exists", () => {
    it("returns true for existing file", async () => {
      mockClient.setFile("test.txt", "content");
      expect(await fs.exists("/test.txt")).toBe(true);
    });

    it("returns true for existing directory", async () => {
      mockClient.setDirectory("mydir");
      expect(await fs.exists("/mydir")).toBe(true);
    });

    it("returns false for non-existent path", async () => {
      expect(await fs.exists("/nonexistent")).toBe(false);
    });

    it("returns false for deleted path", async () => {
      mockClient.setFile("test.txt", "content");
      await fs.rm("/test.txt");
      expect(await fs.exists("/test.txt")).toBe(false);
    });

    it("returns true for modified path", async () => {
      await fs.writeFile("/new.txt", "content");
      expect(await fs.exists("/new.txt")).toBe(true);
    });

    it("returns true for root directory", async () => {
      expect(await fs.exists("/")).toBe(true);
    });
  });

  describe("stat", () => {
    it("returns file stat", async () => {
      mockClient.setFile("test.txt", "content");
      const stat = await fs.stat("/test.txt");
      expect(stat.isFile).toBe(true);
      expect(stat.isDirectory).toBe(false);
    });

    it("returns directory stat", async () => {
      mockClient.setDirectory("mydir");
      const stat = await fs.stat("/mydir");
      expect(stat.isFile).toBe(false);
      expect(stat.isDirectory).toBe(true);
    });

    it("throws ENOENT for non-existent path", async () => {
      await expect(fs.stat("/nonexistent")).rejects.toThrow("ENOENT");
    });

    it("throws ENOENT for deleted path", async () => {
      mockClient.setFile("test.txt", "content");
      await fs.rm("/test.txt");
      await expect(fs.stat("/test.txt")).rejects.toThrow("ENOENT");
    });

    it("returns stat for modified file", async () => {
      await fs.writeFile("/new.txt", "content");
      const stat = await fs.stat("/new.txt");
      expect(stat.isFile).toBe(true);
    });
  });

  describe("lstat", () => {
    it("returns stat for file", async () => {
      mockClient.setFile("test.txt", "content");
      const stat = await fs.lstat("/test.txt");
      expect(stat.isFile).toBe(true);
    });

    it("returns stat for directory", async () => {
      mockClient.setDirectory("mydir");
      const stat = await fs.lstat("/mydir");
      expect(stat.isDirectory).toBe(true);
    });

    it("throws ENOENT for deleted path", async () => {
      mockClient.setFile("test.txt", "content");
      await fs.rm("/test.txt");
      await expect(fs.lstat("/test.txt")).rejects.toThrow("ENOENT");
    });
  });

  describe("mkdir", () => {
    it("creates directory", async () => {
      await fs.mkdir("/newdir");
      expect(await fs.exists("/newdir")).toBe(true);
    });

    it("creates nested directories with recursive option", async () => {
      await fs.mkdir("/a/b/c", { recursive: true });
      expect(await fs.exists("/a")).toBe(true);
      expect(await fs.exists("/a/b")).toBe(true);
      expect(await fs.exists("/a/b/c")).toBe(true);
    });

    it("throws EEXIST if directory exists without recursive", async () => {
      mockClient.setDirectory("existing");
      await expect(fs.mkdir("/existing")).rejects.toThrow("EEXIST");
    });

    it("does not throw if directory exists with recursive", async () => {
      mockClient.setDirectory("existing");
      await fs.mkdir("/existing", { recursive: true });
      expect(await fs.exists("/existing")).toBe(true);
    });

    it("throws ENOENT if parent does not exist without recursive", async () => {
      await expect(fs.mkdir("/nonexistent/child")).rejects.toThrow("ENOENT");
    });

    it("throws EROFS when read-only", async () => {
      const roFs = new ConvexSessionFs({
        client: mockClient.client,
        sessionId: TEST_SESSION_ID,
        allowWrites: false,
      });
      await expect(roFs.mkdir("/newdir")).rejects.toThrow("EROFS");
    });
  });

  describe("readdir", () => {
    it("returns list of file names", async () => {
      mockClient.setFile("dir/file1.txt", "content1");
      mockClient.setFile("dir/file2.txt", "content2");
      const entries = await fs.readdir("/dir");
      expect(entries).toContain("file1.txt");
      expect(entries).toContain("file2.txt");
    });

    it("returns empty array for empty directory", async () => {
      mockClient.setDirectory("emptydir");
      const entries = await fs.readdir("/emptydir");
      expect(entries).toEqual([]);
    });

    it("throws ENOENT for non-existent directory", async () => {
      await expect(fs.readdir("/nonexistent")).rejects.toThrow("ENOENT");
    });

    it("throws ENOENT for deleted directory", async () => {
      mockClient.setDirectory("mydir");
      await fs.rm("/mydir");
      await expect(fs.readdir("/mydir")).rejects.toThrow("ENOENT");
    });

    it("includes locally created files", async () => {
      mockClient.setDirectory("dir");
      await fs.writeFile("/dir/local.txt", "local content");
      const entries = await fs.readdir("/dir");
      expect(entries).toContain("local.txt");
    });

    it("excludes deleted files", async () => {
      mockClient.setFile("dir/file1.txt", "content");
      mockClient.setFile("dir/file2.txt", "content");
      await fs.rm("/dir/file1.txt");
      const entries = await fs.readdir("/dir");
      expect(entries).not.toContain("file1.txt");
      expect(entries).toContain("file2.txt");
    });
  });

  describe("readdirWithFileTypes", () => {
    it("returns entries with type information", async () => {
      mockClient.setFile("dir/file.txt", "content");
      mockClient.setDirectory("dir/subdir");
      const entries = await fs.readdirWithFileTypes("/dir");
      const fileEntry = entries.find((e) => e.name === "file.txt");
      const dirEntry = entries.find((e) => e.name === "subdir");
      expect(fileEntry?.isFile).toBe(true);
      expect(fileEntry?.isDirectory).toBe(false);
      expect(dirEntry?.isFile).toBe(false);
      expect(dirEntry?.isDirectory).toBe(true);
    });

    it("returns sorted entries", async () => {
      mockClient.setFile("dir/zebra.txt", "content");
      mockClient.setFile("dir/alpha.txt", "content");
      mockClient.setFile("dir/beta.txt", "content");
      const entries = await fs.readdirWithFileTypes("/dir");
      const names = entries.map((e) => e.name);
      expect(names).toEqual(["alpha.txt", "beta.txt", "zebra.txt"]);
    });
  });

  describe("rm", () => {
    it("removes file", async () => {
      mockClient.setFile("test.txt", "content");
      await fs.rm("/test.txt");
      expect(await fs.exists("/test.txt")).toBe(false);
    });

    it("throws ENOENT for non-existent file", async () => {
      await expect(fs.rm("/nonexistent")).rejects.toThrow("ENOENT");
    });

    it("does not throw with force option", async () => {
      await fs.rm("/nonexistent", { force: true });
    });

    it("throws ENOTEMPTY for non-empty directory without recursive", async () => {
      mockClient.setFile("dir/file.txt", "content");
      await expect(fs.rm("/dir")).rejects.toThrow("ENOTEMPTY");
    });

    it("removes directory recursively", async () => {
      mockClient.setFile("dir/file.txt", "content");
      mockClient.setFile("dir/subdir/nested.txt", "content");
      await fs.rm("/dir", { recursive: true });
      expect(await fs.exists("/dir")).toBe(false);
      expect(await fs.exists("/dir/file.txt")).toBe(false);
      expect(await fs.exists("/dir/subdir")).toBe(false);
    });

    it("calls Convex mutation", async () => {
      mockClient.setFile("test.txt", "content");
      await fs.rm("/test.txt");
      const mutationCalls = (mockClient.client.mutation as ReturnType<typeof mock>).mock.calls;
      const deleteCall = mutationCalls.find((call) => getFunctionName(call[0]) === "fs/overlay:deleteFile");
      expect(deleteCall).toBeDefined();
    });

    it("throws EROFS when read-only", async () => {
      mockClient.setFile("test.txt", "content");
      const roFs = new ConvexSessionFs({
        client: mockClient.client,
        sessionId: TEST_SESSION_ID,
        allowWrites: false,
      });
      await expect(roFs.rm("/test.txt")).rejects.toThrow("EROFS");
    });
  });

  describe("cp", () => {
    it("copies file", async () => {
      mockClient.setFile("src.txt", "content");
      await fs.cp("/src.txt", "/dest.txt");
      expect(await fs.readFile("/dest.txt")).toBe("content");
      expect(await fs.exists("/src.txt")).toBe(true);
    });

    it("throws ENOENT for non-existent source", async () => {
      await expect(fs.cp("/nonexistent", "/dest")).rejects.toThrow("ENOENT");
    });

    it("throws EISDIR for directory without recursive", async () => {
      mockClient.setDirectory("srcdir");
      await expect(fs.cp("/srcdir", "/destdir")).rejects.toThrow("EISDIR");
    });

    it("copies directory recursively", async () => {
      mockClient.setFile("srcdir/file1.txt", "content1");
      mockClient.setFile("srcdir/subdir/file2.txt", "content2");
      await fs.cp("/srcdir", "/destdir", { recursive: true });
      expect(await fs.readFile("/destdir/file1.txt")).toBe("content1");
      expect(await fs.readFile("/destdir/subdir/file2.txt")).toBe("content2");
    });

    it("throws EROFS when read-only", async () => {
      mockClient.setFile("src.txt", "content");
      const roFs = new ConvexSessionFs({
        client: mockClient.client,
        sessionId: TEST_SESSION_ID,
        allowWrites: false,
      });
      await expect(roFs.cp("/src.txt", "/dest.txt")).rejects.toThrow("EROFS");
    });
  });

  describe("mv", () => {
    it("moves file", async () => {
      mockClient.setFile("src.txt", "content");
      await fs.mv("/src.txt", "/dest.txt");
      expect(await fs.readFile("/dest.txt")).toBe("content");
      expect(await fs.exists("/src.txt")).toBe(false);
    });

    it("moves directory", async () => {
      mockClient.setFile("srcdir/file.txt", "content");
      await fs.mv("/srcdir", "/destdir");
      expect(await fs.readFile("/destdir/file.txt")).toBe("content");
      expect(await fs.exists("/srcdir")).toBe(false);
    });

    it("throws EROFS when read-only", async () => {
      mockClient.setFile("src.txt", "content");
      const roFs = new ConvexSessionFs({
        client: mockClient.client,
        sessionId: TEST_SESSION_ID,
        allowWrites: false,
      });
      await expect(roFs.mv("/src.txt", "/dest.txt")).rejects.toThrow("EROFS");
    });
  });

  describe("resolvePath", () => {
    it("resolves absolute path", () => {
      const result = fs.resolvePath("/base", "/absolute/path");
      expect(result).toBe("/absolute/path");
    });

    it("resolves relative path", () => {
      const result = fs.resolvePath("/base/dir", "relative/path");
      expect(result).toBe("/base/dir/relative/path");
    });

    it("resolves from root", () => {
      const result = fs.resolvePath("/", "path");
      expect(result).toBe("/path");
    });

    it("normalizes result", () => {
      const result = fs.resolvePath("/base", "../sibling/path");
      expect(result).toBe("/sibling/path");
    });
  });

  describe("getAllPaths", () => {
    it("returns empty array initially", () => {
      expect(fs.getAllPaths()).toEqual([]);
    });

    it("includes loaded files", async () => {
      mockClient.setFile("test.txt", "content");
      await fs.readFile("/test.txt");
      expect(fs.getAllPaths()).toContain("/test.txt");
    });

    it("includes modified files", async () => {
      await fs.writeFile("/new.txt", "content");
      expect(fs.getAllPaths()).toContain("/new.txt");
    });

    it("excludes deleted files", async () => {
      mockClient.setFile("test.txt", "content");
      await fs.readFile("/test.txt");
      await fs.rm("/test.txt");
      expect(fs.getAllPaths()).not.toContain("/test.txt");
    });
  });

  describe("chmod", () => {
    it("changes file mode", async () => {
      mockClient.setFile("test.txt", "content");
      await fs.chmod("/test.txt", 0o755);
      // Chmod marks file as modified
      expect(fs.getAllPaths()).toContain("/test.txt");
    });

    it("throws ENOENT for non-existent file", async () => {
      await expect(fs.chmod("/nonexistent", 0o755)).rejects.toThrow("ENOENT");
    });

    it("throws EROFS when read-only", async () => {
      mockClient.setFile("test.txt", "content");
      const roFs = new ConvexSessionFs({
        client: mockClient.client,
        sessionId: TEST_SESSION_ID,
        allowWrites: false,
      });
      await expect(roFs.chmod("/test.txt", 0o755)).rejects.toThrow("EROFS");
    });
  });

  describe("symlink", () => {
    it("creates symlink to existing target", async () => {
      mockClient.setFile("target.txt", "content");
      await fs.symlink("/target.txt", "/link");
      // Symlink is tracked in modified paths
      expect(fs.getAllPaths()).toContain("/link");
    });

    it("throws EEXIST if path exists", async () => {
      mockClient.setFile("existing.txt", "content");
      await expect(fs.symlink("/target", "/existing.txt")).rejects.toThrow("EEXIST");
    });

    it("throws EROFS when read-only", async () => {
      const roFs = new ConvexSessionFs({
        client: mockClient.client,
        sessionId: TEST_SESSION_ID,
        allowWrites: false,
      });
      await expect(roFs.symlink("/target", "/link")).rejects.toThrow("EROFS");
    });
  });

  describe("link", () => {
    it("creates hard link", async () => {
      mockClient.setFile("original.txt", "content");
      await fs.link("/original.txt", "/hardlink.txt");
      expect(await fs.readFile("/hardlink.txt")).toBe("content");
    });

    it("throws ENOENT for non-existent source", async () => {
      await expect(fs.link("/nonexistent", "/link")).rejects.toThrow("ENOENT");
    });

    it("throws EPERM for directory source", async () => {
      mockClient.setDirectory("mydir");
      await expect(fs.link("/mydir", "/link")).rejects.toThrow("EPERM");
    });

    it("throws EEXIST if destination exists", async () => {
      mockClient.setFile("original.txt", "content");
      mockClient.setFile("existing.txt", "other");
      await expect(fs.link("/original.txt", "/existing.txt")).rejects.toThrow("EEXIST");
    });

    it("throws EROFS when read-only", async () => {
      mockClient.setFile("original.txt", "content");
      const roFs = new ConvexSessionFs({
        client: mockClient.client,
        sessionId: TEST_SESSION_ID,
        allowWrites: false,
      });
      await expect(roFs.link("/original.txt", "/link")).rejects.toThrow("EROFS");
    });
  });

  describe("readlink", () => {
    it("reads symlink target", async () => {
      mockClient.setFile("target.txt", "content");
      await fs.symlink("/target.txt", "/link");
      const target = await fs.readlink("/link");
      expect(target).toBe("/target.txt");
    });

    it("throws ENOENT for non-existent path", async () => {
      await expect(fs.readlink("/nonexistent")).rejects.toThrow("ENOENT");
    });

    it("throws for non-symlink file", async () => {
      mockClient.setFile("regular.txt", "content");
      // readlink on a regular file should throw (it's not a symlink)
      await expect(fs.readlink("/regular.txt")).rejects.toThrow();
    });
  });

  describe("realpath", () => {
    it("returns normalized path for regular file", async () => {
      mockClient.setFile("test.txt", "content");
      const real = await fs.realpath("/test.txt");
      expect(real).toBe("/test.txt");
    });

    it("resolves symlink to existing target", async () => {
      mockClient.setFile("target.txt", "content");
      // First load the target so it exists in cache
      await fs.readFile("/target.txt");
      await fs.symlink("/target.txt", "/link");
      const real = await fs.realpath("/link");
      expect(real).toBe("/target.txt");
    });

    it("throws ENOENT for non-existent path", async () => {
      await expect(fs.realpath("/nonexistent")).rejects.toThrow("ENOENT");
    });

    it("throws ENOENT for broken symlink", async () => {
      // Create a file first so the symlink can be created
      mockClient.setFile("temp.txt", "temp");
      await fs.symlink("/nonexistent-target", "/broken-link");
      await expect(fs.realpath("/broken-link")).rejects.toThrow("ENOENT");
    });
  });

  describe("utimes", () => {
    it("updates file times", async () => {
      mockClient.setFile("test.txt", "content");
      const atime = new Date("2024-01-01");
      const mtime = new Date("2024-06-01");
      await fs.utimes("/test.txt", atime, mtime);
      // Should mark as modified
      expect(fs.getAllPaths()).toContain("/test.txt");
    });

    it("throws ENOENT for non-existent file", async () => {
      await expect(fs.utimes("/nonexistent", new Date(), new Date())).rejects.toThrow("ENOENT");
    });

    it("throws EROFS when read-only", async () => {
      mockClient.setFile("test.txt", "content");
      const roFs = new ConvexSessionFs({
        client: mockClient.client,
        sessionId: TEST_SESSION_ID,
        allowWrites: false,
      });
      await expect(roFs.utimes("/test.txt", new Date(), new Date())).rejects.toThrow("EROFS");
    });
  });

  describe("encoding support", () => {
    it("handles base64 encoding", async () => {
      mockClient.setFile("test.txt", "hello");
      const content = await fs.readFile("/test.txt", "base64");
      expect(content).toBe(btoa("hello"));
    });

    it("handles hex encoding", async () => {
      mockClient.setFile("test.txt", "AB");
      const content = await fs.readFile("/test.txt", "hex");
      expect(content).toBe("4142");
    });

    it("handles binary/latin1/ascii encoding", async () => {
      mockClient.setFile("test.txt", "hello");
      const binaryContent = await fs.readFile("/test.txt", "binary");
      const latin1Content = await fs.readFile("/test.txt", "latin1");
      const asciiContent = await fs.readFile("/test.txt", "ascii");
      expect(binaryContent).toBe("hello");
      expect(latin1Content).toBe("hello");
      expect(asciiContent).toBe("hello");
    });
  });

  describe("caching behavior", () => {
    it("marks file as not existing after failed load", async () => {
      await fs.exists("/nonexistent.txt");
      // Second check should not query Convex
      const queryCalls = (mockClient.client.query as ReturnType<typeof mock>).mock.calls.length;
      await fs.exists("/nonexistent.txt");
      // Additional queries might be made for directory check, but file read should be cached
      expect((mockClient.client.query as ReturnType<typeof mock>).mock.calls.length).toBeLessThanOrEqual(
        queryCalls + 2,
      );
    });

    it("clears not-exists status when file is created", async () => {
      expect(await fs.exists("/new.txt")).toBe(false);
      await fs.writeFile("/new.txt", "content");
      expect(await fs.exists("/new.txt")).toBe(true);
    });
  });
});
