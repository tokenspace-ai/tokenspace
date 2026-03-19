import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CredentialRequirementSummary } from "@tokenspace/compiler";
import { MissingCredentialError } from "@tokenspace/sdk";
import type { LocalSecretsStore } from "./credential-store";
import {
  createFallbackLocalSecretsStore,
  createLocalCredentialManager,
  createLocalFileSecretsStore,
  LocalCredentialBackendError,
} from "./credential-store";
import { createMemorySecretsStore } from "./test-utils";
import type { LocalSession } from "./types";

const cleanupCallbacks: Array<() => Promise<void>> = [];

function createCredentialManager(requirements: CredentialRequirementSummary[]) {
  const workspaceDir = `/tmp/tokenspace-local-mcp-${randomUUID()}`;
  const secrets = new Map<string, string>();
  const secretsStore: LocalSecretsStore = {
    get: async ({ service, name }) => secrets.get(`${service}:${name}`) ?? null,
    set: async ({ service, name, value }) => {
      secrets.set(`${service}:${name}`, value);
    },
    delete: async ({ service, name }) => secrets.delete(`${service}:${name}`),
  };
  const manager = createLocalCredentialManager(
    {
      manifest: {
        workspaceDir,
      },
      buildResult: {
        revisionFs: {
          files: [],
        },
        metadata: {
          credentialRequirements: requirements,
        },
      },
    } as unknown as LocalSession,
    { secretsStore },
  );

  cleanupCallbacks.push(async () => {
    for (const requirement of requirements) {
      if (requirement.kind === "secret") {
        await manager.deleteSecret(requirement.id).catch(() => undefined);
      }
    }
  });

  return manager;
}

afterEach(async () => {
  while (cleanupCallbacks.length > 0) {
    await cleanupCallbacks.pop()?.();
  }
});

