import { TokenspaceError } from "./error";
import { getCredentialStore, setFallbackCredentialStore } from "./runtime-context";

export type CredentialId = string & { _brand: "CredentialId" };

export type CredentialDef = {
  // a credential id that is unique within the workspace
  id: string;
  label?: string;
  group?: string;
  description?: string;
  scope: "workspace" | "session" | "user";
  optional?: boolean;
  // Forward-compatibility field. Runtime fallback behavior is intentionally not implemented yet.
  fallback?: CredentialId;
} & (
  | { kind: "secret"; placeholder?: string }
  | { kind: "env"; variableName: string; decryptionKey?: CredentialId }
  | {
      kind: "oauth";
      grantType: "authorization_code" | "client_credentials" | "implicit";
      clientId: string;
      clientSecret: string;
      authorizeUrl: string;
      tokenUrl: string;
      scopes: string[];
    }
);

export type SecretCredentialDef = CredentialDef & { kind: "secret" };
export type EnvCredentialDef = CredentialDef & { kind: "env" };
export type OAuthCredentialDef = CredentialDef & { kind: "oauth" };

/** Define a simple secret value. The value will be encrypted and stored in the secret store */
export function secret(def: {
  id: string;
  label?: string;
  group?: string;
  description?: string;
  placeholder?: string;
  scope: "workspace" | "session" | "user";
  optional?: boolean;
  // Forward-compatibility field. Stored in the definition but ignored by runtime resolution for now.
  fallback?: CredentialId;
}): SecretCredentialDef {
  return {
    id: def.id,
    label: def.label,
    group: def.group,
    description: def.description,
    placeholder: def.placeholder,
    scope: def.scope,
    kind: "secret",
    optional: def.optional,
    fallback: def.fallback,
  };
}

/**
 * Define a secret value that will be obtained from environment variables of the execution environment.
 * Important: This will only work with self-hosted executors, where environment variables can be set.
 */
export function env<O extends boolean>(def: {
  id: string;
  label?: string;
  group?: string;
  variableName: string;
  description?: string;
  optional?: O;
  decryptionKey?: CredentialId;
  // Forward-compatibility field. Stored in the definition but ignored by runtime resolution for now.
  fallback?: CredentialId;
}): EnvCredentialDef {
  return {
    id: def.id,
    label: def.label,
    group: def.group,
    variableName: def.variableName,
    description: def.description,
    scope: "workspace",
    kind: "env",
    optional: def.optional,
    decryptionKey: def.decryptionKey,
    fallback: def.fallback,
  };
}

/**
 * Define an OAuth credential. The credential will be obtained from the OAuth provider.
 * Depending on the grant type, this will happen interactively:
 * - scope = user: the user interacting with the app will be prompted to log in
 * - scope = session: someone will be prompted to log in on behalf of the session
 * - scope = workspace: the oauth authorization will be performed ahead of time
 */
export function oauth(def: {
  id: string;
  label?: string;
  group?: string;
  description?: string;
  scope: "workspace" | "session" | "user";
  optional?: boolean;
  // Forward-compatibility field. Stored in the definition but ignored by runtime resolution for now.
  fallback?: CredentialId;
  config: {
    grantType: "authorization_code" | "client_credentials" | "implicit";
    clientId: CredentialId | string;
    clientSecret: CredentialId | string;
    authorizeUrl: string;
    tokenUrl: string;
    scopes: string[];
  };
}): OAuthCredentialDef {
  return {
    id: def.id,
    label: def.label,
    group: def.group,
    description: def.description,
    scope: def.scope,
    kind: "oauth",
    grantType: def.config.grantType,
    clientId: def.config.clientId,
    clientSecret: def.config.clientSecret,
    authorizeUrl: def.config.authorizeUrl,
    tokenUrl: def.config.tokenUrl,
    scopes: def.config.scopes,
    optional: def.optional,
    fallback: def.fallback,
  };
}

export function ref(credential: CredentialDef): CredentialId {
  return credential.id as CredentialId;
}

type CredentialResponse<K extends CredentialDef> =
  | (K["kind"] extends "oauth"
      ? {
          accessToken: string;
          tokenType?: string;
          expiresAt?: number;
          scope?: string[];
        }
      : K["kind"] extends "secret"
        ? string
        : K["kind"] extends "env"
          ? string
          : never)
  | (K["optional"] extends true ? undefined : never);

export type CredentialStore = {
  /**
   * Resolve a credential by id in the current runtime context.
   *
   * Storage keys should be namespaced by workspace in the runtime/store layer.
   * The SDK only passes the logical credential id (for example "my-secret").
   *
   * Implementations should throw MissingCredentialError when a required credential
   * cannot be resolved (missing, expired, revoked, or unavailable in non-interactive runs).
   *
   * Note: `CredentialDef.fallback` is intentionally not applied by SDK/runtime yet.
   */
  load: (credentialId: CredentialId) => Promise<CredentialResponse<CredentialDef>>;
};

export function _setCredentialStore(store: CredentialStore) {
  setFallbackCredentialStore(store);
}

export type MissingCredentialReason = "missing" | "expired" | "revoked" | "non_interactive";

/**
 * Error thrown when credential resolution fails for a required credential.
 */
export class MissingCredentialError extends TokenspaceError {
  constructor(credential: CredentialDef, reason: MissingCredentialReason, details?: string) {
    const displayName = credential.label ?? credential.id;
    super(`Credential "${displayName}" is required but unavailable (${reason})`, undefined, details, {
      errorType: "CREDENTIAL_MISSING",
      credential: {
        id: ref(credential),
        label: credential.label,
        kind: credential.kind,
        scope: credential.scope,
        reason,
      },
    });
    this.name = "MissingCredentialError";
  }
}

/**
 * Error thrown when runtime did not initialize credential store before execution.
 */
export class CredentialStoreNotInitializedError extends TokenspaceError {
  constructor() {
    super(
      "Credential store not initialized",
      undefined,
      "Runtime must call runWithExecutionContext(...) or _setCredentialStore(...) before execution",
      {
        errorType: "CREDENTIAL_STORE_NOT_INITIALIZED",
      },
    );
    this.name = "CredentialStoreNotInitializedError";
  }
}

export async function getCredential<K extends CredentialDef>(cred: K): Promise<CredentialResponse<K>> {
  const credentialStore = getCredentialStore();
  if (!credentialStore) {
    throw new CredentialStoreNotInitializedError();
  }
  return await credentialStore.load(ref(cred));
}
