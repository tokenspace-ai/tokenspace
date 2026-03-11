/**
 * @tokenspace/session-fs - Convex-backed overlay filesystem for just-bash
 *
 * Provides an IFileSystem implementation backed by Convex session overlay,
 * enabling lazy-loading filesystem access for AI agents.
 */

export { ConvexSessionFs as ConvexFs } from "./convex-fs";
export type {
  ConvexClient,
  ConvexFsOptions,
  DirectoryEntry,
  FileStatResponse,
  Id,
  ReadFileResponse,
} from "./types";
