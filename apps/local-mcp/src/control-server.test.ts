import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalApprovalStore } from "./approvals";
import { createLocalControlServer } from "./control-server";
import type { LocalSecretsStore } from "./credential-store";
import { createLocalCredentialManager } from "./credential-store";
import { createLocalSession } from "./session";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const CREDENTIAL_WORKSPACE_DIR = path.join(REPO_ROOT, "apps/local-mcp/fixtures/credential-workspace");

async function createCredentialSession() {
  const sessionsRootDir = await mkdtemp(path.join(tmpdir(), "tokenspace-local-mcp-control-session-"));
  const session = await createLocalSession({
    workspaceDir: CREDENTIAL_WORKSPACE_DIR,
    sessionsRootDir,
  });

  return { sessionsRootDir, session };
}

function nonceFromApprovalUrl(approvalUrl: string): string {
  const nonce = new URL(approvalUrl).searchParams.get("nonce");
  if (!nonce) throw new Error(`Missing nonce in ${approvalUrl}`);
  return nonce;
}

function createMemorySecretsStore(): LocalSecretsStore {
  const entries = new Map<string, string>();
  const key = ({ service, name }: { service: string; name: string }) => `${service}:${name}`;

  return {
    get: async (address) => entries.get(key(address)) ?? null,
    set: async ({ service, name, value }) => {
      entries.set(`${service}:${name}`, value);
    },
    delete: async (address) => entries.delete(key(address)),
  };
}

