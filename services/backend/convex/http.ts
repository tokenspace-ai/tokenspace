import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction } from "./_generated/server";
import { requireSessionOwnership, requireWorkspaceMember } from "./authz";
import { loadFileContent } from "./fs/fileBlobs";
import { parsePath } from "./fs/index";

const http = httpRouter();

type ServedFile = {
  content?: string;
  blobId?: Id<"blobs">;
  binary: boolean;
};

function errorResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "private, no-store, max-age=0",
    },
  });
}

function normalizeRequestedPath(rawPath: string | null): string {
  const trimmed = rawPath?.trim() ?? "";
  if (!trimmed) {
    throw new Error("path is required");
  }
  if (trimmed.includes("\0")) {
    throw new Error("path is invalid");
  }

  let normalized = trimmed.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    throw new Error("path is invalid");
  }
  if (normalized.startsWith("sandbox/") || normalized.startsWith("revision/")) {
    throw new Error("path is invalid");
  }

  normalized = normalizeSlashes(normalized);
  if (!normalized || normalized === "." || normalized.startsWith("../")) {
    throw new Error("path is invalid");
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("path is invalid");
  }

  return normalized;
}

function contentTypeForPath(filePath: string): string {
  switch (getLowercaseExtension(filePath)) {
    case ".svg":
      return "image/svg+xml; charset=utf-8";
    case ".png":
      return "image/png";
    default:
      return "application/octet-stream";
  }
}

function normalizeSlashes(filePath: string): string {
  const segments: string[] = [];
  for (const segment of filePath.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        return "../";
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function getLowercaseExtension(filePath: string): string {
  const slashIndex = filePath.lastIndexOf("/");
  const dotIndex = filePath.lastIndexOf(".");
  if (dotIndex === -1 || dotIndex < slashIndex) {
    return "";
  }
  return filePath.slice(dotIndex).toLowerCase();
}

function decodeBase64ToArrayBuffer(value: string): ArrayBuffer {
  const bytes = Buffer.from(value, "base64");
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function resolveRevisionFile(
  ctx: any,
  revisionId: Id<"revisions">,
  requestedPath: string,
): Promise<ServedFile | null> {
  const revision = await ctx.runQuery(internal.revisions.getRevision, { revisionId });
  if (!revision) {
    return null;
  }
  await requireWorkspaceMember(ctx, revision.workspaceId);

  const file = await ctx.runQuery(internal.fs.revision.readFileAtPath, {
    revisionId,
    path: requestedPath,
  });
  if (!file) {
    return null;
  }

  return {
    content: file.content,
    blobId: file.blobId,
    binary: file.binary,
  };
}

async function resolveSessionFile(
  ctx: any,
  sessionId: Id<"sessions">,
  requestedPath: string,
): Promise<ServedFile | null> {
  const session = await requireSessionOwnership(ctx, sessionId);
  const { parent, name } = parsePath(requestedPath);
  const file = await ctx.runQuery(internal.fs.overlay.read, {
    sessionId,
    revisionId: session.revisionId,
    parent,
    name,
  });
  if (!file) {
    return null;
  }

  return {
    content: file.content,
    blobId: file.blobId,
    binary: file.binary,
  };
}

export const serveWorkspaceFile = httpAction(async (ctx, request) => {
  try {
    const url = new URL(request.url);
    const revisionId = url.searchParams.get("revisionId") as Id<"revisions"> | null;
    const sessionId = url.searchParams.get("sessionId") as Id<"sessions"> | null;
    if ((revisionId ? 1 : 0) + (sessionId ? 1 : 0) !== 1) {
      return errorResponse(400, "Exactly one of revisionId or sessionId is required.");
    }

    const requestedPath = normalizeRequestedPath(url.searchParams.get("path"));
    const file = sessionId
      ? await resolveSessionFile(ctx, sessionId, requestedPath)
      : await resolveRevisionFile(ctx, revisionId!, requestedPath);

    if (!file) {
      return errorResponse(404, "File not found.");
    }

    const content = await loadFileContent(ctx, { content: file.content, blobId: file.blobId }, { binary: file.binary });
    if (content === undefined) {
      return errorResponse(404, "File not found.");
    }

    return new Response(file.binary ? new Blob([decodeBase64ToArrayBuffer(content)]) : content, {
      status: 200,
      headers: {
        "content-type": contentTypeForPath(requestedPath),
        "cache-control": "private, no-store, max-age=0",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "Unauthorized") {
      return errorResponse(401, "Unauthorized");
    }
    if (message === "Session not found" || message === "Revision not found") {
      return errorResponse(404, message);
    }
    if (message === "path is required" || message === "path is invalid") {
      return errorResponse(400, message);
    }
    console.error("Failed to serve workspace file:", error);
    return errorResponse(500, "Internal server error");
  }
});

http.route({
  path: "/api/fs/file",
  method: "GET",
  handler: serveWorkspaceFile,
});

export default http;
