import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";

type WorkspaceFileUrlArgs =
  | {
      path: string;
      revisionId: Id<"revisions">;
      sessionId?: null | undefined;
    }
  | {
      path: string;
      sessionId: Id<"sessions">;
      revisionId?: Id<"revisions"> | null | undefined;
    };

export function buildWorkspaceFileUrl(args: WorkspaceFileUrlArgs): string {
  const baseUrl = resolveWorkspaceFileBaseUrl();
  const url = new URL("/api/fs/file", baseUrl);
  url.searchParams.set("path", args.path);
  if ("sessionId" in args && args.sessionId) {
    url.searchParams.set("sessionId", args.sessionId);
    return url.toString();
  }
  const revisionId = args.revisionId;
  if (!revisionId) {
    throw new Error("revisionId is required");
  }
  url.searchParams.set("revisionId", revisionId);
  return url.toString();
}

function resolveWorkspaceFileBaseUrl(): string {
  const configuredSiteUrl = import.meta.env.VITE_CONVEX_SITE_URL?.trim();
  if (configuredSiteUrl) {
    return configuredSiteUrl;
  }

  const convexUrl = import.meta.env.VITE_CONVEX_URL?.trim();
  if (!convexUrl) {
    throw new Error("VITE_CONVEX_URL is not configured");
  }

  const parsed = new URL(convexUrl);
  if (parsed.hostname.endsWith(".convex.cloud")) {
    parsed.hostname = `${parsed.hostname.slice(0, -".convex.cloud".length)}.convex.site`;
    return parsed.toString();
  }

  if ((parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") && parsed.port) {
    parsed.port = String(Number(parsed.port) + 1);
    return parsed.toString();
  }

  throw new Error("VITE_CONVEX_SITE_URL is not configured");
}
