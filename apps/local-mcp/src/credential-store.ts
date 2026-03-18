import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { CredentialRequirementSummary } from "@tokenspace/compiler";
import type { CredentialDef, CredentialStore } from "@tokenspace/sdk";
import { MissingCredentialError, TokenspaceError } from "@tokenspace/sdk";
import type { LocalSession } from "./types";

type LocalCredentialSummaryBase = {
  id: string;
  label?: string;
  group?: string;
  description?: string;
  iconPath?: string;
  iconUrl?: string;
  kind: CredentialRequirementSummary["kind"];
  scope: CredentialRequirementSummary["scope"];
  optional: boolean;
};

export type LocalSecretCredentialSummary = LocalCredentialSummaryBase & {
  kind: "secret";
  configured: boolean;
  status: "configured" | "missing";
  placeholder?: string;
  effectiveScope: "workspace";
  supported: true;
  localScopeNote?: string;
};

export type LocalEnvCredentialSummary = LocalCredentialSummaryBase & {
  kind: "env";
  configured: boolean;
  status: "configured" | "missing";
  variableName: string;
  supported: true;
  overridden: boolean;
};

export type LocalOAuthCredentialSummary = LocalCredentialSummaryBase & {
  kind: "oauth";
  configured: boolean;
  status: "configured" | "unsupported";
  supported: boolean;
  unsupportedReason: string;
  overridden: boolean;
};

export type LocalCredentialSummary =
  | LocalSecretCredentialSummary
  | LocalEnvCredentialSummary
  | LocalOAuthCredentialSummary;

export class LocalCredentialConfigurationError extends TokenspaceError {
  constructor(message: string, data?: Record<string, unknown>) {
    super(message, undefined, undefined, {
      errorType: "CREDENTIAL_CONFIGURATION_ERROR",
      ...(data ?? {}),
    });
    this.name = "LocalCredentialConfigurationError";
  }
}

export class LocalCredentialBackendError extends TokenspaceError {
  constructor(message: string, data?: Record<string, unknown>, _cause?: unknown) {
    super(message, undefined, undefined, {
      errorType: "CREDENTIAL_BACKEND_ERROR",
      ...(data ?? {}),
    });
    this.name = "LocalCredentialBackendError";
  }
}

export type LocalCredentialManager = CredentialStore & {
  listCredentials: () => Promise<LocalCredentialSummary[]>;
  setSecret: (credentialId: string, value: string) => Promise<void>;
  deleteSecret: (credentialId: string) => Promise<void>;
};

export type LocalSecretsStore = {
  get: (address: { service: string; name: string }) => Promise<string | null>;
  set: (entry: { service: string; name: string; value: string }) => Promise<void>;
  delete: (address: { service: string; name: string }) => Promise<boolean>;
};

type CreateLocalCredentialManagerOptions = {
  secretsStore?: LocalSecretsStore;
};

const OAUTH_UNSUPPORTED_REASON = "OAuth credentials are not supported in local MCP yet.";
const LOCAL_MCP_SECRETS_DIR = path.join(homedir(), ".tokenspace", "local-mcp", "secrets");
const fileMutationLocks = new Map<string, Promise<void>>();
const bunSecretsStore: LocalSecretsStore = {
  get: async (address) => await Bun.secrets.get(address),
  set: async (entry) => await Bun.secrets.set(entry),
  delete: async (address) => await Bun.secrets.delete(address),
};
const defaultSecretsStore = createFallbackLocalSecretsStore(bunSecretsStore, createLocalFileSecretsStore());

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function shouldFallbackFromPrimarySecretsStore(error: unknown): boolean {
  if (isErrnoException(error) && error.code === "ENOSYS") {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /dbus|d-bus|secret service|org\.freedesktop\.secrets|keyring|keychain|credential store|not supported|libsecret/i.test(
    message,
  );
}

function secretsFilePath(baseDir: string, service: string): string {
  return path.join(baseDir, `${encodeURIComponent(service)}.json`);
}

async function readSecretsFile(filePath: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        entries[key] = value;
      }
    }
    return entries;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeSecretsFile(filePath: string, entries: Record<string, string>): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(entries, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tempPath, filePath);
}

async function withFileMutationLock<T>(filePath: string, run: () => Promise<T>): Promise<T> {
  const previous = fileMutationLocks.get(filePath) ?? Promise.resolve();
  let releaseCurrent: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  fileMutationLocks.set(filePath, queued);

  await previous.catch(() => undefined);

  try {
    return await run();
  } finally {
    releaseCurrent();
    if (fileMutationLocks.get(filePath) === queued) {
      fileMutationLocks.delete(filePath);
    }
  }
}

