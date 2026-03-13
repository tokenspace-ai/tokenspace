/** Sleep for a given number of milliseconds */
declare function sleep(ms: number): Promise<void>;

/** Capture debug output for debugging. Can be accessed by users and agents only if debugging is enabled for the given job */
declare function debug(message: string, ...args: any[]): void;

/** Whether debug output is enabled for the current job */
declare const DEBUG_ENABLED: boolean;

export type BashOptions = {
  /**
   * Working directory relative to `/sandbox` (e.g. `"foo/bar"` -> `/sandbox/foo/bar`).
   * Defaults to `/sandbox`.
   */
  cwd?: string;
  /** Maximum allowed execution time in milliseconds */
  timeoutMs?: number;
};

/** Execute a bash script/command in the sandbox (backed by just-bash). */
declare function bash(command: string, options?: BashOptions): Promise<string>;

export type JSONValue = string | boolean | number | null | { [key: string]: JSONValue } | JSONValue[];

export interface TokenspaceSession {
  readonly id: string;
  /**
   * Store a small JSON-serializable value scoped to this session.
   * Intended for lightweight state across agent tool calls within the same session.
   */
  setSessionVariable(name: string, value: JSONValue): Promise<void>;
  /**
   * Retrieve a session-scoped variable previously set via `setSessionVariable`.
   */
  getSessionVariable(name: string): Promise<JSONValue | undefined>;
  /**
   * Write an artifact (text or binary) scoped to this session.
   * Artifacts are intended for larger outputs that may be read by subsequent tool calls.
   */
  writeArtifact(name: string, body: ArrayBuffer | string): Promise<void>;
  /**
   * List artifact names previously written via `writeArtifact`.
   */
  listArtifacts(): Promise<string[]>;
  /**
   * Read an artifact previously written via `writeArtifact`.
   */
  readArtifact(name: string): Promise<ArrayBuffer>;
  /**
   * Read an artifact as UTF-8 text.
   */
  readArtifactText(name: string): Promise<string>;
}

declare const session: TokenspaceSession;

export interface TokenspaceFilesystem {
  /** List direct children (files/dirs) of a directory path. */
  list(path: string): Promise<string[]>;
  /** Get basic metadata for a path. */
  stat(path: string): Promise<{
    isDirectory: boolean;
    isFile: boolean;
    size: number;
  }>;
  /** Read a file as raw bytes. */
  read(path: string): Promise<ArrayBuffer>;
  /** Read a file as UTF-8 text. */
  readText(path: string): Promise<string>;
  /** Write a file (creates parent directories as needed). */
  write(path: string, content: ArrayBuffer | string): Promise<void>;
  /** Delete a file or directory (recursively for directories). */
  delete(path: string): Promise<void>;
}

declare const fs: TokenspaceFilesystem;

// @tokenspace-builtins-server-only:start
export type TokenspaceUserInfo = {
  id: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  profilePictureUrl?: string | null;
};

export type UserLookup = { id: string; email?: never } | { email: string; id?: never };

export interface TokenspaceUsers {
  getCurrentUserInfo(): Promise<TokenspaceUserInfo>;
  getInfo(args: UserLookup): Promise<TokenspaceUserInfo | null>;
}

declare const users: TokenspaceUsers;
// @tokenspace-builtins-server-only:end

declare class TokenspaceError extends Error {
  constructor(message: string, cause?: Error, details?: string, data?: Record<string, unknown>);
  readonly cause?: Error;
  readonly details?: string;
  readonly data?: Record<string, unknown>;
}

declare type ApprovalRequirement = {
  action: string;
  data?: Record<string, any>;
  info?: Record<string, any>;
  description?: string;
};

declare class ApprovalRequiredError extends TokenspaceError {
  constructor(req: ApprovalRequirement | ApprovalRequirement[]);
  readonly requirements: ApprovalRequirement[];
}

declare function isApprovalRequest(error: Error | unknown): error is ApprovalRequiredError;