describe("local credential manager", () => {
  it("loads a configured workspace secret", async () => {
    const manager = createCredentialManager([
      {
        path: "src/credentials.ts",
        exportName: "workspaceSecret",
        id: "workspace-secret",
        kind: "secret",
        scope: "workspace",
      },
    ]);

    await manager.setSecret("workspace-secret", "super-secret-value");

    expect((await manager.load("workspace-secret" as never)) as string | undefined).toBe("super-secret-value");
  });

  it("returns undefined for optional secret and env credentials", async () => {
    const envName = `TOK_LOCAL_OPTIONAL_${randomUUID().replaceAll("-", "_")}`;
    delete process.env[envName];

    const manager = createCredentialManager([
      {
        path: "src/credentials.ts",
        exportName: "optionalSecret",
        id: "optional-secret",
        kind: "secret",
        scope: "workspace",
        optional: true,
      },
      {
        path: "src/credentials.ts",
        exportName: "optionalEnv",
        id: "optional-env",
        kind: "env",
        scope: "workspace",
        optional: true,
        config: {
          variableName: envName,
        },
      },
    ]);

    expect((await manager.load("optional-secret" as never)) as string | undefined).toBeUndefined();
    expect((await manager.load("optional-env" as never)) as string | undefined).toBeUndefined();
  });

  it("throws actionable errors for missing required secret and env credentials", async () => {
    const envName = `TOK_LOCAL_REQUIRED_${randomUUID().replaceAll("-", "_")}`;
    delete process.env[envName];

    const manager = createCredentialManager([
      {
        path: "src/credentials.ts",
        exportName: "requiredSecret",
        id: "required-secret",
        kind: "secret",
        scope: "workspace",
      },
      {
        path: "src/credentials.ts",
        exportName: "requiredEnv",
        id: "required-env",
        kind: "env",
        scope: "workspace",
        config: {
          variableName: envName,
        },
      },
    ]);

    const secretError = await manager
      .load("required-secret" as never)
      .catch((error) => error as MissingCredentialError);
    const envError = await manager.load("required-env" as never).catch((error) => error as MissingCredentialError);

    expect(secretError).toBeInstanceOf(MissingCredentialError);
    expect(secretError.details).toContain("Configure it in the local control UI.");
    expect(envError).toBeInstanceOf(MissingCredentialError);
    expect(envError.details).toContain(envName);
  });

  it("reads env credentials directly from process.env", async () => {
    const envName = `TOK_LOCAL_ENV_${randomUUID().replaceAll("-", "_")}`;
    process.env[envName] = "env-secret-value";

    const manager = createCredentialManager([
      {
        path: "src/credentials.ts",
        exportName: "workspaceEnv",
        id: "workspace-env",
        kind: "env",
        scope: "workspace",
        config: {
          variableName: envName,
        },
      },
    ]);

    try {
      expect((await manager.load("workspace-env" as never)) as string | undefined).toBe("env-secret-value");
    } finally {
      delete process.env[envName];
    }
  });

  it("marks required oauth credentials as unsupported", async () => {
    const manager = createCredentialManager([
      {
        path: "src/credentials.ts",
        exportName: "oauthCredential",
        id: "oauth-credential",
        kind: "oauth",
        scope: "workspace",
        config: {
          grantType: "authorization_code",
          clientId: "client-id",
          clientSecret: "client-secret",
          authorizeUrl: "https://example.com/authorize",
          tokenUrl: "https://example.com/token",
          scopes: ["read"],
        },
      },
    ]);

    const oauthError = await manager
      .load("oauth-credential" as never)
      .catch((error) => error as MissingCredentialError);
    expect(oauthError).toBeInstanceOf(MissingCredentialError);
    expect(oauthError.details).toContain("OAuth credentials are not supported in local MCP yet.");
    const listed = await manager.listCredentials();
    expect(listed).toEqual([
      expect.objectContaining({
        id: "oauth-credential",
        kind: "oauth",
        status: "unsupported",
        supported: false,
      }),
    ]);
  });

  it("includes icon metadata and resolves local data URLs from revision files", async () => {
    const manager = createLocalCredentialManager(
      {
        manifest: {
          workspaceDir: `/tmp/tokenspace-local-mcp-${randomUUID()}`,
        },
        buildResult: {
          revisionFs: {
            files: [
              {
                path: "capabilities/demo/icon.svg",
                content: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>`,
              },
              {
                path: "docs/icon.png",
                content: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
                binary: true,
              },
            ],
          },
          metadata: {
            credentialRequirements: [
              {
                path: "src/credentials.ts",
                exportName: "svgSecret",
                id: "svg-secret",
                kind: "secret",
                scope: "workspace",
                iconPath: "capabilities/demo/icon.svg",
              },
              {
                path: "src/credentials.ts",
                exportName: "pngOauth",
                id: "png-oauth",
                kind: "oauth",
                scope: "workspace",
                iconPath: "docs/icon.png",
                config: {
                  grantType: "authorization_code",
                  clientId: "client-id",
                  clientSecret: "client-secret",
                  authorizeUrl: "https://example.com/authorize",
                  tokenUrl: "https://example.com/token",
                  scopes: ["read"],
                },
              },
            ],
          },
        },
      } as unknown as LocalSession,
      { secretsStore: createMemorySecretsStore() },
    );

    const listed = await manager.listCredentials();
    expect(listed).toEqual([
      expect.objectContaining({
        id: "png-oauth",
        iconPath: "docs/icon.png",
        iconUrl: expect.stringContaining("data:image/png;base64,"),
      }),
      expect.objectContaining({
        id: "svg-secret",
        iconPath: "capabilities/demo/icon.svg",
        iconUrl: expect.stringContaining("data:image/svg+xml;base64,"),
      }),
    ]);
  });

  it("ignores non-binary png icons", async () => {
    const manager = createLocalCredentialManager(
      {
        manifest: {
          workspaceDir: `/tmp/tokenspace-local-mcp-${randomUUID()}`,
        },
        buildResult: {
          revisionFs: {
            files: [
              {
                path: "docs/icon.png",
                content: "not-base64-png-bytes",
                binary: false,
              },
            ],
          },
          metadata: {
            credentialRequirements: [
              {
                path: "src/credentials.ts",
                exportName: "pngSecret",
                id: "png-secret",
                kind: "secret",
                scope: "workspace",
                iconPath: "docs/icon.png",
              },
            ],
          },
        },
      } as unknown as LocalSession,
      { secretsStore: createMemorySecretsStore() },
    );

    const [listed] = await manager.listCredentials();
    expect(listed).toEqual(
      expect.objectContaining({
        id: "png-secret",
        iconPath: "docs/icon.png",
        iconUrl: undefined,
      }),
    );
  });

  it("treats session and user secrets as workspace-local entries", async () => {
    const manager = createCredentialManager([
      {
        path: "src/credentials.ts",
        exportName: "sessionSecret",
        id: "session-secret",
        kind: "secret",
        scope: "session",
      },
      {
        path: "src/credentials.ts",
        exportName: "userSecret",
        id: "user-secret",
        kind: "secret",
        scope: "user",
      },
    ]);

    await manager.setSecret("session-secret", "session-value");
    await manager.setSecret("user-secret", "user-value");

    expect((await manager.load("session-secret" as never)) as string | undefined).toBe("session-value");
    expect((await manager.load("user-secret" as never)) as string | undefined).toBe("user-value");

    const listed = await manager.listCredentials();
    expect(listed).toEqual([
      expect.objectContaining({
        id: "session-secret",
        scope: "session",
        effectiveScope: "workspace",
        configured: true,
      }),
      expect.objectContaining({
        id: "user-secret",
        scope: "user",
        effectiveScope: "workspace",
        configured: true,
      }),
    ]);
  });

  it("falls back to the file secrets store when the OS secret backend is unavailable", async () => {
    const fallbackDir = await mkdtemp(path.join(tmpdir(), "tokenspace-local-mcp-secrets-"));
    cleanupCallbacks.push(async () => {
      await rm(fallbackDir, { recursive: true, force: true });
    });

    const failingSecretsStore: LocalSecretsStore = {
      get: async () => {
        throw new Error("Cannot autolaunch D-Bus without X11 $DISPLAY");
      },
      set: async () => {
        throw new Error("Cannot autolaunch D-Bus without X11 $DISPLAY");
      },
      delete: async () => {
        throw new Error("Cannot autolaunch D-Bus without X11 $DISPLAY");
      },
    };

    const manager = createLocalCredentialManager(
      {
        manifest: {
          workspaceDir: `/tmp/tokenspace-local-mcp-${randomUUID()}`,
        },
        buildResult: {
          metadata: {
            credentialRequirements: [
              {
                path: "src/credentials.ts",
                exportName: "workspaceSecret",
                id: "workspace-secret",
                kind: "secret",
                scope: "workspace",
              },
            ],
          },
        },
      } as LocalSession,
      {
        secretsStore: createFallbackLocalSecretsStore(failingSecretsStore, createLocalFileSecretsStore(fallbackDir)),
      },
    );

    await manager.setSecret("workspace-secret", "fallback-secret-value");
    expect((await manager.load("workspace-secret" as never)) as string | undefined).toBe("fallback-secret-value");
    await expect(manager.listCredentials()).resolves.toEqual([
      expect.objectContaining({
        id: "workspace-secret",
        configured: true,
        status: "configured",
      }),
    ]);
  });

  it("falls back to the file secrets store when libsecret is unavailable", async () => {
    const fallbackDir = await mkdtemp(path.join(tmpdir(), "tokenspace-local-mcp-secrets-"));
    cleanupCallbacks.push(async () => {
      await rm(fallbackDir, { recursive: true, force: true });
    });

    const failingSecretsStore: LocalSecretsStore = {
      get: async () => {
        throw new Error("libsecret not available");
      },
      set: async () => {
        throw new Error("libsecret not available");
      },
      delete: async () => {
        throw new Error("libsecret not available");
      },
    };

    const manager = createLocalCredentialManager(
      {
        manifest: {
          workspaceDir: `/tmp/tokenspace-local-mcp-${randomUUID()}`,
        },
        buildResult: {
          metadata: {
            credentialRequirements: [
              {
                path: "src/credentials.ts",
                exportName: "workspaceSecret",
                id: "workspace-secret",
                kind: "secret",
                scope: "workspace",
              },
            ],
          },
        },
      } as LocalSession,
      {
        secretsStore: createFallbackLocalSecretsStore(failingSecretsStore, createLocalFileSecretsStore(fallbackDir)),
      },
    );

    await manager.setSecret("workspace-secret", "libsecret-fallback-value");
    expect((await manager.load("workspace-secret" as never)) as string | undefined).toBe("libsecret-fallback-value");
  });

  it("wraps secret backend failures in typed backend errors", async () => {
    const failingSecretsStore: LocalSecretsStore = {
      get: async () => {
        throw new Error("simulated get failure");
      },
      set: async () => {
        throw new Error("simulated set failure");
      },
      delete: async () => {
        throw new Error("simulated delete failure");
      },
    };

    const manager = createLocalCredentialManager(
      {
        manifest: {
          workspaceDir: `/tmp/tokenspace-local-mcp-${randomUUID()}`,
        },
        buildResult: {
          metadata: {
            credentialRequirements: [
              {
                path: "src/credentials.ts",
                exportName: "workspaceSecret",
                id: "workspace-secret",
                kind: "secret",
                scope: "workspace",
              },
            ],
          },
        },
      } as LocalSession,
      {
        secretsStore: failingSecretsStore,
      },
    );

    const loadError = await manager.load("workspace-secret" as never).catch((error) => error);
    const setError = await manager.setSecret("workspace-secret", "value").catch((error) => error);
    const deleteError = await manager.deleteSecret("workspace-secret").catch((error) => error);

    expect(loadError).toBeInstanceOf(LocalCredentialBackendError);
    expect(loadError.message).toContain('could not read credential "workspace-secret"');
    expect(setError).toBeInstanceOf(LocalCredentialBackendError);
    expect(setError.message).toContain('could not store credential "workspace-secret"');
    expect(deleteError).toBeInstanceOf(LocalCredentialBackendError);
    expect(deleteError.message).toContain('could not delete credential "workspace-secret"');
  });
});
