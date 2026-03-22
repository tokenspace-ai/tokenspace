/**
 * Convex client setup for CLI operations
 */

import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { ConvexHttpClient } from "convex/browser";
import pc from "picocolors";
import { ensureStoredAuthDiscovery, getAccessToken, getAccessTokenWithRefresh } from "./auth.js";

let client: ConvexHttpClient | null = null;
let clientPromise: Promise<ConvexHttpClient> | null = null;

/**
 * Reset the client (e.g., after token refresh)
 */
export function resetClient(): void {
  client = null;
  clientPromise = null;
}

export async function getClient(): Promise<ConvexHttpClient> {
  if (client) {
    return client;
  }

  if (!clientPromise) {
    clientPromise = (async () => {
      const token = await getAccessTokenWithRefresh();
      const auth = await ensureStoredAuthDiscovery({
        accessToken: token ?? undefined,
        requireConvexUrl: true,
      });

      if (!auth?.convexUrl) {
        throw new Error("Convex URL not found. Run 'tokenspace login' to refresh your CLI configuration.");
      }

      const nextClient = new ConvexHttpClient(auth.convexUrl);
      if (token) {
        nextClient.setAuth(token);
      }
      client = nextClient;
      return nextClient;
    })().catch((error) => {
      clientPromise = null;
      throw error;
    });
  }

  return await clientPromise;
}

/**
 * Get authenticated user ID from token, or 'anonymous' if not authenticated
 */
export function getUserId(): string {
  const token = getAccessToken();
  if (!token) {
    return "anonymous";
  }

  // Decode JWT to get user ID (the 'sub' claim)
  try {
    const parts = token.split(".");
    const payloadPart = parts[1];
    if (!payloadPart) {
      return "cli-user";
    }
    const payload = JSON.parse(Buffer.from(payloadPart, "base64").toString());
    return payload.sub || "cli-user";
  } catch {
    return "cli-user";
  }
}

export type Workspace = {
  _id: Id<"workspaces">;
  name: string;
  slug: string;
  role: "workspace_admin" | "member";
  activeCommitId?: Id<"commits">;
  createdAt: number;
  updatedAt: number;
};

export type Branch = {
  _id: Id<"branches">;
  workspaceId: Id<"workspaces">;
  name: string;
  commitId: Id<"commits">;
  isDefault: boolean;
};

export type Commit = {
  _id: Id<"commits">;
  workspaceId: Id<"workspaces">;
  parentId?: Id<"commits">;
  treeId: Id<"trees">;
  message: string;
  authorId: string;
  createdAt: number;
};

export type FileData = {
  path: string;
  content: string;
  size: number;
};

export type BuildManifestSummary = {
  schemaVersion: number;
  compilerVersion: string;
  sourceFingerprint: string;
  mode: "local" | "server";
  artifacts: {
    revisionFs: { hash: string; size: number };
    bundle: { hash: string; size: number };
    metadata: { hash: string; size: number };
    diagnostics: { hash: string; size: number };
    deps?: { hash: string; size: number };
  };
};

export type CredentialRequirement = {
  id: string;
  label?: string;
  group?: string;
  kind: "secret" | "env" | "oauth";
  scope: "workspace" | "session" | "user";
  description?: string;
  placeholder?: string;
  optional?: boolean;
  config?: Record<string, unknown>;
};

export type WorkspaceCredentialBinding = {
  _id: Id<"credentialValues">;
  workspaceId: Id<"workspaces">;
  credentialId: string;
  scope: "workspace" | "session" | "user";
  subject: string;
  kind: "secret" | "oauth";
  keyVersion: number;
  createdAt: number;
  updatedAt: number;
  updatedByUserId?: string;
};

/**
 * Get workspace by slug
 */
export async function getWorkspaceBySlug(slug: string): Promise<Workspace | null> {
  const c = await getClient();
  return await c.query(api.workspace.getBySlug, { slug });
}

/**
 * Get default branch for a workspace
 */
export async function getDefaultBranch(workspaceId: Id<"workspaces">): Promise<Branch | null> {
  const c = await getClient();
  return await c.query(api.vcs.getDefaultBranch, { workspaceId });
}