export function createLocalFileSecretsStore(baseDir: string = LOCAL_MCP_SECRETS_DIR): LocalSecretsStore {
  return {
    async get({ service, name }) {
      const entries = await readSecretsFile(secretsFilePath(baseDir, service));
      return entries[name] ?? null;
    },

    async set({ service, name, value }) {
      const filePath = secretsFilePath(baseDir, service);
      await withFileMutationLock(filePath, async () => {
        const entries = await readSecretsFile(filePath);
        entries[name] = value;
        await writeSecretsFile(filePath, entries);
      });
    },

    async delete({ service, name }) {
      const filePath = secretsFilePath(baseDir, service);
      return await withFileMutationLock(filePath, async () => {
        const entries = await readSecretsFile(filePath);
        const existed = Object.hasOwn(entries, name);
        if (!existed) {
          return false;
        }

        delete entries[name];
        if (Object.keys(entries).length === 0) {
          await rm(filePath, { force: true });
          return true;
        }

        await writeSecretsFile(filePath, entries);
        return true;
      });
    },
  };
}

export function createFallbackLocalSecretsStore(
  primaryStore: LocalSecretsStore,
  fallbackStore: LocalSecretsStore,
): LocalSecretsStore {
  let primaryUnavailable = false;

  async function withFallback<T>(runPrimary: () => Promise<T>, runFallback: () => Promise<T>): Promise<T> {
    if (primaryUnavailable) {
      return await runFallback();
    }

    try {
      return await runPrimary();
    } catch (error) {
      if (!shouldFallbackFromPrimarySecretsStore(error)) {
        throw error;
      }
      primaryUnavailable = true;
      return await runFallback();
    }
  }

  return {
    get: async (address) =>
      await withFallback(
        () => primaryStore.get(address),
        () => fallbackStore.get(address),
      ),
    set: async (entry) =>
      await withFallback(
        () => primaryStore.set(entry),
        () => fallbackStore.set(entry),
      ),
    delete: async (address) =>
      await withFallback(
        () => primaryStore.delete(address),
        () => fallbackStore.delete(address),
      ),
  };
}

function getEnvVariableName(requirement: CredentialRequirementSummary): string {
  return typeof requirement.config?.variableName === "string" ? requirement.config.variableName : requirement.id;
}

function localScopeNote(requirement: CredentialRequirementSummary): string | undefined {
  if (requirement.kind !== "secret" || requirement.scope === "workspace") {
    return undefined;
  }
  return `Local MCP stores this ${requirement.scope}-scoped secret as a workspace-local value.`;
}

function describeMissingSecret(requirement: CredentialRequirementSummary): string {
  const scopeHint =
    requirement.scope === "workspace"
      ? "Configure it in the local control UI."
      : `Configure it in the local control UI. Local MCP treats ${requirement.scope}-scoped secrets as workspace-local values.`;
  return `Credential "${requirement.id}" is not configured in local MCP yet. ${scopeHint}`;
}

function describeMissingEnv(requirement: CredentialRequirementSummary): string {
  return `Environment variable "${getEnvVariableName(requirement)}" is not set for this local MCP process.`;
}

function describeUnsupportedOAuth(requirement: CredentialRequirementSummary): string {
  return `Credential "${requirement.id}" requires OAuth, which local MCP does not support yet.`;
}

function toCredentialDef(requirement: CredentialRequirementSummary): CredentialDef {
  if (requirement.kind === "secret") {
    return {
      id: requirement.id,
      label: requirement.label,
      group: requirement.group,
      description: requirement.description,
      scope: requirement.scope,
      kind: "secret",
      placeholder: requirement.placeholder,
      optional: requirement.optional,
      fallback: requirement.fallback as CredentialDef["fallback"],
    };
  }

  if (requirement.kind === "env") {
    return {
      id: requirement.id,
      label: requirement.label,
      group: requirement.group,
      description: requirement.description,
      scope: requirement.scope,
      kind: "env",
      variableName: getEnvVariableName(requirement),
      optional: requirement.optional,
      fallback: requirement.fallback as CredentialDef["fallback"],
    };
  }

  return {
    id: requirement.id,
    label: requirement.label,
    group: requirement.group,
    description: requirement.description,
    scope: requirement.scope,
    kind: "oauth",
    grantType:
      requirement.config?.grantType === "authorization_code" ||
      requirement.config?.grantType === "client_credentials" ||
      requirement.config?.grantType === "implicit"
        ? requirement.config.grantType
        : "authorization_code",
    clientId: typeof requirement.config?.clientId === "string" ? requirement.config.clientId : "",
    clientSecret: typeof requirement.config?.clientSecret === "string" ? requirement.config.clientSecret : "",
    authorizeUrl: typeof requirement.config?.authorizeUrl === "string" ? requirement.config.authorizeUrl : "",
    tokenUrl: typeof requirement.config?.tokenUrl === "string" ? requirement.config.tokenUrl : "",
    scopes: Array.isArray(requirement.config?.scopes)
      ? requirement.config.scopes.filter((entry): entry is string => typeof entry === "string")
      : [],
    optional: requirement.optional,
    fallback: requirement.fallback as CredentialDef["fallback"],
  };
}

