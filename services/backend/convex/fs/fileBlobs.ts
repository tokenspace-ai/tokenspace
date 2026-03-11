import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

export const INLINE_CONTENT_MAX_CHARS = 32_768;

export function shouldInlineContent(content: string, binary: boolean): boolean {
  if (binary) return false;
  return content.length <= INLINE_CONTENT_MAX_CHARS;
}

export async function storeFileContent(
  ctx: any,
  args: { workspaceId: Id<"workspaces">; content: string; binary: boolean },
): Promise<{ content?: string; blobId?: Id<"blobs"> }> {
  if (shouldInlineContent(args.content, args.binary)) {
    return { content: args.content };
  }

  const blobId: Id<"blobs"> = await ctx.runAction(internal.content.getOrCreateBlob, {
    workspaceId: args.workspaceId,
    content: args.content,
    binary: args.binary,
  });

  return { blobId };
}

export async function resolveInlineContent(entry: { content?: string }): Promise<string | undefined> {
  return entry.content;
}

export async function resolveFileDownloadUrl(ctx: any, entry: { blobId?: Id<"blobs"> }): Promise<string | undefined> {
  if (!entry.blobId) {
    return undefined;
  }

  const blob = ctx.db
    ? await ctx.db.get(entry.blobId)
    : await ctx.runQuery(internal.content.getBlob, { blobId: entry.blobId });
  if (!blob?.storageId) {
    return undefined;
  }

  return await ctx.storage.getUrl(blob.storageId);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export async function loadFileContent(
  ctx: any,
  entry: { content?: string; blobId?: Id<"blobs"> },
  options: { binary: boolean },
): Promise<string | undefined> {
  if (entry.content !== undefined) {
    return entry.content;
  }

  if (!entry.blobId) {
    return undefined;
  }

  // Handle both query/mutation context (ctx.db) and action context (ctx.runQuery)
  const blob = ctx.db
    ? await ctx.db.get(entry.blobId)
    : await ctx.runQuery(internal.content.getBlob, { blobId: entry.blobId });
  if (!blob?.storageId) {
    return undefined;
  }

  const stored = await ctx.storage.get(blob.storageId);
  if (!stored) {
    return undefined;
  }

  if (options.binary) {
    const buffer = new Uint8Array(await stored.arrayBuffer());
    return bytesToBase64(buffer);
  }

  return await stored.text();
}

export async function resolveFileSize(ctx: any, entry: { content?: string; blobId?: Id<"blobs"> }): Promise<number> {
  if (entry.content !== undefined) {
    return entry.content.length;
  }

  if (!entry.blobId) {
    return 0;
  }

  // Handle both query/mutation context (ctx.db) and action context (ctx.runQuery)
  const blob = ctx.db
    ? await ctx.db.get(entry.blobId)
    : await ctx.runQuery(internal.content.getBlob, { blobId: entry.blobId });
  return blob?.size ?? 0;
}