/**
 * Get branch by name
 */
export async function getBranchByName(workspaceId: Id<"workspaces">, name: string): Promise<Branch | null> {
  const c = await getClient();
  return await c.query(api.vcs.getBranchByName, { workspaceId, name });
}

/**
 * Get commit by ID
 */
export async function getCommit(commitId: Id<"commits">): Promise<Commit | null> {
  const c = await getClient();
  return await c.query(api.vcs.getCommit, { commitId });
}

/**
 * Get all files in a tree
 */
export async function getAllFilesInTree(treeId: Id<"trees">): Promise<Array<{ path: string; blobId: Id<"blobs"> }>> {
  const c = await getClient();
  return await c.query(api.trees.getFlattenedTree, { treeId });
}

/**
 * Get file content from tree
 */
export async function getFileContent(
  treeId: Id<"trees">,
  path: string,
): Promise<{ path: string; content: string; size: number } | null> {
  const c = await getClient();
  const result = await c.query(api.trees.getFileFromTree, { treeId, path });
  if (!result) {
    return null;
  }
  if (result.content !== undefined) {
    return { path: result.path, content: result.content, size: result.size };
  }
  if (result.downloadUrl) {
    const response = await fetch(result.downloadUrl);
    if (!response.ok) {
      throw new Error(`Failed to download file content (${response.status})`);
    }
    const content = await response.text();
    return { path: result.path, content, size: result.size };
  }
  return null;
}

/**
 * Get working files for a branch/user
 */
export async function getWorkingFiles(branchId: Id<"branches">): Promise<
  Array<{
    _id: Id<"workingFiles">;
    path: string;
    content?: string;
    downloadUrl?: string;
    isDeleted: boolean;
    updatedAt: number;
  }>
> {
  const c = await getClient();
  const files = await c.query(api.fs.working.getAll, { branchId });
  const resolved = await Promise.all(
    files.map(
      async (file: {
        _id: Id<"workingFiles">;
        path: string;
        content?: string;
        downloadUrl?: string;
        isDeleted: boolean;
        updatedAt: number;
      }) => {
        if (file.isDeleted || file.content !== undefined || !file.downloadUrl) {
          return file;
        }
        const response = await fetch(file.downloadUrl);
        if (!response.ok) {
          throw new Error(`Failed to download file content (${response.status})`);
        }
        const content = await response.text();
        return { ...file, content };
      },
    ),
  );
  return resolved;
}

/**
 * Save a working file
 */
export async function saveWorkingFile(
  workspaceId: Id<"workspaces">,
  branchId: Id<"branches">,
  path: string,
  content: string,
): Promise<Id<"workingFiles">> {
  const c = await getClient();
  return await c.action(api.fs.working.save, {
    workspaceId,
    branchId,
    path,
    content,
  });
}

/**
 * Mark a working file as deleted
 */
export async function markWorkingFileDeleted(
  workspaceId: Id<"workspaces">,
  branchId: Id<"branches">,
  path: string,
): Promise<Id<"workingFiles">> {
  const c = await getClient();
  return await c.mutation(api.fs.working.markDeleted, {
    workspaceId,
    branchId,
    path,
  });
}

/**
 * Create a commit from working changes
 */
export async function createCommit(
  workspaceId: Id<"workspaces">,
  branchId: Id<"branches">,
  message: string,
): Promise<Id<"commits">> {
  const c = await getClient();
  return await c.action(api.vcs.createCommit, {
    workspaceId,
    branchId,
    message,
  });
}

/**
 * Discard all working files
 */
export async function discardAllWorkingFiles(branchId: Id<"branches">): Promise<number> {
  const c = await getClient();
  return await c.mutation(api.fs.working.discardAll, { branchId });
}

/**
 * Create a new branch
 */
export async function createBranch(workspaceId: Id<"workspaces">, name: string): Promise<Id<"branches">> {
  const c = await getClient();
  return await c.mutation(api.vcs.createBranch, { workspaceId, name });
}

/**
 * Initialize a workspace with an empty commit and main branch
 */
