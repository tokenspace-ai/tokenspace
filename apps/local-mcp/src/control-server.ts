import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { TokenspaceError } from "@tokenspace/sdk";
import type { LocalApprovalStore } from "./approvals";
import type { LocalCredentialManager } from "./credential-store";
import { LocalCredentialBackendError, LocalCredentialConfigurationError } from "./credential-store";
import type { LocalSession } from "./types";

import spaHtml from "./ui/index.html";

type SpaFile = { path: string; loader: string; headers: Record<string, string> };
type SpaManifest = { index: string; files: SpaFile[] };

function isProductionManifest(value: unknown): value is SpaManifest {
  return (
    !!value &&
    typeof value === "object" &&
    "index" in value &&
    "files" in value &&
    Array.isArray((value as SpaManifest).files)
  );
}

function buildAssetMap(): Map<string, { filePath: string; headers: Record<string, string> }> | null {
  if (!isProductionManifest(spaHtml)) return null;
  const scriptDir = import.meta.dirname;
  const map = new Map<string, { filePath: string; headers: Record<string, string> }>();
  for (const file of spaHtml.files) {
    const urlPath = `/${file.path.replace(/^\.\//, "")}`;
    map.set(urlPath, { filePath: join(scriptDir, file.path), headers: file.headers });
  }
  return map;
}

const prodAssets = buildAssetMap();

function responseJson(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });
}

function errorDetails(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  return undefined;
}

async function readNonceFromRequest(request: Request): Promise<string | null> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const nonce = formData.get("nonce");
    return typeof nonce === "string" ? nonce : null;
  }

  const headerNonce = request.headers.get("x-tokenspace-nonce");
  if (typeof headerNonce === "string" && headerNonce.length > 0) {
    return headerNonce;
  }

  const url = new URL(request.url);
  return url.searchParams.get("nonce");
}

async function readCredentialMutation(request: Request): Promise<{ nonce: string | null; value: string }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await request.json()) as Record<string, unknown>;
    return {
      nonce: request.headers.get("x-tokenspace-nonce") ?? new URL(request.url).searchParams.get("nonce"),
      value: typeof body.value === "string" ? body.value : "",
    };
  }

  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const nonce = formData.get("nonce");
    const value = formData.get("value");
    return {
      nonce: typeof nonce === "string" ? nonce : null,
      value: typeof value === "string" ? value : "",
    };
  }

  return {
    nonce: request.headers.get("x-tokenspace-nonce") ?? new URL(request.url).searchParams.get("nonce"),
    value: "",
  };
}

function statusCodeForError(error: unknown): number {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return 404;
  }
  if (error instanceof LocalCredentialConfigurationError) {
    return 400;
  }
  if (error instanceof LocalCredentialBackendError) {
    return 500;
  }
  if (error instanceof TokenspaceError) {
    const errorType =
      error.data && typeof error.data === "object" && "errorType" in error.data ? error.data.errorType : undefined;
    if (errorType === "CREDENTIAL_NOT_DECLARED") {
      return 404;
    }
    return 400;
  }
  if (error instanceof SyntaxError) {
    return 400;
  }
  if (error instanceof Error && error.message.includes("already")) {
    return 409;
  }
  return 500;
}

export type LocalControlServerHandle = {
  baseUrl: string;
  getApprovalUrl: (requestId: string) => string;
  close: () => Promise<void>;
};

type CreateLocalControlServerOptions = {
  session: LocalSession;
  approvalStore: LocalApprovalStore;
  credentialManager: LocalCredentialManager;
};

