import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractCredentialRequirementsFromWorkspace } from "./credential-extraction";

const REPO_ROOT = path.join(import.meta.dir, "../../..");
const SDK_DIR = path.join(REPO_ROOT, "packages/sdk");

async function withTempWorkspace(
  files: Record<string, string>,
  testFn: (workspaceDir: string) => Promise<void>,
): Promise<void> {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), "tokenspace-credential-extraction-"));
  try {
    const sdkLinkDir = path.join(workspaceDir, "node_modules/@tokenspace");
    await mkdir(sdkLinkDir, { recursive: true });
    await symlink(SDK_DIR, path.join(sdkLinkDir, "sdk"));

    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = path.join(workspaceDir, relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, "utf8");
    }
    await testFn(workspaceDir);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

describe("extractCredentialRequirementsFromWorkspace", () => {
  it("returns empty requirements when src/credentials.ts does not exist", async () => {
    await withTempWorkspace(
      {
        "src/capabilities/demo/capability.ts": "export const noop = true;",
      },
      async (workspaceDir) => {
        const requirements = await extractCredentialRequirementsFromWorkspace(workspaceDir);
        expect(requirements).toEqual([]);
      },
    );
  });

  it("returns empty requirements when src/credentials.ts has no exports", async () => {
    await withTempWorkspace(
      {
        "src/credentials.ts": `
// intentionally blank
`,
      },
      async (workspaceDir) => {
        const requirements = await extractCredentialRequirementsFromWorkspace(workspaceDir);
        expect(requirements).toEqual([]);
      },
    );
  });

  it("evaluates dynamic exports with local imports and tsconfig path aliases", async () => {
    await withTempWorkspace(
      {
        "tsconfig.json": JSON.stringify(
          {
            compilerOptions: {
              baseUrl: ".",
              paths: {
                "@/*": ["src/*"],
              },
            },
          },
          null,
          2,
        ),
        "src/helpers/naming.ts": `
export function toCredentialName(value: string): string {
  return \`integration-\${value}\`;
}
`,
        "src/credentials.ts": `
import { credentials } from "@tokenspace/sdk";
import { toCredentialName } from "@/helpers/naming";

export const clientSecret = credentials.secret({
  id: toCredentialName("client-secret"),
  scope: "workspace",
  placeholder: "Enter client secret",
});

export const fallbackSecret = credentials.secret({
  id: toCredentialName("fallback"),
  scope: "workspace",
});

export const apiToken = credentials.secret({
  id: toCredentialName("api-token"),
  scope: "workspace",
  fallback: credentials.ref(fallbackSecret),
});

export const oauthToken = credentials.oauth({
  id: toCredentialName("oauth"),
  scope: "user",
  config: {
    grantType: "authorization_code",
    clientId: "abc123",
    clientSecret: credentials.ref(clientSecret),
    authorizeUrl: "https://example.com/oauth/authorize",
    tokenUrl: "https://example.com/oauth/token",
    scopes: ["profile", "repo"],
  },
});

export const encryptedEnv = credentials.env({
  id: toCredentialName("env"),
  variableName: "INTEGRATION_API_KEY",
  decryptionKey: credentials.ref(clientSecret),
});
`,
      },
      async (workspaceDir) => {
        const requirements = await extractCredentialRequirementsFromWorkspace(workspaceDir);
        expect(requirements).toHaveLength(5);

        const byExportName = new Map(requirements.map((entry) => [entry.exportName, entry]));
        expect(byExportName.get("clientSecret")?.placeholder).toBe("Enter client secret");
        expect(byExportName.get("apiToken")?.fallback).toBe("integration-fallback");
        expect(byExportName.get("oauthToken")?.config).toEqual({
          grantType: "authorization_code",
          clientId: "abc123",
          clientSecret: "integration-client-secret",
          authorizeUrl: "https://example.com/oauth/authorize",
          tokenUrl: "https://example.com/oauth/token",
          scopes: ["profile", "repo"],
        });
        expect(byExportName.get("encryptedEnv")?.config).toEqual({
          variableName: "INTEGRATION_API_KEY",
          decryptionKey: "integration-client-secret",
        });
      },
    );
  });

  it("supports external package imports when evaluating credentials", async () => {
    await withTempWorkspace(
      {
        "node_modules/credential-name-helper/package.json": JSON.stringify({
          name: "credential-name-helper",
          version: "1.0.0",
          type: "module",
          exports: "./index.js",
        }),
        "node_modules/credential-name-helper/index.js": `
export function addSuffix(name) {
  return name + "-external";
}
`,
        "src/credentials.ts": `
import { credentials } from "@tokenspace/sdk";
import { addSuffix } from "credential-name-helper";

export const token = credentials.secret({
  id: addSuffix("workspace-token"),
  scope: "workspace",
});
`,
      },
      async (workspaceDir) => {
        const requirements = await extractCredentialRequirementsFromWorkspace(workspaceDir);
        expect(requirements).toEqual([
          {
            path: "src/credentials.ts",
            exportName: "token",
            id: "workspace-token-external",
            label: undefined,
            group: undefined,
            kind: "secret",
            scope: "workspace",
            description: undefined,
            placeholder: undefined,
            optional: undefined,
            fallback: undefined,
          },
        ]);
      },
    );
  });

  it("captures raw icon metadata for later build normalization", async () => {
    await withTempWorkspace(
      {
        "src/credentials.ts": `
import { credentials } from "@tokenspace/sdk";

export const token = credentials.secret({
  id: "workspace-token",
  scope: "workspace",
  icon: "./capabilities/demo/icon.svg",
});
`,
      },
      async (workspaceDir) => {
        const requirements = await extractCredentialRequirementsFromWorkspace(workspaceDir);
        expect(requirements).toEqual([
          {
            path: "src/credentials.ts",
            exportName: "token",
            id: "workspace-token",
            label: undefined,
            group: undefined,
            kind: "secret",
            scope: "workspace",
            description: undefined,
            icon: "./capabilities/demo/icon.svg",
            placeholder: undefined,
            optional: undefined,
            fallback: undefined,
          },
        ]);
      },
    );
  });

  it("preserves the defining module path for re-exported credentials", async () => {
    await withTempWorkspace(
      {
        "src/integrations/github/credentials.ts": `
import { credentials } from "@tokenspace/sdk";

export const githubToken = credentials.secret({
  id: "github-token",
  scope: "workspace",
  icon: "./icon.svg",
});
`,
        "src/credentials.ts": `
export { githubToken } from "./integrations/github/credentials";
`,
      },
      async (workspaceDir) => {
        const requirements = await extractCredentialRequirementsFromWorkspace(workspaceDir);
        expect(requirements).toEqual([
          {
            path: "src/integrations/github/credentials.ts",
            exportName: "githubToken",
            id: "github-token",
            label: undefined,
            group: undefined,
            kind: "secret",
            scope: "workspace",
            description: undefined,
            icon: "./icon.svg",
            placeholder: undefined,
            optional: undefined,
            fallback: undefined,
          },
        ]);
      },
    );
  });

  it("throws when duplicate credential ids are exported", async () => {
    await withTempWorkspace(
      {
        "src/credentials.ts": `
import { credentials } from "@tokenspace/sdk";

export const first = credentials.secret({
  id: "duplicate-credential",
  scope: "workspace",
});

export const second = credentials.secret({
  id: "duplicate-credential",
  scope: "workspace",
});
`,
      },
      async (workspaceDir) => {
        await expect(extractCredentialRequirementsFromWorkspace(workspaceDir)).rejects.toThrow(
          'duplicate credential id "duplicate-credential"',
        );
      },
    );
  });

  it("normalizes blank label and group metadata to undefined", async () => {
    await withTempWorkspace(
      {
        "src/credentials.ts": `
import { credentials } from "@tokenspace/sdk";

export const token = credentials.secret({
  id: "workspace-token",
  scope: "workspace",
  label: "   ",
  group: "",
});
`,
      },
      async (workspaceDir) => {
        const requirements = await extractCredentialRequirementsFromWorkspace(workspaceDir);
        expect(requirements).toEqual([
          {
            path: "src/credentials.ts",
            exportName: "token",
            id: "workspace-token",
            label: undefined,
            group: undefined,
            kind: "secret",
            scope: "workspace",
            description: undefined,
            placeholder: undefined,
            optional: undefined,
            fallback: undefined,
          },
        ]);
      },
    );
  });

  it("throws for invalid credential export shapes", async () => {
    await withTempWorkspace(
      {
        "src/credentials.ts": `
export const brokenEnv = {
  kind: "env",
  id: "broken",
  scope: "workspace",
};
`,
      },
      async (workspaceDir) => {
        await expect(extractCredentialRequirementsFromWorkspace(workspaceDir)).rejects.toThrow("variableName");
      },
    );
  });

  it("fails when credentials module throws at runtime", async () => {
    await withTempWorkspace(
      {
        "src/credentials.ts": `
throw new Error("runtime failure during credential evaluation");
`,
      },
      async (workspaceDir) => {
        await expect(extractCredentialRequirementsFromWorkspace(workspaceDir)).rejects.toThrow(
          "runtime failure during credential evaluation",
        );
      },
    );
  });

  it("fails when credential evaluation times out", async () => {
    await withTempWorkspace(
      {
        "src/credentials.ts": `
await new Promise(() => {});
`,
      },
      async (workspaceDir) => {
        await expect(extractCredentialRequirementsFromWorkspace(workspaceDir, { timeoutMs: 100 })).rejects.toThrow(
          "timed out",
        );
      },
    );
  });

  it("ignores non-credential exports", async () => {
    await withTempWorkspace(
      {
        "src/credentials.ts": `
import { credentials } from "@tokenspace/sdk";

export const version = "v1";
export const config = { enabled: true };
export const token = credentials.secret({
  id: "secret-token",
  scope: "workspace",
});
`,
      },
      async (workspaceDir) => {
        const requirements = await extractCredentialRequirementsFromWorkspace(workspaceDir);
        expect(requirements.map((entry) => entry.exportName)).toEqual(["token"]);
      },
    );
  });

  it("preserves credential export declaration order", async () => {
    await withTempWorkspace(
      {
        "src/credentials.ts": `
import { credentials } from "@tokenspace/sdk";

export const zebra = credentials.secret({
  id: "zebra",
  group: "animals",
  scope: "workspace",
});

export const ant = credentials.secret({
  id: "ant",
  scope: "workspace",
});

export const yak = credentials.env({
  id: "yak",
  variableName: "YAK_TOKEN",
  scope: "workspace",
});
`,
      },
      async (workspaceDir) => {
        const requirements = await extractCredentialRequirementsFromWorkspace(workspaceDir);
        expect(requirements.map((entry) => entry.exportName)).toEqual(["zebra", "ant", "yak"]);
        expect(requirements.map((entry) => entry.id)).toEqual(["zebra", "ant", "yak"]);
      },
    );
  });
});