export async function initializeWorkspace(
  workspaceId: Id<"workspaces">,
): Promise<{ commitId: Id<"commits">; branchId: Id<"branches"> }> {
  const c = await getClient();
  return await c.mutation(api.vcs.initializeWorkspace, { workspaceId });
}

export async function prepareRevisionFromBuild(
  workspaceId: Id<"workspaces">,
  branchId: Id<"branches">,
  manifest: BuildManifestSummary,
): Promise<
  | { kind: "existing"; revisionId: Id<"revisions"> }
  | {
      kind: "upload";
      commitId: Id<"commits">;
      artifactFingerprint: string;
      upload: {
        revisionFs: { kind: "existing"; blobId: Id<"blobs"> } | { kind: "upload"; uploadUrl: string };
        bundle: { kind: "existing"; blobId: Id<"blobs"> } | { kind: "upload"; uploadUrl: string };
        metadata: { kind: "existing"; blobId: Id<"blobs"> } | { kind: "upload"; uploadUrl: string };
        diagnostics: { kind: "existing"; blobId: Id<"blobs"> } | { kind: "upload"; uploadUrl: string };
        deps?: { kind: "existing"; blobId: Id<"blobs"> } | { kind: "upload"; uploadUrl: string };
      };
    }
> {
  const c = await getClient();
  return await c.action(api.revisionBuild.prepareRevisionFromBuild, {
    workspaceId,
    branchId,
    manifest,
  });
}

export async function commitRevisionFromBuild(
  workspaceId: Id<"workspaces">,
  branchId: Id<"branches">,
  commitId: Id<"commits">,
  artifactFingerprint: string,
  manifest: BuildManifestSummary,
  artifacts: {
    revisionFs:
      | { blobId: Id<"blobs">; hash: string; size: number }
      | { storageId: Id<"_storage">; hash: string; size: number };
    bundle:
      | { blobId: Id<"blobs">; hash: string; size: number }
      | { storageId: Id<"_storage">; hash: string; size: number };
    metadata:
      | { blobId: Id<"blobs">; hash: string; size: number }
      | { storageId: Id<"_storage">; hash: string; size: number };
    diagnostics:
      | { blobId: Id<"blobs">; hash: string; size: number }
      | { storageId: Id<"_storage">; hash: string; size: number };
    deps?:
      | { blobId: Id<"blobs">; hash: string; size: number }
      | { storageId: Id<"_storage">; hash: string; size: number };
  },
): Promise<{ revisionId: Id<"revisions">; created: boolean }> {
  const c = await getClient();
  return await c.action(api.revisionBuild.commitRevisionFromBuild, {
    workspaceId,
    branchId,
    commitId,
    artifactFingerprint,
    manifest,
    artifacts,
  });
}

/**
 * Display error and exit
 */
export function exitWithError(message: string): never {
  console.error(pc.red(`Error: ${message}`));
  process.exit(1);
}

export async function getWorkspaceRevision(
  _workspaceId: Id<"workspaces">,
  branchId: Id<"branches">,
): Promise<Id<"revisions"> | null> {
  const c = await getClient();
  return await c.query(api.fs.revision.getCurrentRevisionIdForBranch, {
    branchId,
  });
}

export async function getCredentialRequirementsForRevision(
  revisionId: Id<"revisions">,
): Promise<CredentialRequirement[]> {
  const c = await getClient();
  return await c.query(api.credentials.getCredentialRequirementsForRevision, {
    revisionId,
  });
}

export async function listWorkspaceCredentialBindings(
  workspaceId: Id<"workspaces">,
): Promise<WorkspaceCredentialBinding[]> {
  const c = await getClient();
  return await c.query(api.credentials.listWorkspaceCredentialBindings, {
    workspaceId,
  });
}

export async function upsertWorkspaceSecretCredential(
  workspaceId: Id<"workspaces">,
  revisionId: Id<"revisions">,
  credentialId: string,
  value: string,
): Promise<Id<"credentialValues">> {
  const c = await getClient();
  return await c.mutation(api.credentials.upsertWorkspaceCredential, {
    workspaceId,
    revisionId,
    credentialId,
    kind: "secret",
    value: {
      value,
    },
  });
}