export async function createLocalControlServer({
  session,
  approvalStore,
  credentialManager,
}: CreateLocalControlServerOptions): Promise<LocalControlServerHandle> {
  const nonce = randomUUID();
  const hostname = "127.0.0.1";
  let server: Bun.Server<undefined> | null = null;

  const requestLink = (baseUrl: string, requestId: string) =>
    `${baseUrl}/approvals/${encodeURIComponent(requestId)}?nonce=${encodeURIComponent(nonce)}`;

  const serve = Bun.serve({
    hostname,
    port: 0,
    routes: {
      "/api/nonce": () => responseJson({ nonce }),

      "/api/session": () => {
        const baseUrl = `http://${hostname}:${server?.port ?? 0}`;
        const { capabilities, skills } = session.buildResult.metadata;
        return responseJson({
          sessionId: session.manifest.sessionId,
          workspaceName: session.manifest.workspaceName,
          workspaceDir: session.manifest.workspaceDir,
          sessionRoot: session.sessionRoot,
          sandboxDir: session.sandboxDir,
          buildDir: session.buildDir,
          sourceFingerprint: session.manifest.sourceFingerprint,
          buildOrigin: session.manifest.buildOrigin,
          controlBaseUrl: baseUrl,
          capabilities: capabilities.map((c) => ({
            name: c.name,
            description: c.description,
            namespace: c.typesPath.replace(/^capabilities\/([^/]+)\/.*$/, "$1"),
          })),
          skills: skills.map((s) => ({
            name: s.name,
            description: s.description,
          })),
        });
      },

      "/api/approvals": async () => {
        try {
          const approvals = await approvalStore.listApprovalRequests();
          return responseJson({ approvals });
        } catch (error) {
          return responseJson({ error: "Failed to load approvals.", details: errorDetails(error) }, { status: 500 });
        }
      },

      "/api/approvals/:requestId/approve": {
        async POST(req: Request) {
          try {
            const postedNonce = await readNonceFromRequest(req);
            if (postedNonce !== nonce) {
              return responseJson({ error: "Invalid nonce" }, { status: 403 });
            }
            const requestId = decodeURIComponent(new URL(req.url).pathname.split("/")[3] ?? "");
            const updatedRequest = await approvalStore.approveApprovalRequest(requestId);
            return responseJson({ requestId: updatedRequest.requestId, status: updatedRequest.status });
          } catch (error) {
            return responseJson(
              { error: error instanceof Error ? error.message : String(error) },
              { status: statusCodeForError(error) },
            );
          }
        },
      },

      "/api/approvals/:requestId/deny": {
        async POST(req: Request) {
          try {
            const postedNonce = await readNonceFromRequest(req);
            if (postedNonce !== nonce) {
              return responseJson({ error: "Invalid nonce" }, { status: 403 });
            }
            const requestId = decodeURIComponent(new URL(req.url).pathname.split("/")[3] ?? "");
            const updatedRequest = await approvalStore.denyApprovalRequest(requestId);
            return responseJson({ requestId: updatedRequest.requestId, status: updatedRequest.status });
          } catch (error) {
            return responseJson(
              { error: error instanceof Error ? error.message : String(error) },
              { status: statusCodeForError(error) },
            );
          }
        },
      },

      "/api/credentials": async () => {
        try {
          const credentials = await credentialManager.listCredentials();
          return responseJson({ credentials });
        } catch (error) {
          return responseJson(
            { error: "Failed to load credential state.", details: errorDetails(error) },
            { status: 500 },
          );
        }
      },

      "/api/credentials/:credentialId": {
        async PUT(req: Request) {
          try {
            const { nonce: requestNonce, value } = await readCredentialMutation(req);
            if (requestNonce !== nonce) {
              return responseJson({ error: "Invalid nonce" }, { status: 403 });
            }
            const credentialId = decodeURIComponent(new URL(req.url).pathname.split("/")[3] ?? "");
            await credentialManager.setSecret(credentialId, value);
            const credentials = await credentialManager.listCredentials();
            const updated = credentials.find((entry) => entry.id === credentialId);
            return responseJson({ credentialId, status: "stored", credential: updated });
          } catch (error) {
            return responseJson(
              { error: error instanceof Error ? error.message : String(error) },
              { status: statusCodeForError(error) },
            );
          }
        },

        async DELETE(req: Request) {
          try {
            const requestNonce = await readNonceFromRequest(req);
            if (requestNonce !== nonce) {
              return responseJson({ error: "Invalid nonce" }, { status: 403 });
            }
            const credentialId = decodeURIComponent(new URL(req.url).pathname.split("/")[3] ?? "");
            await credentialManager.deleteSecret(credentialId);
            const credentials = await credentialManager.listCredentials();
            const updated = credentials.find((entry) => entry.id === credentialId);
            return responseJson({ credentialId, status: "deleted", credential: updated });
          } catch (error) {
            return responseJson(
              { error: error instanceof Error ? error.message : String(error) },
              { status: statusCodeForError(error) },
            );
          }
        },
      },

      ...(prodAssets ? {} : ({ "/*": spaHtml } as Record<string, typeof spaHtml>)),
    },

    fetch(req): Response {
      if (prodAssets) {
        const { pathname } = new URL(req.url);
        if (pathname.startsWith("/api/")) {
          return responseJson({ error: "Not found" }, { status: 404 });
        }
        const asset = prodAssets.get(pathname);
        if (asset) {
          return new Response(Bun.file(asset.filePath), { headers: asset.headers });
        }
        const indexAsset = prodAssets.get("/index.html");
        if (indexAsset) {
          return new Response(Bun.file(indexAsset.filePath), {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
      }
      return responseJson({ error: "Not found" }, { status: 404 });
    },
  });
  server = serve;

  return {
    baseUrl: `http://${hostname}:${serve.port}`,
    getApprovalUrl: (requestId: string) => requestLink(`http://${hostname}:${serve.port}`, requestId),
    close: async () => {
      server?.stop(true);
      await Promise.resolve();
    },
  };
}
