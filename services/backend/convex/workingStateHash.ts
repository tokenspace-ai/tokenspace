export type WorkingStateChange = {
  path: string;
  content?: string;
  blobId?: string;
  downloadUrl?: string;
  isDeleted: boolean;
};

/**
 * Compute a deterministic hash of working changes.
 * Keep this in sync with revision compilation dedupe semantics.
 */
export function computeWorkingStateHash(changes: WorkingStateChange[]): string {
  const sorted = [...changes].sort((a, b) => a.path.localeCompare(b.path));
  const data = sorted
    .map((change) => {
      const payload = change.isDeleted ? "D" : (change.content ?? change.blobId ?? change.downloadUrl ?? "");
      return `${change.path}:${payload}`;
    })
    .join("|");

  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}
