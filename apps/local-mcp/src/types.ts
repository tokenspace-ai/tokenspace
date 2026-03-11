import type { BuildWorkspaceResult } from "@tokenspace/compiler";
import type { IFileSystem } from "just-bash";

export type LocalSystemContentFile = {
  path: string;
  content: string;
};

export type LocalBuildOrigin = "fresh-build" | "cache-hit";

export type LocalSessionManifest = {
  version: 2;
  sessionId: string;
  createdAt: string;
  workspaceName: string;
  workspaceDir: string;
  sessionRoot: string;
  buildDir: string;
  sandboxDir: string;
  logsDir: string;
  bundlePath: string;
  buildManifestPath: string;
  sourceFingerprint: string;
  buildOrigin: LocalBuildOrigin;
};

export type LocalSession = {
  manifest: LocalSessionManifest;
  sessionRoot: string;
  buildDir: string;
  sandboxDir: string;
  logsDir: string;
  bundlePath: string;
  buildManifestPath: string;
  fileSystem: IFileSystem;
  buildResult: BuildWorkspaceResult;
};

export type CreateLocalSessionOptions = {
  workspaceDir: string;
  sessionsRootDir?: string;
  buildCacheDir?: string;
  systemDir?: string;
};
