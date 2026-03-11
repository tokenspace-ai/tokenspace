import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CredentialStore } from "@tokenspace/sdk";
import { InMemoryFs } from "just-bash";
import { executeCode } from "./index";

const workspaceBundle = `
import { hasApproval } from "@tokenspace/sdk";
import { getCredential, secret } from "@tokenspace/sdk/credentials";

const demoSecret = secret({
  id: "demo-secret",
  scope: "workspace",
});

export const __tokenspace = {
  commands: [
    {
      name: "read-credential",
      load: async () => ({
        default: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          const value = await getCredential(demoSecret);
          return { stdout: value, stderr: "", exitCode: 0 };
        },
      }),
    },
    {
      name: "check-approval",
      load: async () => ({
        default: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return {
            stdout: String(hasApproval({ action: "demo:allowed" })),
            stderr: "",
            exitCode: 0,
          };
        },
      }),
    },
    {
      name: "check-scoped-context",
      load: async () => ({
        default: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          if (!hasApproval({ action: "demo:allowed" })) {
            throw new Error("approval missing");
          }
          const value = await getCredential(demoSecret);
          return { stdout: \`command:\${value}\`, stderr: "", exitCode: 0 };
        },
      }),
    },
  ],
};
`;

async function createBundle(contents: string): Promise<{ bundlePath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(import.meta.dir, ".tmp-runtime-core-"));
  const bundlePath = join(dir, "bundle.mjs");
  await Bun.write(bundlePath, contents);
  return {
    bundlePath,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function createBundleServer(contents: string): { bundleUrl: string; cleanup: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/bundle.mjs") {
        return new Response(contents, {
          headers: { "content-type": "text/javascript" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    bundleUrl: new URL("/bundle.mjs", server.url).toString(),
    cleanup: () => {
      server.stop(true);
    },
  };
}

function createCredentialStore(value: string, delayMs = 0): CredentialStore {
  return {
    load: async (name) => {
      expect(String(name)).toBe("demo-secret");
      if (delayMs > 0) {
        await Bun.sleep(delayMs);
      }
      return value as never;
    },
  };
}

describe("@tokenspace/runtime-core", () => {
  test("executes code against a bundled workspace with an in-memory filesystem", async () => {
    const { bundlePath, cleanup } = await createBundle("export const demo = { value: 42 };");

    try {
      const result = await executeCode("console.log(demo.value);", {
        bundlePath,
        fileSystem: new InMemoryFs(),
        sessionId: "test-session",
      });

      expect(result.truncated).toBe(false);
      expect(result.output).toBe("42");
    } finally {
      await cleanup();
    }
  });

  test("isolates credential stores across concurrent executions", async () => {
    const { bundlePath, cleanup } = await createBundle(workspaceBundle);

    try {
      const [first, second] = await Promise.all([
        executeCode('console.log(await bash("read-credential"));', {
          bundlePath,
          fileSystem: new InMemoryFs(),
          sessionId: "credential-a",
          credentialStore: createCredentialStore("alpha", 10),
        }),
        executeCode('console.log(await bash("read-credential"));', {
          bundlePath,
          fileSystem: new InMemoryFs(),
          sessionId: "credential-b",
          credentialStore: createCredentialStore("beta", 1),
        }),
      ]);

      expect(first.output).toBe("alpha");
      expect(second.output).toBe("beta");
    } finally {
      await cleanup();
    }
  });

  test("isolates approvals across concurrent executions", async () => {
    const { bundlePath, cleanup } = await createBundle(workspaceBundle);

    try {
      const [approved, denied] = await Promise.all([
        executeCode('console.log(await bash("check-approval"));', {
          bundlePath,
          fileSystem: new InMemoryFs(),
          sessionId: "approval-a",
          approvals: [{ action: "demo:allowed" }],
        }),
        executeCode('console.log(await bash("check-approval"));', {
          bundlePath,
          fileSystem: new InMemoryFs(),
          sessionId: "approval-b",
          approvals: [],
        }),
      ]);

      expect(approved.output).toBe("true");
      expect(denied.output).toBe("false");
    } finally {
      await cleanup();
    }
  });

  test("preserves scoped credentials and approvals in nested custom bash commands", async () => {
    const { bundlePath, cleanup } = await createBundle(workspaceBundle);

    try {
      const result = await executeCode('console.log(await bash("check-scoped-context"));', {
        bundlePath,
        fileSystem: new InMemoryFs(),
        sessionId: "nested-bash",
        approvals: [{ action: "demo:allowed" }],
        credentialStore: createCredentialStore("from-bash"),
      });

      expect(result.output).toBe("command:from-bash");
    } finally {
      await cleanup();
    }
  });

  test("loads workspace custom commands from bundleUrl in direct bash mode", async () => {
    const { bundleUrl, cleanup } = createBundleServer(workspaceBundle);

    try {
      const result = await executeCode("read-credential", {
        language: "bash",
        bundleUrl,
        fileSystem: new InMemoryFs(),
        sessionId: "bash-bundle-url",
        credentialStore: createCredentialStore("url-direct"),
      });

      expect(result.output).toBe("url-direct");
    } finally {
      cleanup();
    }
  });

  test("loads workspace custom commands from bundleUrl in builtin bash()", async () => {
    const { bundleUrl, cleanup } = createBundleServer(workspaceBundle);

    try {
      const result = await executeCode('console.log(await bash("read-credential"));', {
        bundleUrl,
        fileSystem: new InMemoryFs(),
        sessionId: "builtin-bash-bundle-url",
        credentialStore: createCredentialStore("url-nested"),
      });

      expect(result.output).toBe("url-nested");
    } finally {
      cleanup();
    }
  });

  test("shares one runtime root between session artifacts and builtin fs", async () => {
    const result = await executeCode(
      `
await session.writeArtifact("artifact.txt", "artifact body");
console.log(await fs.readText("/memory/.tokenspace/artifacts/artifact.txt"));
console.log((await fs.list("/")).includes("memory"));
`,
      {
        fileSystem: new InMemoryFs(),
        sessionId: "shared-runtime-root",
      },
    );

    expect(result.output).toBe("artifact body\ntrue");
  });
});
