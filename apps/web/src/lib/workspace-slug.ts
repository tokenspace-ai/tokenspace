/**
 * Utilities for parsing and building workspace-scoped URL slugs.
 *
 * URL format: /workspace/{slug}/chat/{threadId}
 *
 * Slug formats:
 * - "playground" -> workspace only (published runtime or main admin branch state)
 * - "playground:dev" -> workspace + specific branch state
 * - "playground:main:c0ff33" -> legacy admin URL with working state hash
 */

export type WorkspaceSlugContext = {
  workspaceSlug: string;
  branchName: string;
  revisionId: string | undefined;
};

export function getInvalidWorkspaceSlugReason(slug: string): string | null {
  if (slug.includes(":")) {
    return "Workspace slugs cannot contain ':'. Reserved delimiters ':' and '@' are used for branch and revision URLs.";
  }
  if (slug.includes("@")) {
    return "Workspace slugs cannot contain '@'. Reserved delimiters ':' and '@' are used for branch and revision URLs.";
  }
  return null;
}

export function getInvalidBranchNameReason(branchName: string): string | null {
  if (branchName.includes(":")) {
    return "Branch names cannot contain ':'. Reserved delimiters ':' and '@' are used for branch and revision URLs.";
  }
  if (branchName.includes("@")) {
    return "Branch names cannot contain '@'. Reserved delimiters ':' and '@' are used for branch and revision URLs.";
  }
  return null;
}

/**
 * Parse a workspace slug from the URL into its components.
 *
 * @param slug - The slug from the URL (e.g., "playground", "playground:dev", "playground:main:c0ff33")
 * @returns The parsed components
 */
export function parseWorkspaceSlug(slug: string): WorkspaceSlugContext {
  const [contextSlug, revisionId] = slug.split("@");
  const parts = (contextSlug ?? "").split(":");
  return {
    workspaceSlug: parts[0] ?? "",
    branchName: parts[1] ?? "main",
    revisionId: revisionId || undefined,
  };
}

/**
 * Build a workspace slug string from its components.
 *
 * @param workspace - The workspace slug
 * @param branch - The branch state name (omit or pass "main" for default)
 * @returns The combined slug string
 */
export function buildWorkspaceSlug(workspace: string, branch?: string, revisionId?: string): string {
  if (revisionId) return `${workspace}@${revisionId}`;
  if (branch && branch !== "main") return `${workspace}:${branch}`;
  return workspace;
}

export function normalizeMemberWorkspaceSlug(slug: string): string {
  const { workspaceSlug, revisionId } = parseWorkspaceSlug(slug);
  return buildWorkspaceSlug(workspaceSlug, undefined, revisionId);
}

/**
 * Check if a slug specifies a non-default branch.
 */
export function hasCustomBranch(slug: string): boolean {
  return parseWorkspaceSlug(slug).branchName !== "main";
}

/**
 * Replace the workspace slug segment in a workspace URL pathname.
 * Example: /workspace/a:main:123/admin/models -> /workspace/b:dev/admin/models
 */
export function replaceWorkspaceSlugInPath(pathname: string, nextSlug: string): string {
  const match = pathname.match(/^\/workspace\/[^/]+(\/.*)?$/);
  if (!match) return pathname;
  const suffix = match[1] ?? "";
  return `/workspace/${nextSlug}${suffix}`;
}