function secretStorageAddress(workspaceDir: string, credentialId: string): { service: string; name: string } {
  const workspaceHash = createHash("sha256").update(workspaceDir).digest("hex");
  return {
    service: `tokenspace.local-mcp.v1.${workspaceHash}`,
    name: credentialId,
  };
}

function encodeUtf8ToBase64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function resolveCredentialIconUrl(
  revisionFiles: LocalSession["buildResult"]["revisionFs"]["files"],
  iconPath: string | undefined,
): string | undefined {
  if (!iconPath) {
    return undefined;
  }

  const iconFile = revisionFiles.find((file) => file.path === iconPath);
  if (!iconFile) {
    return undefined;
  }

  const ext = path.extname(iconPath).toLowerCase();
  if (ext === ".svg" && !iconFile.binary) {
    return `data:image/svg+xml;base64,${encodeUtf8ToBase64(iconFile.content)}`;
  }
  if (ext === ".png") {
    return `data:image/png;base64,${iconFile.content}`;
  }
  return undefined;
}

function sortCredentials(left: CredentialRequirementSummary, right: CredentialRequirementSummary): number {
  const leftGroup = left.group ?? "Other";
  const rightGroup = right.group ?? "Other";
  const byGroup = leftGroup.localeCompare(rightGroup);
  if (byGroup !== 0) return byGroup;
  const leftName = left.label ?? left.id;
  const rightName = right.label ?? right.id;
  const byName = leftName.localeCompare(rightName);
  if (byName !== 0) return byName;
  return left.id.localeCompare(right.id);
}

function backendErrorDetails(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  return undefined;
}

