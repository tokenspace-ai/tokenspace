/**
 * Filesystem module - unified API for workspace filesystem operations
 *
 * This module provides a layered filesystem abstraction:
 * - revision: Base revision files (materialized from revisions)
 * - overlay: Session-scoped copy-on-write overlay
 * - working: Working directory for uncommitted changes
 * - operations: High-level file operations (listFiles, readFile, writeFile, glob, grep)
 */

import type { Doc } from "../_generated/dataModel";

// ============================================================================
// Shared Types
// ============================================================================

export type RevisionFile = {
  _id: string;
  revisionId: string;
  name: string;
  parent?: string;
  content?: string;
  blobId?: string;
  downloadUrl?: string;
  binary: boolean;
};

export type OverlayFile = {
  name: string;
  parent?: string;
  content?: string;
  blobId?: string;
  downloadUrl?: string;
  binary: boolean;
  isDeleted: boolean;
  isFromOverlay: boolean; // true if this came from overlay, false if from base
};

export type WorkingFile = Doc<"workingFiles">;

// ============================================================================
// Path Utilities
// ============================================================================

/**
 * Parse a file path into parent directory and name components.
 * @example parsePath("capabilities/github/capability.ts") => { parent: "capabilities/github", name: "capability.ts" }
 * @example parsePath("TOKENSPACE.md") => { parent: undefined, name: "TOKENSPACE.md" }
 */
export function parsePath(path: string): { parent: string | undefined; name: string } {
  const parts = path.split("/");
  return { parent: parts.slice(0, -1).join("/") || undefined, name: parts[parts.length - 1]! };
}

/**
 * Normalize a revision filesystem path by removing leading slashes and root mount prefixes.
 * @example normalizePath("/sandbox/capabilities/github") => "capabilities/github"
 * @example normalizePath("sandbox/file.ts") => "file.ts"
 * @example normalizePath("/revision/docs/readme.md") => "docs/readme.md"
 */
export function normalizePath(path: string): string {
  const stripped = path.startsWith("/") ? path.slice(1) : path;
  if (stripped.startsWith("sandbox/")) return stripped.slice("sandbox/".length);
  if (stripped.startsWith("revision/")) return stripped.slice("revision/".length);
  return stripped;
}

// ============================================================================
// Re-exports
// ============================================================================

// Note: We don't re-export submodules here because operations.ts uses "use node"
// and cannot be re-exported from a non-Node.js module.
// Import directly from submodules instead:
// - import { ... } from "./fs/revision"
// - import { ... } from "./fs/overlay"
// - import { ... } from "./fs/working"
// - import { ... } from "./fs/operations"
