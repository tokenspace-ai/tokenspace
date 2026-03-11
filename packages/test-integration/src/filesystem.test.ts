/**
 * Integration tests for ConvexSessionFs filesystem implementation.
 *
 * Tests the ConvexSessionFs class against a real Convex backend to verify:
 * - Reading files from the base revision filesystem
 * - Writing files to the session overlay
 * - Modifying existing files
 * - Deleting files
 * - Directory listing
 * - File stat operations
 * - Session isolation
 * - Read-only mode
 */

import { beforeAll, describe, expect, it } from "bun:test";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { ConvexFs as ConvexSessionFs, type Id } from "@tokenspace/session-fs";
import { ConvexClient } from "convex/browser";
import { api } from "../../../services/backend/convex/_generated/api";
import { getSharedContext, getSharedHarness, waitForSetup } from "./setup";
import { EXAMPLE_DIR, getFunctionName, internal, type TestContext } from "./test-utils";

/**
 * Create a new session for testing.
 */
async function createSession(revisionId: string): Promise<string> {
  const backend = getSharedHarness().getBackend();

  const sessionId = (await backend.runFunction(getFunctionName(internal.sessions.createSession), {
    userId: "test-user",
    revisionId,
  })) as string;

  return sessionId;
}

describe("ConvexSessionFs Integration", () => {
  let context: TestContext;
  let client: ConvexClient;

  beforeAll(async () => {
    await waitForSetup();
    context = getSharedContext();

    // Create a real ConvexClient connected to the test backend
    const backend = getSharedHarness().getBackend();
    client = new ConvexClient(backend.backendUrl!);
  });

  describe("Reading revision filesystem files", () => {
    it("reads files from the base revision", async () => {
      const sessionId = await createSession(context.revisionId);

      const fs = new ConvexSessionFs({
        client,
        sessionId,
        allowWrites: true,
      });

      // builtins.d.ts should exist in the compiled revision filesystem
      const exists = await fs.exists("/builtins.d.ts");
      expect(exists).toBe(true);

      // Read the file content
      const content = await fs.readFile("/builtins.d.ts");
      expect(content).toBeDefined();
      expect(content.length).toBeGreaterThan(0);
    });

    it("reads capability declaration files", async () => {
      const sessionId = await createSession(context.revisionId);

      const fs = new ConvexSessionFs({
        client,
        sessionId,
        allowWrites: true,
      });

      // Capability files should exist (compiled from capability.ts)
      const exists = await fs.exists("/capabilities/testing/capability.d.ts");
      expect(exists).toBe(true);

      const content = await fs.readFile("/capabilities/testing/capability.d.ts");
      expect(content).toBeDefined();
    });

    it("throws ENOENT for non-existent files", async () => {
      const sessionId = await createSession(context.revisionId);

      const fs = new ConvexSessionFs({
        client,
        sessionId,
        allowWrites: true,
      });

      await expect(fs.readFile("/nonexistent-file.txt")).rejects.toThrow("ENOENT");
    });
  });

  describe("Writing to overlay", () => {
    it("writes new files to the overlay", async () => {
      const sessionId = await createSession(context.revisionId);

      const fs = new ConvexSessionFs({
        client,
        sessionId,
        allowWrites: true,
      });

      // Write a new file
      await fs.writeFile("/test-file.txt", "Hello from integration test!");

      // Read it back
      const content = await fs.readFile("/test-file.txt");
      expect(content).toBe("Hello from integration test!");
    });

    it("writes files with nested directories", async () => {
      const sessionId = await createSession(context.revisionId);

      const fs = new ConvexSessionFs({
        client,
        sessionId,
        allowWrites: true,
      });

      // Write a file in a nested directory
      await fs.writeFile("/deep/nested/path/file.txt", "Nested content");

      // Read it back
      const content = await fs.readFile("/deep/nested/path/file.txt");
      expect(content).toBe("Nested content");

      // Parent directories should exist
      expect(await fs.exists("/deep")).toBe(true);
      expect(await fs.exists("/deep/nested")).toBe(true);
      expect(await fs.exists("/deep/nested/path")).toBe(true);
    });

    it("modifies existing revision files in overlay", async () => {
      const sessionId = await createSession(context.revisionId);

      const fs = new ConvexSessionFs({
        client,
        sessionId,
        allowWrites: true,
      });

      // Read original content
      const original = await fs.readFile("/builtins.d.ts");

      // Write modified content
      const modified = `${original}\n// Modified in test`;
      await fs.writeFile("/builtins.d.ts", modified);

      // Read back should show modified content
      const readBack = await fs.readFile("/builtins.d.ts");
      expect(readBack).toBe(modified);
      expect(readBack).toContain("// Modified in test");
    });
  });

  describe("Binary uploads and downloads", () => {
    it("uploads and downloads large binary files via storage", async () => {
      const sessionId = await createSession(context.revisionId);

      const fs = new ConvexSessionFs({
        client,
        sessionId,
        allowWrites: true,
      });

      const size = 128 * 1024;
      const payload = new Uint8Array(size);
      for (let i = 0; i < payload.length; i++) {
        payload[i] = i % 256;
      }

      await fs.writeFile("/large-binary.bin", payload);

      const stored = await client.query(api.fs.overlay.readFile, {
        sessionId: sessionId as Id<"sessions">,
        path: "large-binary.bin",
      });
      expect(stored).not.toBeNull();
      expect(stored?.binary).toBe(true);
      expect(stored?.content).toBeUndefined();
      expect(stored?.downloadUrl).toBeDefined();

      const reader = new ConvexSessionFs({
        client,
        sessionId,
        allowWrites: false,
      });
      const readBack = await reader.readFileBuffer("/large-binary.bin");
      expect(readBack.length).toBe(payload.length);
      expect(Array.from(readBack)).toEqual(Array.from(payload));
    });
  });

  describe("Binary downloads from base revision filesystem", () => {
    it("downloads large binary files from the base revision", async () => {
      const sessionId = await createSession(context.revisionId);

      const fs = new ConvexSessionFs({
        client,
        sessionId,
        allowWrites: false,
      });

      const revisionPath = "/testdata/siftd.png";
      expect(await fs.exists(revisionPath)).toBe(true);

      const stored = await client.query(api.fs.overlay.readFile, {
        sessionId: sessionId as Id<"sessions">,
        path: "testdata/siftd.png",
      });
      expect(stored).not.toBeNull();
      expect(stored?.binary).toBe(true);
      expect(stored?.content).toBeUndefined();
      expect(stored?.downloadUrl).toBeDefined();

      const readBack = await fs.readFileBuffer(revisionPath);
      const expectedPath = nodePath.join(EXAMPLE_DIR, "src/testdata/siftd.png");
      const expected = nodeFs.readFileSync(expectedPath);
      expect(Buffer.compare(Buffer.from(readBack), expected)).toBe(0);
    });
  });

  describe("Deleting files", () => {
    it("deletes overlay files", async () => {
      const sessionId = await createSession(context.revisionId);

      const fs = new ConvexSessionFs({
        client,
        sessionId,
        allowWrites: true,
      });

      // Create a file
      await fs.writeFile("/to-delete.txt", "Delete me");
      expect(await fs.exists("/to-delete.txt")).toBe(true);

      // Delete it
      await fs.rm("/to-delete.txt");
      expect(await fs.exists("/to-delete.txt")).toBe(false);

      // Reading should throw ENOENT
      await expect(fs.readFile("/to-delete.txt")).rejects.toThrow("ENOENT");
    });

    it("deletes revision files via overlay marker", async () => {
      const sessionId = await createSession(context.revisionId);

      const fs = new ConvexSessionFs({
        client,
        sessionId,
        allowWrites: true,
      });

      // Verify builtins.d.ts exists
      expect(await fs.exists("/builtins.d.ts")).toBe(true);

      // Delete it (creates deletion marker in overlay)
      await fs.rm("/builtins.d.ts");

      // Should no longer exist in this session
      expect(await fs.exists("/builtins.d.ts")).toBe(false);
      await expect(fs.readFile("/builtins.d.ts")).rejects.toThrow("ENOENT");
    });
  });

  describe("Directory operations", () => {
    it("lists root directory contents", async () => {
      const sessionId = await createSession(context.revisionId);

      const fs = new ConvexSessionFs({
        client,
        sessionId,
        allowWrites: true,
      });

      const entries = await fs.readdir("/");
      expect(entries).toBeDefined();
      expect(entries.length).toBeGreaterThan(0);

      // Should contain builtins.d.ts and capabilities directory
      expect(entries).toContain("builtins.d.ts");
      expect(entries).toContain("capabilities");
    });

    it("lists subdirectory contents", async () => {
      const sessionId = await createSession(context.revisionId);

      const fs = new ConvexSessionFs({
        client,
        sessionId,
        allowWrites: true,
      });

      const entries = await fs.readdir("/capabilities");
      expect(entries).toBeDefined();
      expect(entries.length).toBeGreaterThan(0);

      // Should contain testing capability directory
      expect(entries).toContain("testing");
    });

    it("includes overlay files in directory listing", async () => {
      const sessionId = await createSession(context.revisionId);

      const fs = new ConvexSessionFs({
        client,
        sessionId,
        allowWrites: true,
      });

      // Create a new file in root
      await fs.writeFile("/overlay-test.txt", "Overlay content");

      const entries = await fs.readdir("/");
      expect(entries).toContain("overlay-test.txt");
    });

    it("excludes deleted files from directory listing", async () => {
      const sessionId = await createSession(context.revisionId);

      const fs = new ConvexSessionFs({
        client,
        sessionId,
        allowWrites: true,
      });

      // Create and then delete a file
      await fs.writeFile("/temp-file.txt", "Temporary");
      await fs.rm("/temp-file.txt");

      const entries = await fs.readdir("/");
      expect(entries).not.toContain("temp-file.txt");
    });
  });

  describe("File stat operations", () => {
    it("returns correct stat for files", async () => {
      const sessionId = await createSession(context.revisionId);

      const fs = new ConvexSessionFs({
        client,
        sessionId,
        allowWrites: true,
      });

      const stat = await fs.stat("/builtins.d.ts");
      expect(stat.isFile).toBe(true);
      expect(stat.isDirectory).toBe(false);
    });

    it("returns correct stat for directories", async () => {
      const sessionId = await createSession(context.revisionId);

      const fs = new ConvexSessionFs({
        client,
        sessionId,
        allowWrites: true,
      });

      const stat = await fs.stat("/capabilities");
      expect(stat.isFile).toBe(false);
      expect(stat.isDirectory).toBe(true);
    });

    it("throws ENOENT for non-existent paths", async () => {
      const sessionId = await createSession(context.revisionId);

      const fs = new ConvexSessionFs({
        client,
        sessionId,
        allowWrites: true,
      });

      await expect(fs.stat("/nonexistent")).rejects.toThrow("ENOENT");
    });
  });

  describe("Session isolation", () => {
    it("isolates writes between sessions", async () => {
      const sessionId1 = await createSession(context.revisionId);
      const sessionId2 = await createSession(context.revisionId);

      const fs1 = new ConvexSessionFs({
        client,
        sessionId: sessionId1,
        allowWrites: true,
      });

      const fs2 = new ConvexSessionFs({
        client,
        sessionId: sessionId2,
        allowWrites: true,
      });

      // Write a file in session 1
      await fs1.writeFile("/session1-only.txt", "Session 1 content");

      // Session 1 should see it
      expect(await fs1.exists("/session1-only.txt")).toBe(true);

      // Session 2 should NOT see it
      expect(await fs2.exists("/session1-only.txt")).toBe(false);
    });

    it("isolates deletes between sessions", async () => {
      const sessionId1 = await createSession(context.revisionId);
      const sessionId2 = await createSession(context.revisionId);

      const fs1 = new ConvexSessionFs({
        client,
        sessionId: sessionId1,
        allowWrites: true,
      });

      const fs2 = new ConvexSessionFs({
        client,
        sessionId: sessionId2,
        allowWrites: true,
      });

      // Both sessions should initially see builtins.d.ts
      expect(await fs1.exists("/builtins.d.ts")).toBe(true);
      expect(await fs2.exists("/builtins.d.ts")).toBe(true);

      // Delete in session 1
      await fs1.rm("/builtins.d.ts");

      // Session 1 should not see it
      expect(await fs1.exists("/builtins.d.ts")).toBe(false);

      // Session 2 should still see it
      expect(await fs2.exists("/builtins.d.ts")).toBe(true);
    });
  });

  describe("Read-only mode", () => {
    it("prevents writes when allowWrites is false", async () => {
      const sessionId = await createSession(context.revisionId);

      const fs = new ConvexSessionFs({
        client,
        sessionId,
        allowWrites: false,
      });

      await expect(fs.writeFile("/readonly-test.txt", "content")).rejects.toThrow("EROFS");
    });

    it("prevents deletes when allowWrites is false", async () => {
      const sessionId = await createSession(context.revisionId);

      const fs = new ConvexSessionFs({
        client,
        sessionId,
        allowWrites: false,
      });

      await expect(fs.rm("/builtins.d.ts")).rejects.toThrow("EROFS");
    });

    it("allows reads when allowWrites is false", async () => {
      const sessionId = await createSession(context.revisionId);

      const fs = new ConvexSessionFs({
        client,
        sessionId,
        allowWrites: false,
      });

      // Reading should work
      const content = await fs.readFile("/builtins.d.ts");
      expect(content).toBeDefined();
      expect(content.length).toBeGreaterThan(0);
    });
  });

  describe("Copy and move operations", () => {
    it("copies files within the session", async () => {
      const sessionId = await createSession(context.revisionId);

      const fs = new ConvexSessionFs({
        client,
        sessionId,
        allowWrites: true,
      });

      // Copy builtins.d.ts to a new location
      await fs.cp("/builtins.d.ts", "/builtins-copy.d.ts");

      // Both should exist
      expect(await fs.exists("/builtins.d.ts")).toBe(true);
      expect(await fs.exists("/builtins-copy.d.ts")).toBe(true);

      // Content should match
      const original = await fs.readFile("/builtins.d.ts");
      const copy = await fs.readFile("/builtins-copy.d.ts");
      expect(copy).toBe(original);
    });

    it("moves files within the session", async () => {
      const sessionId = await createSession(context.revisionId);

      const fs = new ConvexSessionFs({
        client,
        sessionId,
        allowWrites: true,
      });

      // Create a file to move
      await fs.writeFile("/to-move.txt", "Move me");

      // Move it
      await fs.mv("/to-move.txt", "/moved.txt");

      // Original should not exist
      expect(await fs.exists("/to-move.txt")).toBe(false);

      // New location should exist with same content
      expect(await fs.exists("/moved.txt")).toBe(true);
      expect(await fs.readFile("/moved.txt")).toBe("Move me");
    });
  });

  describe("Append operations", () => {
    it("appends to existing files", async () => {
      const sessionId = await createSession(context.revisionId);

      const fs = new ConvexSessionFs({
        client,
        sessionId,
        allowWrites: true,
      });

      // Create a file
      await fs.writeFile("/append-test.txt", "First line\n");

      // Append to it
      await fs.appendFile("/append-test.txt", "Second line\n");

      // Verify content
      const content = await fs.readFile("/append-test.txt");
      expect(content).toBe("First line\nSecond line\n");
    });

    it("creates file if not exists when appending", async () => {
      const sessionId = await createSession(context.revisionId);

      const fs = new ConvexSessionFs({
        client,
        sessionId,
        allowWrites: true,
      });

      // Append to non-existent file
      await fs.appendFile("/new-append.txt", "Created via append");

      // Should exist with the content
      expect(await fs.exists("/new-append.txt")).toBe(true);
      expect(await fs.readFile("/new-append.txt")).toBe("Created via append");
    });
  });
});