export function createLocalCredentialManager(
  session: LocalSession,
  options?: CreateLocalCredentialManagerOptions,
): LocalCredentialManager {
  const requirements = [...session.buildResult.metadata.credentialRequirements].sort(sortCredentials);
  const requirementsById = new Map(requirements.map((entry) => [entry.id, entry]));
  const revisionFiles = session.buildResult.revisionFs?.files ?? [];
  const iconUrlByCredentialId = new Map(
    requirements.map((entry) => [entry.id, resolveCredentialIconUrl(revisionFiles, entry.iconPath)]),
  );
  const workspaceDir = session.manifest.workspaceDir;
  const secretsStore = options?.secretsStore ?? defaultSecretsStore;

  function requireCredentialRequirement(credentialId: string): CredentialRequirementSummary {
    const requirement = requirementsById.get(credentialId);
    if (!requirement) {
      throw new TokenspaceError(
        `Credential "${credentialId}" is not declared in workspace metadata`,
        undefined,
        "The local MCP bundle and credential metadata are out of sync.",
        {
          errorType: "CREDENTIAL_NOT_DECLARED",
          credentialId,
        },
      );
    }
    return requirement;
  }

  function wrapSecretBackendError(
    operation: "read" | "write" | "delete",
    requirement: CredentialRequirementSummary,
    error: unknown,
  ): LocalCredentialBackendError {
    const action = operation === "read" ? "read" : operation === "write" ? "store" : "delete";
    return new LocalCredentialBackendError(
      `Local MCP could not ${action} credential "${requirement.id}" because the secret storage backend failed.`,
      {
        credentialId: requirement.id,
        credentialScope: requirement.scope,
        operation,
        details: backendErrorDetails(error),
      },
      error,
    );
  }

  async function readSecret(requirement: CredentialRequirementSummary): Promise<string | undefined> {
    try {
      const value = await secretsStore.get(secretStorageAddress(workspaceDir, requirement.id));
      return typeof value === "string" ? value : undefined;
    } catch (error) {
      throw wrapSecretBackendError("read", requirement, error);
    }
  }

  function summarizeCredential(requirement: CredentialRequirementSummary): LocalCredentialSummary {
    if (requirement.kind === "secret") {
      const configured = false;
      return {
        id: requirement.id,
        label: requirement.label,
        group: requirement.group,
        description: requirement.description,
        iconPath: requirement.iconPath,
        iconUrl: iconUrlByCredentialId.get(requirement.id),
        kind: "secret",
        scope: requirement.scope,
        optional: requirement.optional === true,
        configured,
        status: configured ? "configured" : "missing",
        placeholder: requirement.placeholder,
        effectiveScope: "workspace",
        supported: true,
        localScopeNote: localScopeNote(requirement),
      };
    }

    if (requirement.kind === "env") {
      const configured = process.env[getEnvVariableName(requirement)] !== undefined;
      return {
        id: requirement.id,
        label: requirement.label,
        group: requirement.group,
        description: requirement.description,
        iconPath: requirement.iconPath,
        iconUrl: iconUrlByCredentialId.get(requirement.id),
        kind: "env",
        scope: requirement.scope,
        optional: requirement.optional === true,
        configured,
        status: configured ? "configured" : "missing",
        variableName: getEnvVariableName(requirement),
        supported: true,
        overridden: false,
      };
    }

    return {
      id: requirement.id,
      label: requirement.label,
      group: requirement.group,
      description: requirement.description,
      iconPath: requirement.iconPath,
      iconUrl: iconUrlByCredentialId.get(requirement.id),
      kind: "oauth",
      scope: requirement.scope,
      optional: requirement.optional === true,
      configured: false,
      status: "unsupported",
      supported: false,
      unsupportedReason: OAUTH_UNSUPPORTED_REASON,
      overridden: false,
    };
  }

  return {
    load: (async (credentialId) => {
      const requirement = requireCredentialRequirement(String(credentialId));

      if (requirement.kind === "secret") {
        const value = await readSecret(requirement);
        if (value !== undefined) {
          return value as never;
        }
        if (requirement.optional === true) {
          return undefined as never;
        }
        throw new MissingCredentialError(toCredentialDef(requirement), "missing", describeMissingSecret(requirement));
      }

      if (requirement.kind === "env") {
        const override = await readSecret(requirement);
        if (override !== undefined) {
          return override as never;
        }
        const value = process.env[getEnvVariableName(requirement)];
        if (value !== undefined) {
          return value as never;
        }
        if (requirement.optional === true) {
          return undefined as never;
        }
        throw new MissingCredentialError(toCredentialDef(requirement), "missing", describeMissingEnv(requirement));
      }

      {
        const override = await readSecret(requirement);
        if (override !== undefined) {
          return override as never;
        }
      }

      if (requirement.optional === true) {
        return undefined as never;
      }

      throw new MissingCredentialError(
        toCredentialDef(requirement),
        "non_interactive",
        `${describeUnsupportedOAuth(requirement)} ${OAUTH_UNSUPPORTED_REASON}`,
      );
    }) as CredentialStore["load"],

    async listCredentials() {
      return await Promise.all(
        requirements.map(async (requirement) => {
          const hasStoredOverride = (await readSecret(requirement)) !== undefined;

          if (requirement.kind === "secret") {
            return {
              ...summarizeCredential(requirement),
              configured: hasStoredOverride,
              status: hasStoredOverride ? "configured" : "missing",
            } as LocalSecretCredentialSummary;
          }

          if (requirement.kind === "env") {
            const envConfigured = process.env[getEnvVariableName(requirement)] !== undefined;
            const configured = hasStoredOverride || envConfigured;
            return {
              ...summarizeCredential(requirement),
              configured,
              overridden: hasStoredOverride,
              status: configured ? "configured" : "missing",
            } as LocalEnvCredentialSummary;
          }

          return {
            ...summarizeCredential(requirement),
            configured: hasStoredOverride,
            overridden: hasStoredOverride,
            status: hasStoredOverride ? "configured" : "unsupported",
            supported: !!hasStoredOverride,
          } as LocalOAuthCredentialSummary;
        }),
      );
    },

    async setSecret(credentialId, value) {
      const requirement = requireCredentialRequirement(credentialId);

      if (value.length === 0) {
        throw new LocalCredentialConfigurationError("Secret value must not be empty.", {
          credentialId,
        });
      }

      try {
        await secretsStore.set({
          ...secretStorageAddress(workspaceDir, credentialId),
          value,
        });
      } catch (error) {
        throw wrapSecretBackendError("write", requirement, error);
      }
    },

    async deleteSecret(credentialId) {
      const requirement = requireCredentialRequirement(credentialId);

      try {
        await secretsStore.delete(secretStorageAddress(workspaceDir, credentialId));
      } catch (error) {
        throw wrapSecretBackendError("delete", requirement, error);
      }
    },
  };
}

export function createLocalCredentialStore(session: LocalSession): CredentialStore {
  return createLocalCredentialManager(session);
}
