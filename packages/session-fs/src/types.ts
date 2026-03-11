/**
 * Type definitions for Convex overlay filesystem
 */

import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import type { ConvexClient } from "convex/browser";

// Re-export ConvexClient for convenience
export type { ConvexClient };

// Re-export Id for convenience
export type { Id };

/**
 * Response from readFile query
 */
export interface ReadFileResponse {
  content?: string;
  downloadUrl?: string;
  binary: boolean;
}

/**
 * Response from fileStat query
 */
export interface FileStatResponse {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
}

/**
 * Directory entry from listDirectory query
 */
export interface DirectoryEntry {
  name: string;
  type: "file" | "directory";
}

/**
 * Options for creating a ConvexFs instance
 */
export interface ConvexFsOptions {
  /**
   * Convex client instance for making queries/mutations
   */
  client: ConvexClient;

  /**
   * Session ID for overlay filesystem access
   */
  sessionId: string;

  /**
   * Whether to allow write operations (default: true)
   */
  allowWrites?: boolean;
}