describe("local control server", () => {
  it("serves the SPA shell and API responses for approvals and credentials", async () => {
    const { sessionsRootDir, session } = await createCredentialSession();
    const approvalStore = await createLocalApprovalStore(session);
    const credentialManager = createLocalCredentialManager(session, {
      secretsStore: createMemorySecretsStore(),
    });
    const originalWorkspaceEnv = process.env.TOK_LOCAL_MCP_SERVER_TEST_ENV;
    delete process.env.TOK_LOCAL_MCP_SERVER_TEST_ENV;
    await credentialManager.deleteSecret("workspace-secret").catch(() => undefined);
    await credentialManager.deleteSecret("session-secret").catch(() => undefined);
    await credentialManager.deleteSecret("user-secret").catch(() => undefined);
    const request = await approvalStore.createApprovalRequest({
      action: "demo:delete",
      data: { id: 42 },
      info: { dryRun: false },
      description: "Delete the demo record",
      reason: "User requested deletion",
    });
    const server = await createLocalControlServer({ session, approvalStore, credentialManager });

    try {
      const dashboardResponse = await fetch(`${server.baseUrl}/`);
      const dashboardHtml = await dashboardResponse.text();
      expect(dashboardResponse.status).toBe(200);
      expect(dashboardHtml).toContain('<div id="root">');

      const apiSession = (await (await fetch(`${server.baseUrl}/api/session`)).json()) as Record<string, string>;
      expect(apiSession.workspaceName).toBe(path.basename(CREDENTIAL_WORKSPACE_DIR));
      expect(apiSession.controlBaseUrl).toBe(server.baseUrl);
      expect(apiSession.buildOrigin).toBe(session.manifest.buildOrigin);

      const apiNonce = (await (await fetch(`${server.baseUrl}/api/nonce`)).json()) as { nonce: string };
      expect(typeof apiNonce.nonce).toBe("string");
      expect(apiNonce.nonce.length).toBeGreaterThan(0);

      const apiApprovals = (await (await fetch(`${server.baseUrl}/api/approvals`)).json()) as {
        approvals: Array<{ requestId: string }>;
      };
      expect(apiApprovals.approvals.map((item) => item.requestId)).toContain(request.requestId);

      const apiCredentials = (await (await fetch(`${server.baseUrl}/api/credentials`)).json()) as {
        credentials: Array<Record<string, unknown>>;
      };
      expect(apiCredentials.credentials).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "workspace-env",
            kind: "env",
            variableName: "TOK_LOCAL_MCP_SERVER_TEST_ENV",
            configured: false,
          }),
          expect.objectContaining({
            id: "workspace-oauth",
            kind: "oauth",
            status: "unsupported",
            supported: false,
          }),
          expect.objectContaining({
            id: "workspace-secret",
            kind: "secret",
            scope: "workspace",
            effectiveScope: "workspace",
            configured: false,
          }),
          expect.objectContaining({
            id: "session-secret",
            kind: "secret",
            scope: "session",
            effectiveScope: "workspace",
            configured: false,
          }),
          expect.objectContaining({
            id: "user-secret",
            kind: "secret",
            scope: "user",
            effectiveScope: "workspace",
            configured: false,
          }),
        ]),
      );
    } finally {
      if (originalWorkspaceEnv === undefined) {
        delete process.env.TOK_LOCAL_MCP_SERVER_TEST_ENV;
      } else {
        process.env.TOK_LOCAL_MCP_SERVER_TEST_ENV = originalWorkspaceEnv;
      }
      await credentialManager.deleteSecret("workspace-secret").catch(() => undefined);
      await credentialManager.deleteSecret("session-secret").catch(() => undefined);
      await credentialManager.deleteSecret("user-secret").catch(() => undefined);
      await server.close();
      await rm(sessionsRootDir, { recursive: true, force: true });
    }
  });

  it("stores and deletes secrets, and rejects invalid nonces", async () => {
    const { sessionsRootDir, session } = await createCredentialSession();
    const approvalStore = await createLocalApprovalStore(session);
    const credentialManager = createLocalCredentialManager(session, {
      secretsStore: createMemorySecretsStore(),
    });
    await credentialManager.deleteSecret("workspace-secret").catch(() => undefined);
    await credentialManager.deleteSecret("session-secret").catch(() => undefined);
    await credentialManager.deleteSecret("user-secret").catch(() => undefined);
    const approveRequest = await approvalStore.createApprovalRequest({
      action: "demo:approve",
      data: { id: 1 },
      reason: "Approve this request",
    });
    const denyRequest = await approvalStore.createApprovalRequest({
      action: "demo:deny",
      data: { id: 2 },
      reason: "Deny this request",
    });
    const server = await createLocalControlServer({ session, approvalStore, credentialManager });
    const nonce = nonceFromApprovalUrl(server.getApprovalUrl(approveRequest.requestId));

    try {
      const invalidCredentialResponse = await fetch(`${server.baseUrl}/api/credentials/session-secret`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-tokenspace-nonce": "bad-nonce",
        },
        body: JSON.stringify({ value: "secret-value" }),
      });
      expect(invalidCredentialResponse.status).toBe(403);

      const saveCredentialResponse = await fetch(`${server.baseUrl}/api/credentials/session-secret`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-tokenspace-nonce": nonce,
        },
        body: JSON.stringify({ value: "secret-value" }),
      });
      expect(saveCredentialResponse.status).toBe(200);
      const savedPayload = (await saveCredentialResponse.json()) as {
        credential?: { configured?: boolean; status?: string };
      };
      expect(savedPayload.credential).toMatchObject({
        configured: true,
        status: "configured",
      });

      const formSaveCredentialResponse = await fetch(`${server.baseUrl}/api/credentials/user-secret`, {
        method: "PUT",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ nonce, value: "form-secret-value" }),
      });
      expect(formSaveCredentialResponse.status).toBe(200);
      const formSavedPayload = (await formSaveCredentialResponse.json()) as {
        credential?: { configured?: boolean; status?: string };
      };
      expect(formSavedPayload.credential).toMatchObject({
        configured: true,
        status: "configured",
      });

      const saveEnvResponse = await fetch(`${server.baseUrl}/api/credentials/workspace-env`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-tokenspace-nonce": nonce,
        },
        body: JSON.stringify({ value: "manual-override" }),
      });
      expect(saveEnvResponse.status).toBe(200);
      const savedEnvPayload = (await saveEnvResponse.json()) as {
        credential?: { configured?: boolean; status?: string; overridden?: boolean };
      };
      expect(savedEnvPayload.credential).toMatchObject({
        configured: true,
        status: "configured",
        overridden: true,
      });

      const deleteEnvResponse = await fetch(`${server.baseUrl}/api/credentials/workspace-env`, {
        method: "DELETE",
        headers: {
          "x-tokenspace-nonce": nonce,
        },
      });
      expect(deleteEnvResponse.status).toBe(200);
      const deletedEnvPayload = (await deleteEnvResponse.json()) as {
        credential?: { configured?: boolean; status?: string; overridden?: boolean };
      };
      expect(deletedEnvPayload.credential).toMatchObject({
        configured: false,
        status: "missing",
      });

      const deleteCredentialResponse = await fetch(`${server.baseUrl}/api/credentials/session-secret`, {
        method: "DELETE",
        headers: {
          "x-tokenspace-nonce": nonce,
        },
      });
      expect(deleteCredentialResponse.status).toBe(200);
      const deletedPayload = (await deleteCredentialResponse.json()) as {
        credential?: { configured?: boolean; status?: string };
      };
      expect(deletedPayload.credential).toMatchObject({
        configured: false,
        status: "missing",
      });

      const invalidApprovalResponse = await fetch(
        `${server.baseUrl}/api/approvals/${approveRequest.requestId}/approve`,
        {
          method: "POST",
          body: new URLSearchParams({ nonce: "bad-nonce" }),
        },
      );
      expect(invalidApprovalResponse.status).toBe(403);

      const approveResponse = await fetch(`${server.baseUrl}/api/approvals/${approveRequest.requestId}/approve`, {
        method: "POST",
        body: new URLSearchParams({ nonce }),
      });
      expect(approveResponse.status).toBe(200);
      expect((await approvalStore.getApprovalRequest(approveRequest.requestId))?.status).toBe("approved");
      expect(await approvalStore.listGrantedApprovals()).toEqual([
        {
          action: "demo:approve",
          data: { id: 1 },
        },
      ]);

      const denyResponse = await fetch(`${server.baseUrl}/api/approvals/${denyRequest.requestId}/deny`, {
        method: "POST",
        body: new URLSearchParams({ nonce }),
      });
      expect(denyResponse.status).toBe(200);
      expect((await approvalStore.getApprovalRequest(denyRequest.requestId))?.status).toBe("denied");
    } finally {
      await credentialManager.deleteSecret("workspace-secret").catch(() => undefined);
      await credentialManager.deleteSecret("session-secret").catch(() => undefined);
      await credentialManager.deleteSecret("user-secret").catch(() => undefined);
      await server.close();
      await rm(sessionsRootDir, { recursive: true, force: true });
    }
  });

  it("returns 404 for missing approval ids", async () => {
    const { sessionsRootDir, session } = await createCredentialSession();
    const approvalStore = await createLocalApprovalStore(session);
    const credentialManager = createLocalCredentialManager(session, {
      secretsStore: createMemorySecretsStore(),
    });
    await credentialManager.deleteSecret("workspace-secret").catch(() => undefined);
    await credentialManager.deleteSecret("session-secret").catch(() => undefined);
    await credentialManager.deleteSecret("user-secret").catch(() => undefined);
    const server = await createLocalControlServer({ session, approvalStore, credentialManager });
    const missingId = "00000000-0000-4000-8000-000000000000";
    const nonce = nonceFromApprovalUrl(server.getApprovalUrl(missingId));

    try {
      const response = await fetch(`${server.baseUrl}/api/approvals/${missingId}/approve`, {
        method: "POST",
        body: new URLSearchParams({ nonce }),
      });
      expect(response.status).toBe(404);
    } finally {
      await credentialManager.deleteSecret("workspace-secret").catch(() => undefined);
      await credentialManager.deleteSecret("session-secret").catch(() => undefined);
      await credentialManager.deleteSecret("user-secret").catch(() => undefined);
      await server.close();
      await rm(sessionsRootDir, { recursive: true, force: true });
    }
  });

  it("returns controlled errors when credential listing fails", async () => {
    const { sessionsRootDir, session } = await createCredentialSession();
    const approvalStore = await createLocalApprovalStore(session);
    const failingError = new Error("simulated credential backend failure");
    const credentialManager = {
      load: async () => undefined as never,
      listCredentials: async () => {
        throw failingError;
      },
      setSecret: async () => undefined,
      deleteSecret: async () => undefined,
    };
    const server = await createLocalControlServer({
      session,
      approvalStore,
      credentialManager,
    });

    try {
      const apiResponse = await fetch(`${server.baseUrl}/api/credentials`);
      expect(apiResponse.status).toBe(500);
      const apiPayload = (await apiResponse.json()) as {
        error?: string;
        details?: string;
      };
      expect(apiPayload).toMatchObject({
        error: "Failed to load credential state.",
        details: "simulated credential backend failure",
      });
    } finally {
      await server.close();
      await rm(sessionsRootDir, { recursive: true, force: true });
    }
  });
});
