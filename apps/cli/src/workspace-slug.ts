const RESERVED_WORKSPACE_SLUG_DELIMITERS = [":", "@"] as const;

export function getInvalidWorkspaceSlugReason(slug: string): string | null {
  const invalidDelimiter = RESERVED_WORKSPACE_SLUG_DELIMITERS.find((delimiter) => slug.includes(delimiter));
  if (!invalidDelimiter) {
    return null;
  }

  return `Workspace slugs cannot contain '${invalidDelimiter}'. Reserved delimiters ':' and '@' are used for branch and revision URLs.`;
}

export function assertValidWorkspaceSlug(slug: string): void {
  const reason = getInvalidWorkspaceSlugReason(slug);
  if (reason) {
    throw new Error(reason);
  }
}
