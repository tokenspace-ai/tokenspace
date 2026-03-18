import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from "./_generated/server";
import {
  requireAuthenticatedUser,
  requireSessionOwnership,
  requireWorkspaceAdmin,
  requireWorkspaceMember,
} from "./authz";
import {
  type CredentialCryptoContext,
  decryptCredentialPayload,
  decryptLegacyCredentialPayload,
  encryptCredentialPayload,
  getCurrentCredentialKeyVersion,
} from "./credentialsCrypto";
import type { CredentialRequirementSummary as WorkspaceCredentialRequirementSummary } from "./workspaceMetadata";

export const WORKSPACE_CREDENTIAL_SUBJECT = "__workspace__";

type CredentialScope = WorkspaceCredentialRequirementSummary["scope"];
type StoredCredentialKind = "secret" | "oauth";
type MissingCredentialReason = "missing" | "expired" | "revoked" | "non_interactive";
type OAuthGrantType = "authorization_code" | "client_credentials" | "implicit";

const OAUTH_AUTHORIZATION_TTL_MS = 10 * 60 * 1000;

type SecretCredentialPayload = { value: string };
type OAuthCredentialPayload = {
  accessToken: string;
  tokenType?: string;
  expiresAt?: number;
  scope?: string[];
  refreshToken?: string;
};

type MissingCredentialErrorPayload = {
  errorType: "CREDENTIAL_MISSING";
  credential: {
    id: string;
    label?: string;
    kind: "secret" | "env" | "oauth";
    scope: CredentialScope;
    reason: MissingCredentialReason;
  };
  details?: string;
};

const vStoredCredentialScope = v.union(v.literal("workspace"), v.literal("session"), v.literal("user"));
const vStoredCredentialKind = v.union(v.literal("secret"), v.literal("oauth"));
const vCredentialDeleteKind = v.optional(vStoredCredentialKind);
const vOAuthGrantType = v.union(
  v.literal("authorization_code"),
  v.literal("client_credentials"),
  v.literal("implicit"),
);
const vOAuthConnectScope = v.union(v.literal("workspace"), v.literal("user"));

const vSecretCredentialValue = v.object({
  value: v.string(),
});

const vOAuthCredentialValue = v.object({
  accessToken: v.string(),
  tokenType: v.optional(v.string()),
  expiresAt: v.optional(v.number()),
  scope: v.optional(v.array(v.string())),
  refreshToken: v.optional(v.string()),
});

const vCredentialStoredValue = v.union(vSecretCredentialValue, vOAuthCredentialValue);

const vOAuthHashParams = v.object({
  accessToken: v.optional(v.string()),
  tokenType: v.optional(v.string()),
  expiresIn: v.optional(v.string()),
  expiresAt: v.optional(v.string()),
  scope: v.optional(v.string()),
  refreshToken: v.optional(v.string()),
  error: v.optional(v.string()),
  errorDescription: v.optional(v.string()),
});

function assertCredentialId(credentialId: string): void {
  if (typeof credentialId !== "string" || credentialId.trim() === "") {
    throw new Error(`Invalid credential id: ${credentialId}`);
  }
}

function getCredentialDisplayName(credential: { id: string; label?: string }): string {
  return credential.label?.trim() || credential.id;
}

function parseSecretPayload(value: unknown): SecretCredentialPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored secret credential payload is invalid");
  }

  const secretValue = (value as Record<string, unknown>).value;
  if (typeof secretValue !== "string") {
    throw new Error("Stored secret credential payload is missing value");
  }

  return { value: secretValue };
}

function parseOAuthPayload(value: unknown): OAuthCredentialPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored oauth credential payload is invalid");
  }

  const accessToken = (value as Record<string, unknown>).accessToken;
  if (typeof accessToken !== "string") {
    throw new Error("Stored oauth credential payload is missing accessToken");
  }

  const tokenType = (value as Record<string, unknown>).tokenType;
  const expiresAt = (value as Record<string, unknown>).expiresAt;
  const scope = (value as Record<string, unknown>).scope;
  const refreshToken = (value as Record<string, unknown>).refreshToken;

  return {
    accessToken,
    tokenType: typeof tokenType === "string" ? tokenType : undefined,
    expiresAt: typeof expiresAt === "number" ? expiresAt : undefined,
    scope: Array.isArray(scope) && scope.every((entry) => typeof entry === "string") ? (scope as string[]) : undefined,
    refreshToken: typeof refreshToken === "string" ? refreshToken : undefined,
  };
}

export function isOAuthCredentialExpired(payload: OAuthCredentialPayload, nowMs: number = Date.now()): boolean {
  return typeof payload.expiresAt === "number" && Number.isFinite(payload.expiresAt) && payload.expiresAt <= nowMs;
}

function normalizePayloadForKind(
  kind: StoredCredentialKind,
  value: SecretCredentialPayload | OAuthCredentialPayload,
): SecretCredentialPayload | OAuthCredentialPayload {
  if (kind === "secret") {
    return parseSecretPayload(value);
  }
  return parseOAuthPayload(value);
}

type CredentialRequirementSummary = Pick<WorkspaceCredentialRequirementSummary, "id" | "label" | "kind" | "scope">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getCredentialRequirementById<T extends { id: string }>(
  requirements: T[] | undefined,
  credentialId: string,
): T | undefined {
  if (!requirements || requirements.length === 0) {
    return undefined;
  }
  return requirements.find((entry) => entry.id === credentialId);
}

function normalizeReturnPath(returnPath: string): string {
  const trimmed = returnPath.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return "/";
  }
  return trimmed;
}

function getOAuthCallbackUri(): string {
  const base = (process.env.TOKENSPACE_APP_URL?.trim() || "https://app.tokenspace.ai").replace(/\/$/, "");
  return `${base}/oauth/callback`;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const base64 =
    typeof btoa === "function"
      ? btoa(binary)
      : (
          globalThis as { Buffer?: { from: (bytes: Uint8Array) => { toString: (encoding: string) => string } } }
        ).Buffer?.from(bytes).toString("base64");
  if (!base64) {
    throw new Error("Base64 encoding is unavailable in this runtime");
  }
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function createPkceCodeVerifier(): string {
  return toBase64Url(randomBytes(48));
}

async function createPkceCodeChallenge(codeVerifier: string): Promise<string> {
  const encoded = new TextEncoder().encode(codeVerifier);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return toBase64Url(new Uint8Array(digest));
}

type OAuthRequirementConfig = {
  grantType: OAuthGrantType;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
};

type OAuthRequirementSummary = Pick<
  WorkspaceCredentialRequirementSummary,
  "id" | "label" | "kind" | "scope" | "config" | "optional"
>;

function readRequiredString(value: unknown, source: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${source} must be a non-empty string`);
  }
  return value;
}

function readScopes(value: unknown, source: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${source} must be an array`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(`${source}[${index}] must be a string`);
    }
    return entry;
  });
}

function parseOAuthRequirementConfig(requirement: OAuthRequirementSummary): OAuthRequirementConfig {
  if (!isRecord(requirement.config)) {
    throw new Error(`Credential "${getCredentialDisplayName(requirement)}" is missing oauth config`);
  }
  const grantType = requirement.config.grantType;
  if (grantType !== "authorization_code" && grantType !== "client_credentials" && grantType !== "implicit") {
    throw new Error(`Credential "${getCredentialDisplayName(requirement)}" has invalid oauth grantType`);
  }
  return {
    grantType,
    clientId: readRequiredString(requirement.config.clientId, `${requirement.id}.config.clientId`),
    clientSecret: readRequiredString(requirement.config.clientSecret, `${requirement.id}.config.clientSecret`),
    authorizeUrl: readRequiredString(requirement.config.authorizeUrl, `${requirement.id}.config.authorizeUrl`),
    tokenUrl: readRequiredString(requirement.config.tokenUrl, `${requirement.id}.config.tokenUrl`),
    scopes: readScopes(requirement.config.scopes, `${requirement.id}.config.scopes`),
  };
}

function parseResponsePayload(text: string, contentType: string | null): Record<string, unknown> {
  if (contentType?.toLowerCase().includes("application/json")) {
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) {
      throw new Error("OAuth response payload must be an object");
    }
    return parsed;
  }

  const params = new URLSearchParams(text);
  const result: Record<string, unknown> = {};
  for (const [key, value] of params.entries()) {
    result[key] = value;
  }
  return result;
}

function parseExpiryTimestampMs(payload: Record<string, unknown>, nowMs: number): number | undefined {
  const expiresAt = payload.expires_at;
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) {
    return expiresAt > 1_000_000_000_000 ? Math.floor(expiresAt) : Math.floor(expiresAt * 1000);
  }
  if (typeof expiresAt === "string" && expiresAt.trim()) {
    const numeric = Number(expiresAt.trim());
    if (Number.isFinite(numeric)) {
      return numeric > 1_000_000_000_000 ? Math.floor(numeric) : Math.floor(numeric * 1000);
    }
  }

  const expiresIn = payload.expires_in;
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn)) {
    return nowMs + Math.max(0, Math.floor(expiresIn * 1000));
  }
  if (typeof expiresIn === "string" && expiresIn.trim()) {
    const numeric = Number(expiresIn.trim());
    if (Number.isFinite(numeric)) {
      return nowMs + Math.max(0, Math.floor(numeric * 1000));
    }
  }

  return undefined;
}

function normalizeScopeValue(scope: unknown): string[] | undefined {
  if (Array.isArray(scope)) {
    if (scope.every((entry) => typeof entry === "string")) {
      return scope as string[];
    }
    return undefined;
  }
  if (typeof scope === "string") {
    return scope
      .split(/[,\s]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return undefined;
}

function normalizeOAuthTokenPayload(payload: Record<string, unknown>, nowMs: number): OAuthCredentialPayload {
  const authedUser = isRecord(payload.authed_user) ? payload.authed_user : undefined;
  const topLevelAccessToken = typeof payload.access_token === "string" ? payload.access_token.trim() : "";
  const authedUserAccessToken = typeof authedUser?.access_token === "string" ? authedUser.access_token.trim() : "";
  const accessToken = authedUserAccessToken || topLevelAccessToken;

  if (!accessToken) {
    const providerError = typeof payload.error === "string" && payload.error.trim() ? payload.error.trim() : undefined;
    if (providerError) {
      const providerErrorDescription =
        typeof payload.error_description === "string" && payload.error_description.trim()
          ? payload.error_description.trim()
          : undefined;
      throw new Error(
        providerErrorDescription
          ? `OAuth token response error: ${providerError}: ${providerErrorDescription}`
          : providerError,
      );
    }
    throw new Error("OAuth token response is missing access_token (or authed_user.access_token)");
  }

  const tokenTypeFromPayload =
    typeof payload.token_type === "string" && payload.token_type.trim() ? payload.token_type.trim() : undefined;
  const tokenTypeFromAuthedUser =
    typeof authedUser?.token_type === "string" && authedUser.token_type.trim()
      ? authedUser.token_type.trim()
      : undefined;
  const refreshTokenFromPayload =
    typeof payload.refresh_token === "string" && payload.refresh_token.trim()
      ? payload.refresh_token.trim()
      : undefined;
  const refreshTokenFromAuthedUser =
    typeof authedUser?.refresh_token === "string" && authedUser.refresh_token.trim()
      ? authedUser.refresh_token.trim()
      : undefined;
  const scopeFromPayload = normalizeScopeValue(payload.scope);
  const scopeFromAuthedUser = authedUser ? normalizeScopeValue(authedUser.scope) : undefined;
  const expiresAtFromPayload = parseExpiryTimestampMs(payload, nowMs);
  const expiresAtFromAuthedUser = authedUser ? parseExpiryTimestampMs(authedUser, nowMs) : undefined;

  return {
    accessToken,
    tokenType: tokenTypeFromAuthedUser ?? tokenTypeFromPayload,
    expiresAt: expiresAtFromAuthedUser ?? expiresAtFromPayload,
    scope: scopeFromAuthedUser ?? scopeFromPayload,
    refreshToken: refreshTokenFromAuthedUser ?? refreshTokenFromPayload,
  };
}

async function extractOAuthErrorFromResponse(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type");
  const bodyText = await response.text();
  if (!bodyText) {
    return `OAuth token endpoint returned ${response.status}`;
  }

  try {
    const payload = parseResponsePayload(bodyText, contentType);
    const error = typeof payload.error === "string" ? payload.error : undefined;
    const description = typeof payload.error_description === "string" ? payload.error_description : undefined;
    if (error || description) {
      return [error, description].filter(Boolean).join(": ");
    }
  } catch {
    // ignore parsing errors; fall back to status
  }

  return `OAuth token endpoint returned ${response.status}`;
}

async function exchangeOAuthToken(args: {
  tokenUrl: string;
  grantType: OAuthGrantType;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  code?: string;
  codeVerifier?: string;
}): Promise<OAuthCredentialPayload> {
  const params = new URLSearchParams();
  params.set("grant_type", args.grantType);
  params.set("client_id", args.clientId);
  params.set("client_secret", args.clientSecret);
  if (args.grantType === "authorization_code") {
    if (!args.code) {
      throw new Error("OAuth authorization_code callback is missing code");
    }
    params.set("code", args.code);
    params.set("redirect_uri", getOAuthCallbackUri());
    if (args.codeVerifier) {
      params.set("code_verifier", args.codeVerifier);
    }
  } else if (args.grantType === "client_credentials" && args.scopes.length > 0) {
    params.set("scope", args.scopes.join(" "));
  }

  const response = await fetch(args.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorDetail = await extractOAuthErrorFromResponse(response);
    console.error("[oauth] token exchange failed", { status: response.status, grantType: args.grantType });
    throw new Error(errorDetail);
  }

  const text = await response.text();
  const contentType = response.headers.get("content-type");
  const parsed = parseResponsePayload(text, contentType);
  const payload = normalizeOAuthTokenPayload(parsed, Date.now());
  return payload;
}

function buildOAuthAuthorizeUrl(args: {
  config: OAuthRequirementConfig;
  clientId: string;
  state: string;
  codeChallenge?: string;
}): string {
  const url = new URL(args.config.authorizeUrl);
  const responseType = args.config.grantType === "implicit" ? "token" : "code";
  url.searchParams.set("response_type", responseType);
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", getOAuthCallbackUri());
  url.searchParams.set("state", args.state);
  if (args.config.scopes.length > 0) {
    url.searchParams.set("scope", args.config.scopes.join(" "));
  }
  if (args.config.grantType === "authorization_code" && args.codeChallenge) {
    url.searchParams.set("code_challenge", args.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

async function resolveOAuthLinkedCredential(args: {
  ctx: {
    runQuery: <TArgs, TResult>(query: any, args: TArgs) => Promise<TResult>;
  };
  workspaceId: Id<"workspaces">;
  requirements: WorkspaceCredentialRequirementSummary[] | undefined;
  credentialValue: string;
  fieldName: string;
}): Promise<string> {
  const linkedCredential = getCredentialRequirementById(args.requirements, args.credentialValue);
  if (!linkedCredential || linkedCredential.kind !== "secret") {
    return args.credentialValue;
  }

  const resolved = await args.ctx.runQuery(internal.credentials.resolveCredentialForExecution, {
    workspaceId: args.workspaceId,
    credentialId: args.credentialValue,
    scope: "workspace",
    subject: WORKSPACE_CREDENTIAL_SUBJECT,
    expectedKind: "secret",
    optional: false,
    credentialLabel: linkedCredential.label,
  });
  if (typeof resolved !== "string" || resolved.trim() === "") {
    throw new Error(`OAuth ${args.fieldName} credential ${args.credentialValue} did not resolve to a secret value`);
  }
  return resolved;
}

export function redactCredentialRequirementForClient(
  requirement: WorkspaceCredentialRequirementSummary,
): WorkspaceCredentialRequirementSummary {
  if (requirement.kind !== "oauth" || !isRecord(requirement.config)) {
    return requirement;
  }
  const { clientId: _clientId, clientSecret: _clientSecret, ...rest } = requirement.config;
  return {
    ...requirement,
    config: rest,
  };
}

function assertRequirementMatchesStoredCredentialWrite(args: {
  requirement: CredentialRequirementSummary | undefined;
  credentialId: string;
  expectedScope: CredentialScope;
  expectedKind: StoredCredentialKind;
}): void {
  if (!args.requirement) {
    throw new Error(`Credential ${args.credentialId} is not declared in revision metadata`);
  }
  if (args.requirement.scope !== args.expectedScope) {
    throw new Error(
      `Credential "${getCredentialDisplayName(args.requirement)}" expects scope "${args.requirement.scope}" but received "${args.expectedScope}"`,
    );
  }
  if (args.requirement.kind !== args.expectedKind) {
    throw new Error(
      `Credential "${getCredentialDisplayName(args.requirement)}" expects kind "${args.requirement.kind}" but received "${args.expectedKind}"`,
    );
  }
}

export function buildMissingCredentialPayload(args: {
  credentialId: string;
  kind: "secret" | "env" | "oauth";
  scope: CredentialScope;
  reason?: MissingCredentialReason;
  credentialLabel?: string;
  details?: string;
}): MissingCredentialErrorPayload {
  return {
    errorType: "CREDENTIAL_MISSING",
    credential: {
      id: args.credentialId,
      label: args.credentialLabel,
      kind: args.kind,
      scope: args.scope,
      reason: args.reason ?? "missing",
    },
    details: args.details,
  };
}

function throwMissingCredential(args: {
  credentialId: string;
  kind: "secret" | "env" | "oauth";
  scope: CredentialScope;
  reason?: MissingCredentialReason;
  credentialLabel?: string;
  details?: string;
}): never {
  throw new ConvexError(buildMissingCredentialPayload(args));
}

function buildCryptoContext(args: {
  workspaceId: Id<"workspaces">;
  credentialId: string;
  scope: CredentialScope;
  subject: string;
  kind: StoredCredentialKind;
  keyVersion: number;
}): CredentialCryptoContext {
  return {
    workspaceId: String(args.workspaceId),
    credentialId: args.credentialId,
    scope: args.scope,
    subject: args.subject,
    kind: args.kind,
    keyVersion: args.keyVersion,
  };
}

type CredentialValueMutationArgs = {
  workspaceId: Id<"workspaces">;
  credentialId: string;
  scope: CredentialScope;
  subject: string;
  kind: StoredCredentialKind;
  value: SecretCredentialPayload | OAuthCredentialPayload;
  updatedByUserId?: string;
};

async function upsertCredentialValue(ctx: MutationCtx, args: CredentialValueMutationArgs) {
  assertCredentialId(args.credentialId);
  const payload = normalizePayloadForKind(args.kind, args.value);

  const keyVersion = getCurrentCredentialKeyVersion();
  const context = buildCryptoContext({
    workspaceId: args.workspaceId,
    credentialId: args.credentialId,
    scope: args.scope,
    subject: args.subject,
    kind: args.kind,
    keyVersion,
  });
  const encrypted = await encryptCredentialPayload(payload, context);
  const now = Date.now();

  const existing = await ctx.db
    .query("credentialValues")
    .withIndex("by_workspace_credential_id_scope_subject", (q) =>
      q
        .eq("workspaceId", args.workspaceId)
        .eq("credentialId", args.credentialId)
        .eq("scope", args.scope)
        .eq("subject", args.subject),
    )
    .first();

  if (existing) {
    await ctx.db.patch(existing._id, {
      kind: args.kind,
      keyVersion: encrypted.keyVersion,
      iv: encrypted.iv,
      ciphertext: encrypted.ciphertext,
      updatedAt: now,
      updatedByUserId: args.updatedByUserId,
    });
    return existing._id;
  }

  return await ctx.db.insert("credentialValues", {
    workspaceId: args.workspaceId,
    credentialId: args.credentialId,
    scope: args.scope,
    subject: args.subject,
    kind: args.kind,
    keyVersion: encrypted.keyVersion,
    iv: encrypted.iv,
    ciphertext: encrypted.ciphertext,
    createdAt: now,
    updatedAt: now,
    updatedByUserId: args.updatedByUserId,
  });
}

async function validateCredentialWriteAgainstRevision(args: {
  ctx: MutationCtx;
  workspaceId: Id<"workspaces">;
  revisionId: Id<"revisions">;
  credentialId: string;
  scope: CredentialScope;
  kind: StoredCredentialKind;
}) {
  const revision = await args.ctx.db.get(args.revisionId);
  if (!revision || revision.workspaceId !== args.workspaceId) {
    throw new Error("Revision not found");
  }

  const requirement = getCredentialRequirementById(revision.credentialRequirements, args.credentialId);
  assertRequirementMatchesStoredCredentialWrite({
    requirement,
    credentialId: args.credentialId,
    expectedScope: args.scope,
    expectedKind: args.kind,
  });

  return requirement;
}
type CredentialBindingRow = Doc<"credentialValues">;

async function mapCredentialBindingRow(row: CredentialBindingRow) {
  let isExpired = false;

  if (row.kind === "oauth") {
    try {
      const context = buildCryptoContext({
        workspaceId: row.workspaceId,
        credentialId: row.credentialId,
        scope: row.scope,
        subject: row.subject,
        kind: row.kind,
        keyVersion: row.keyVersion,
      });
      const payload = parseOAuthPayload(
        await decryptCredentialPayload<OAuthCredentialPayload>(
          {
            keyVersion: row.keyVersion,
            iv: row.iv,
            ciphertext: row.ciphertext,
          },
          context,
        ),
      );
      isExpired = isOAuthCredentialExpired(payload);
    } catch (error) {
      console.error("[credentials] failed to read oauth binding row", {
        workspaceId: row.workspaceId,
        credentialId: row.credentialId,
        scope: row.scope,
        subject: row.subject,
        error,
      });
      isExpired = true;
    }
  }

  return {
    _id: row._id,
    workspaceId: row.workspaceId,
    credentialId: row.credentialId,
    scope: row.scope,
    subject: row.subject,
    kind: row.kind,
    keyVersion: row.keyVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    updatedByUserId: row.updatedByUserId,
    isExpired,
  };
}

function credentialBindingKey(credentialId: string, kind: StoredCredentialKind) {
  return `${credentialId}:${kind}`;
}

type CredentialNavigationRequirement = {
  id: string;
  kind: "secret" | "env" | "oauth";
  scope: "workspace" | "session" | "user";
  optional?: boolean;
};

type CredentialNavigationBinding = {
  credentialId: string;
  kind: StoredCredentialKind;
  isExpired?: boolean;
};

export function summarizeCredentialNavigationState(args: {
  requirements: CredentialNavigationRequirement[];
  userBindings: CredentialNavigationBinding[];
  workspaceBindings?: CredentialNavigationBinding[];
  isWorkspaceAdmin: boolean;
}) {
  const isConfigured = (binding: CredentialNavigationBinding) => !binding.isExpired;
  const userBindingKeys = new Set(
    args.userBindings.filter(isConfigured).map((binding) => credentialBindingKey(binding.credentialId, binding.kind)),
  );
  const workspaceBindingKeys = new Set(
    (args.workspaceBindings ?? [])
      .filter(isConfigured)
      .map((binding) => credentialBindingKey(binding.credentialId, binding.kind)),
  );

  let requiredUserScopedCount = 0;
  let requiredWorkspaceScopedCount = 0;
  let configurableUserScopedCount = 0;
  let configurableWorkspaceScopedCount = 0;
  let missingUserScopedCount = 0;
  let missingWorkspaceScopedCount = 0;
  let missingConfigurableUserScopedCount = 0;
  let missingConfigurableWorkspaceScopedCount = 0;
  let hasUserScopedRequirements = false;
  let hasWorkspaceScopedRequirements = false;
  let hasSessionScopedRequirements = false;

  for (const requirement of args.requirements) {
    if (requirement.scope === "user") hasUserScopedRequirements = true;
    if (requirement.scope === "workspace") hasWorkspaceScopedRequirements = true;
    if (requirement.scope === "session") hasSessionScopedRequirements = true;

    if (requirement.kind === "env") {
      continue;
    }

    const key = credentialBindingKey(requirement.id, requirement.kind);
    if (requirement.scope === "user") {
      configurableUserScopedCount += 1;
      if (!userBindingKeys.has(key)) {
        missingConfigurableUserScopedCount += 1;
      }
      if (requirement.optional) {
        continue;
      }
      requiredUserScopedCount += 1;
      if (!userBindingKeys.has(key)) {
        missingUserScopedCount += 1;
      }
      continue;
    }

    if (requirement.scope === "workspace") {
      configurableWorkspaceScopedCount += 1;
      if (args.isWorkspaceAdmin && !workspaceBindingKeys.has(key)) {
        missingConfigurableWorkspaceScopedCount += 1;
      }
      if (requirement.optional) {
        continue;
      }
      requiredWorkspaceScopedCount += 1;
      if (args.isWorkspaceAdmin && !workspaceBindingKeys.has(key)) {
        missingWorkspaceScopedCount += 1;
      }
    }
  }

  const missingActionableCount = missingUserScopedCount + (args.isWorkspaceAdmin ? missingWorkspaceScopedCount : 0);
  const missingConfigurableCount =
    missingConfigurableUserScopedCount + (args.isWorkspaceAdmin ? missingConfigurableWorkspaceScopedCount : 0);

  return {
    isWorkspaceAdmin: args.isWorkspaceAdmin,
    hasAnyRequirements: args.requirements.length > 0,
    hasUserScopedRequirements,
    hasWorkspaceScopedRequirements,
    hasSessionScopedRequirements,
    configurableUserScopedCount,
    configurableWorkspaceScopedCount,
    requiredUserScopedCount,
    requiredWorkspaceScopedCount,
    missingConfigurableUserScopedCount,
    missingConfigurableWorkspaceScopedCount,
    missingConfigurableCount,
    missingUserScopedCount,
    missingWorkspaceScopedCount,
    missingActionableCount,
  };
}

async function listCredentialBindingsByScopeAndSubject(args: {
  ctx: QueryCtx;
  workspaceId: Id<"workspaces">;
  scope: CredentialScope;
  subject: string;
}) {
  const rows = await args.ctx.db
    .query("credentialValues")
    .withIndex("by_workspace_scope_subject", (q) =>
      q.eq("workspaceId", args.workspaceId).eq("scope", args.scope).eq("subject", args.subject),
    )
    .collect();

  const sortedRows = rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return await Promise.all(sortedRows.map((row) => mapCredentialBindingRow(row)));
}

async function deleteCredentialBindings(args: {
  ctx: MutationCtx;
  workspaceId: Id<"workspaces">;
  credentialId: string;
  scope: CredentialScope;
  subject: string;
  kind?: StoredCredentialKind;
}) {
  const existing = await args.ctx.db
    .query("credentialValues")
    .withIndex("by_workspace_credential_id_scope_subject", (q) =>
      q
        .eq("workspaceId", args.workspaceId)
        .eq("credentialId", args.credentialId)
        .eq("scope", args.scope)
        .eq("subject", args.subject),
    )
    .collect();

  let deleted = 0;
  for (const row of existing) {
    if (args.kind && row.kind !== args.kind) {
      continue;
    }
    await args.ctx.db.delete(row._id);
    deleted += 1;
  }
  return { deleted };
}

export function resolveEnvCredentialValue(args: {
  variableName: string;
  optional?: boolean;
  credentialId: string;
  scope: CredentialScope;
  credentialLabel?: string;
}): string | undefined {
  const value = process.env[args.variableName];
  if (value !== undefined) {
    return value;
  }

  if (args.optional) {
    return undefined;
  }

  throwMissingCredential({
    credentialId: args.credentialId,
    kind: "env",
    scope: args.scope,
    credentialLabel: args.credentialLabel,
    details: `Environment variable ${args.variableName} is not set`,
  });
}

export const createOAuthAuthorizationInternal = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    revisionId: v.id("revisions"),
    credentialId: v.string(),
    scope: vStoredCredentialScope,
    subject: v.string(),
    initiatedByUserId: v.string(),
    grantType: vOAuthGrantType,
    state: v.string(),
    codeVerifier: v.optional(v.string()),
    returnPath: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    status: v.union(v.literal("pending"), v.literal("completed"), v.literal("failed"), v.literal("expired")),
    consumedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("oauthAuthorizations", args);
  },
});

export const getOAuthAuthorizationByStateInternal = internalQuery({
  args: {
    state: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("oauthAuthorizations")
      .withIndex("by_state", (q) => q.eq("state", args.state))
      .first();
  },
});

export const updateOAuthAuthorizationStatusInternal = internalMutation({
  args: {
    authorizationId: v.id("oauthAuthorizations"),
    status: v.union(v.literal("pending"), v.literal("completed"), v.literal("failed"), v.literal("expired")),
    consumedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.authorizationId, {
      status: args.status,
      consumedAt: args.consumedAt,
    });
  },
});

function assertOAuthRequirementForConnect(args: {
  requirement: WorkspaceCredentialRequirementSummary | undefined;
  credentialId: string;
  expectedScope: "workspace" | "user";
}): OAuthRequirementSummary {
  if (!args.requirement) {
    throw new Error(`Credential ${args.credentialId} is not declared in revision metadata`);
  }
  if (args.requirement.kind !== "oauth") {
    throw new Error(`Credential "${getCredentialDisplayName(args.requirement)}" is not an oauth credential`);
  }
  if (args.requirement.scope !== args.expectedScope) {
    throw new Error(
      `Credential "${getCredentialDisplayName(args.requirement)}" expects scope "${args.requirement.scope}" but received "${args.expectedScope}"`,
    );
  }
  return args.requirement;
}

export const beginOAuthConnect = action({
  args: {
    workspaceId: v.id("workspaces"),
    revisionId: v.id("revisions"),
    credentialId: v.string(),
    scope: vOAuthConnectScope,
    returnPath: v.string(),
  },
  handler: async (ctx, args): Promise<{ mode: "redirect"; authorizeUrl: string } | { mode: "completed" }> => {
    assertCredentialId(args.credentialId);
    const normalizedReturnPath = normalizeReturnPath(args.returnPath);

    const auth =
      args.scope === "workspace"
        ? await requireWorkspaceAdmin(ctx, args.workspaceId)
        : await requireWorkspaceMember(ctx, args.workspaceId);
    const subject = args.scope === "workspace" ? WORKSPACE_CREDENTIAL_SUBJECT : auth.user.subject;

    const revision = await ctx.runQuery(internal.revisions.getRevision, {
      revisionId: args.revisionId,
    });
    if (!revision || revision.workspaceId !== args.workspaceId) {
      throw new Error("Revision not found");
    }

    const requirement = assertOAuthRequirementForConnect({
      requirement: getCredentialRequirementById(revision.credentialRequirements, args.credentialId),
      credentialId: args.credentialId,
      expectedScope: args.scope,
    });
    const oauthConfig = parseOAuthRequirementConfig(requirement);

    const clientSecret = await resolveOAuthLinkedCredential({
      ctx,
      workspaceId: args.workspaceId,
      requirements: revision.credentialRequirements,
      credentialValue: oauthConfig.clientSecret,
      fieldName: "clientSecret",
    });

    const clientId = await resolveOAuthLinkedCredential({
      ctx,
      workspaceId: args.workspaceId,
      requirements: revision.credentialRequirements,
      credentialValue: oauthConfig.clientId,
      fieldName: "clientId",
    });

    if (oauthConfig.grantType === "client_credentials") {
      const tokenPayload = await exchangeOAuthToken({
        tokenUrl: oauthConfig.tokenUrl,
        grantType: oauthConfig.grantType,
        clientId,
        clientSecret,
        scopes: oauthConfig.scopes,
      });

      await ctx.runMutation(internal.credentials.upsertCredentialValueInternal, {
        workspaceId: args.workspaceId,
        credentialId: args.credentialId,
        scope: args.scope,
        subject,
        kind: "oauth",
        value: tokenPayload,
        updatedByUserId: auth.user.subject,
      });

      return {
        mode: "completed" as const,
      };
    }

    const now = Date.now();
    const state = `oauth_${crypto.randomUUID()}_${toBase64Url(randomBytes(18))}`;
    const codeVerifier = oauthConfig.grantType === "authorization_code" ? createPkceCodeVerifier() : undefined;
    const codeChallenge = codeVerifier ? await createPkceCodeChallenge(codeVerifier) : undefined;
    const authorizeUrl = buildOAuthAuthorizeUrl({
      config: oauthConfig,
      clientId,
      state,
      codeChallenge,
    });

    await ctx.runMutation(internal.credentials.createOAuthAuthorizationInternal, {
      workspaceId: args.workspaceId,
      revisionId: args.revisionId,
      credentialId: args.credentialId,
      scope: args.scope,
      subject,
      initiatedByUserId: auth.user.subject,
      grantType: oauthConfig.grantType,
      state,
      codeVerifier,
      returnPath: normalizedReturnPath,
      createdAt: now,
      expiresAt: now + OAUTH_AUTHORIZATION_TTL_MS,
      status: "pending",
    });

    return {
      mode: "redirect" as const,
      authorizeUrl,
    };
  },
});

export const completeOAuthConnect = action({
  args: {
    state: v.string(),
    code: v.optional(v.string()),
    error: v.optional(v.string()),
    errorDescription: v.optional(v.string()),
    hashParams: v.optional(vOAuthHashParams),
  },
  handler: async (ctx, args): Promise<{ success: boolean; redirectPath: string; message?: string }> => {
    const user = await requireAuthenticatedUser(ctx);
    const authorization: Doc<"oauthAuthorizations"> | null = await ctx.runQuery(
      internal.credentials.getOAuthAuthorizationByStateInternal,
      {
        state: args.state,
      },
    );
    if (!authorization) {
      return {
        success: false,
        redirectPath: "/",
        message: "OAuth authorization was not found or has expired.",
      };
    }

    const redirectPath = normalizeReturnPath(authorization.returnPath);
    const markStatus = async (status: "completed" | "failed" | "expired") => {
      await ctx.runMutation(internal.credentials.updateOAuthAuthorizationStatusInternal, {
        authorizationId: authorization._id,
        status,
        consumedAt: Date.now(),
      });
    };

    if (authorization.initiatedByUserId !== user.subject) {
      return {
        success: false,
        redirectPath,
        message: "OAuth authorization does not belong to the current user.",
      };
    }
    if (authorization.status !== "pending" || authorization.consumedAt !== undefined) {
      return {
        success: false,
        redirectPath,
        message: "OAuth authorization has already been used.",
      };
    }
    if (authorization.expiresAt <= Date.now()) {
      await markStatus("expired");
      return {
        success: false,
        redirectPath,
        message: "OAuth authorization has expired. Please reconnect.",
      };
    }

    const callbackError = args.error || args.hashParams?.error;
    if (callbackError) {
      const description = args.errorDescription || args.hashParams?.errorDescription;
      console.error("[oauth] provider returned error", { error: callbackError });
      await markStatus("failed");
      return {
        success: false,
        redirectPath,
        message: description ? `${callbackError}: ${description}` : callbackError,
      };
    }

    const revision = await ctx.runQuery(internal.revisions.getRevision, {
      revisionId: authorization.revisionId,
    });
    if (!revision || revision.workspaceId !== authorization.workspaceId) {
      await markStatus("failed");
      return {
        success: false,
        redirectPath,
        message: "Revision not found for OAuth authorization.",
      };
    }

    const authorizationScope =
      authorization.scope === "workspace" || authorization.scope === "user" ? authorization.scope : null;
    if (!authorizationScope) {
      await markStatus("failed");
      return {
        success: false,
        redirectPath,
        message: `Unsupported OAuth authorization scope: ${authorization.scope}`,
      };
    }

    const requirement = assertOAuthRequirementForConnect({
      requirement: getCredentialRequirementById(revision.credentialRequirements, authorization.credentialId),
      credentialId: authorization.credentialId,
      expectedScope: authorizationScope,
    });
    const oauthConfig = parseOAuthRequirementConfig(requirement);

    try {
      let tokenPayload: OAuthCredentialPayload;

      if (authorization.grantType === "authorization_code") {
        const clientSecret = await resolveOAuthLinkedCredential({
          ctx,
          workspaceId: authorization.workspaceId,
          requirements: revision.credentialRequirements,
          credentialValue: oauthConfig.clientSecret,
          fieldName: "clientSecret",
        });
        const clientId = await resolveOAuthLinkedCredential({
          ctx,
          workspaceId: authorization.workspaceId,
          requirements: revision.credentialRequirements,
          credentialValue: oauthConfig.clientId,
          fieldName: "clientId",
        });
        tokenPayload = await exchangeOAuthToken({
          tokenUrl: oauthConfig.tokenUrl,
          grantType: "authorization_code",
          clientId,
          clientSecret,
          scopes: oauthConfig.scopes,
          code: args.code,
          codeVerifier: authorization.codeVerifier,
        });
      } else if (authorization.grantType === "implicit") {
        tokenPayload = normalizeOAuthTokenPayload(
          {
            access_token: args.hashParams?.accessToken,
            token_type: args.hashParams?.tokenType,
            expires_in: args.hashParams?.expiresIn,
            expires_at: args.hashParams?.expiresAt,
            scope: args.hashParams?.scope,
            refresh_token: args.hashParams?.refreshToken,
          },
          Date.now(),
        );
      } else {
        await markStatus("failed");
        return {
          success: false,
          redirectPath,
          message: "client_credentials flow does not require callback completion.",
        };
      }

      await ctx.runMutation(internal.credentials.upsertCredentialValueInternal, {
        workspaceId: authorization.workspaceId,
        credentialId: authorization.credentialId,
        scope: authorizationScope,
        subject: authorization.subject,
        kind: "oauth",
        value: tokenPayload,
        updatedByUserId: user.subject,
      });
      await markStatus("completed");
      return {
        success: true,
        redirectPath,
      };
    } catch (error) {
      console.error("[oauth] completeOAuthConnect failed", { credentialId: authorization.credentialId });
      await markStatus("failed");
      return {
        success: false,
        redirectPath,
        message: error instanceof Error ? error.message : "Failed to complete OAuth flow.",
      };
    }
  },
});

export const upsertCredentialValueInternal = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    credentialId: v.string(),
    scope: vStoredCredentialScope,
    subject: v.string(),
    kind: vStoredCredentialKind,
    value: vCredentialStoredValue,
    updatedByUserId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await upsertCredentialValue(ctx, args);
  },
});

export const seedUpsertWorkspaceCredentialInternal = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    credentialId: v.string(),
    kind: vStoredCredentialKind,
    value: vCredentialStoredValue,
  },
  handler: async (ctx, args) => {
    // Seed runs before compilation, so the revision (with credentialRequirements)
    // may not exist yet. Skip revision validation for trusted seed data.
    return await upsertCredentialValue(ctx, {
      workspaceId: args.workspaceId,
      credentialId: args.credentialId,
      scope: "workspace",
      subject: WORKSPACE_CREDENTIAL_SUBJECT,
      kind: args.kind,
      value: args.value,
    });
  },
});

export const upsertWorkspaceCredential = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    revisionId: v.id("revisions"),
    credentialId: v.string(),
    kind: vStoredCredentialKind,
    value: vCredentialStoredValue,
  },
  handler: async (ctx, args) => {
    const { user } = await requireWorkspaceAdmin(ctx, args.workspaceId);
    await validateCredentialWriteAgainstRevision({
      ctx,
      workspaceId: args.workspaceId,
      revisionId: args.revisionId,
      credentialId: args.credentialId,
      scope: "workspace",
      kind: args.kind,
    });
    return await upsertCredentialValue(ctx, {
      workspaceId: args.workspaceId,
      credentialId: args.credentialId,
      scope: "workspace",
      subject: WORKSPACE_CREDENTIAL_SUBJECT,
      kind: args.kind,
      value: args.value,
      updatedByUserId: user.subject,
    });
  },
});

export const deleteWorkspaceCredential = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    credentialId: v.string(),
    kind: vCredentialDeleteKind,
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAdmin(ctx, args.workspaceId);
    assertCredentialId(args.credentialId);
    return await deleteCredentialBindings({
      ctx,
      workspaceId: args.workspaceId,
      credentialId: args.credentialId,
      scope: "workspace",
      subject: WORKSPACE_CREDENTIAL_SUBJECT,
      kind: args.kind,
    });
  },
});

export const upsertSessionCredential = mutation({
  args: {
    sessionId: v.id("sessions"),
    credentialId: v.string(),
    kind: vStoredCredentialKind,
    value: vCredentialStoredValue,
  },
  handler: async (ctx, args) => {
    const session = await requireSessionOwnership(ctx, args.sessionId);
    const revision = await ctx.db.get(session.revisionId);
    if (!revision) {
      throw new Error("Revision not found");
    }
    await validateCredentialWriteAgainstRevision({
      ctx,
      workspaceId: revision.workspaceId,
      revisionId: session.revisionId,
      credentialId: args.credentialId,
      scope: "session",
      kind: args.kind,
    });
    return await upsertCredentialValue(ctx, {
      workspaceId: revision.workspaceId,
      credentialId: args.credentialId,
      scope: "session",
      subject: String(args.sessionId),
      kind: args.kind,
      value: args.value,
      updatedByUserId: session.userId,
    });
  },
});

export const deleteSessionCredential = mutation({
  args: {
    sessionId: v.id("sessions"),
    credentialId: v.string(),
    kind: vCredentialDeleteKind,
  },
  handler: async (ctx, args) => {
    const session = await requireSessionOwnership(ctx, args.sessionId);
    const revision = await ctx.db.get(session.revisionId);
    if (!revision) {
      throw new Error("Revision not found");
    }
    assertCredentialId(args.credentialId);
    return await deleteCredentialBindings({
      ctx,
      workspaceId: revision.workspaceId,
      credentialId: args.credentialId,
      scope: "session",
      subject: String(args.sessionId),
      kind: args.kind,
    });
  },
});

export const upsertUserCredential = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    revisionId: v.id("revisions"),
    credentialId: v.string(),
    kind: vStoredCredentialKind,
    value: vCredentialStoredValue,
  },
  handler: async (ctx, args) => {
    const { user } = await requireWorkspaceMember(ctx, args.workspaceId);
    await validateCredentialWriteAgainstRevision({
      ctx,
      workspaceId: args.workspaceId,
      revisionId: args.revisionId,
      credentialId: args.credentialId,
      scope: "user",
      kind: args.kind,
    });
    return await upsertCredentialValue(ctx, {
      workspaceId: args.workspaceId,
      credentialId: args.credentialId,
      scope: "user",
      subject: user.subject,
      kind: args.kind,
      value: args.value,
      updatedByUserId: user.subject,
    });
  },
});

export const deleteUserCredential = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    credentialId: v.string(),
    kind: vCredentialDeleteKind,
  },
  handler: async (ctx, args) => {
    const { user } = await requireWorkspaceMember(ctx, args.workspaceId);
    assertCredentialId(args.credentialId);
    return await deleteCredentialBindings({
      ctx,
      workspaceId: args.workspaceId,
      credentialId: args.credentialId,
      scope: "user",
      subject: user.subject,
      kind: args.kind,
    });
  },
});

async function listWorkspaceCredentialBindingsImpl(ctx: QueryCtx, workspaceId: Id<"workspaces">) {
  await requireWorkspaceAdmin(ctx, workspaceId);
  return await listCredentialBindingsByScopeAndSubject({
    ctx,
    workspaceId,
    scope: "workspace",
    subject: WORKSPACE_CREDENTIAL_SUBJECT,
  });
}

export const listWorkspaceCredentialBindings = query({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    return await listWorkspaceCredentialBindingsImpl(ctx, args.workspaceId);
  },
});

export const listSessionCredentialBindings = query({
  args: {
    sessionId: v.id("sessions"),
  },
  handler: async (ctx, args) => {
    const session = await requireSessionOwnership(ctx, args.sessionId);
    const revision = await ctx.db.get(session.revisionId);
    if (!revision) {
      throw new Error("Revision not found");
    }
    return await listCredentialBindingsByScopeAndSubject({
      ctx,
      workspaceId: revision.workspaceId,
      scope: "session",
      subject: String(args.sessionId),
    });
  },
});

export const listUserCredentialBindings = query({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireWorkspaceMember(ctx, args.workspaceId);
    return await listCredentialBindingsByScopeAndSubject({
      ctx,
      workspaceId: args.workspaceId,
      scope: "user",
      subject: user.subject,
    });
  },
});

export const getCredentialRequirementsForRevision = query({
  args: {
    revisionId: v.id("revisions"),
  },
  handler: async (ctx, args) => {
    const revision = await ctx.db.get(args.revisionId);
    if (!revision) {
      throw new Error("Revision not found");
    }
    await requireWorkspaceMember(ctx, revision.workspaceId);
    return [...(revision.credentialRequirements ?? [])].map(redactCredentialRequirementForClient);
  },
});

export const getCredentialNavigationSummary = query({
  args: {
    revisionId: v.id("revisions"),
  },
  handler: async (ctx, args) => {
    const revision = await ctx.db.get(args.revisionId);
    if (!revision) {
      throw new Error("Revision not found");
    }

    const { membership, user } = await requireWorkspaceMember(ctx, revision.workspaceId);
    const isWorkspaceAdmin = membership.role === "workspace_admin";
    const userBindings = await listCredentialBindingsByScopeAndSubject({
      ctx,
      workspaceId: revision.workspaceId,
      scope: "user",
      subject: user.subject,
    });
    const workspaceBindings = isWorkspaceAdmin
      ? await listWorkspaceCredentialBindingsImpl(ctx, revision.workspaceId)
      : [];

    return summarizeCredentialNavigationState({
      requirements: [...(revision.credentialRequirements ?? [])].map(redactCredentialRequirementForClient),
      userBindings,
      workspaceBindings,
      isWorkspaceAdmin,
    });
  },
});

export const listCredentialValuesInternal = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("credentialValues")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
  },
});

export const resolveCredentialForExecution = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    credentialId: v.string(),
    scope: vStoredCredentialScope,
    subject: v.string(),
    expectedKind: v.union(v.literal("secret"), v.literal("env"), v.literal("oauth")),
    optional: v.optional(v.boolean()),
    credentialLabel: v.optional(v.string()),
    envConfig: v.optional(
      v.object({
        variableName: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    assertCredentialId(args.credentialId);

    if (args.expectedKind === "env") {
      if (!args.envConfig?.variableName) {
        throw new Error("Invalid env credential config: missing variableName");
      }
      return resolveEnvCredentialValue({
        variableName: args.envConfig.variableName,
        optional: args.optional,
        credentialId: args.credentialId,
        scope: args.scope,
        credentialLabel: args.credentialLabel,
      });
    }

    const row = await ctx.db
      .query("credentialValues")
      .withIndex("by_workspace_credential_id_scope_subject", (q) =>
        q
          .eq("workspaceId", args.workspaceId)
          .eq("credentialId", args.credentialId)
          .eq("scope", args.scope)
          .eq("subject", args.subject),
      )
      .first();

    if (!row) {
      if (args.optional) {
        return undefined;
      }
      throwMissingCredential({
        credentialId: args.credentialId,
        kind: args.expectedKind,
        scope: args.scope,
        credentialLabel: args.credentialLabel,
      });
    }

    if (row.kind !== args.expectedKind) {
      throwMissingCredential({
        credentialId: args.credentialId,
        kind: args.expectedKind,
        scope: args.scope,
        credentialLabel: args.credentialLabel,
        details: `Stored credential kind ${row.kind} does not match expected kind ${args.expectedKind}`,
      });
    }

    const context = buildCryptoContext({
      workspaceId: args.workspaceId,
      credentialId: args.credentialId,
      scope: args.scope,
      subject: args.subject,
      kind: row.kind,
      keyVersion: row.keyVersion,
    });

    if (row.kind === "secret") {
      const payload = parseSecretPayload(
        await decryptCredentialPayload<SecretCredentialPayload>(
          {
            keyVersion: row.keyVersion,
            iv: row.iv,
            ciphertext: row.ciphertext,
          },
          context,
        ),
      );
      return payload.value;
    }

    const payload = parseOAuthPayload(
      await decryptCredentialPayload<OAuthCredentialPayload>(
        {
          keyVersion: row.keyVersion,
          iv: row.iv,
          ciphertext: row.ciphertext,
        },
        context,
      ),
    );

    if (isOAuthCredentialExpired(payload)) {
      if (args.optional) {
        return undefined;
      }
      throwMissingCredential({
        credentialId: args.credentialId,
        kind: "oauth",
        scope: args.scope,
        credentialLabel: args.credentialLabel,
        reason: "expired",
        details: `OAuth token expired at ${new Date(payload.expiresAt as number).toISOString()}`,
      });
    }
    return payload;
  },
});

function isLegacyCredentialReference(value: string): boolean {
  return /^\[\[[^\]]+\]\]$/.test(value);
}

function unwrapLegacyCredentialReference(value: string): string {
  return isLegacyCredentialReference(value) ? value.slice(2, -2) : value;
}

function migrateLinkedCredentialValue(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("Linked credential values must be strings");
  }
  return unwrapLegacyCredentialReference(value);
}

function migrateCredentialRequirementSummary(requirement: unknown): WorkspaceCredentialRequirementSummary | undefined {
  if (!isRecord(requirement)) {
    return undefined;
  }

  const idSource =
    typeof requirement.id === "string"
      ? requirement.id
      : typeof requirement.name === "string"
        ? requirement.name
        : typeof requirement.reference === "string"
          ? unwrapLegacyCredentialReference(requirement.reference)
          : undefined;

  if (!idSource) {
    throw new Error("Credential requirement is missing an id");
  }

  const kind = requirement.kind;
  const scope = requirement.scope;
  if (kind !== "secret" && kind !== "env" && kind !== "oauth") {
    throw new Error(`Credential "${idSource}" has invalid kind during migration`);
  }
  if (scope !== "workspace" && scope !== "session" && scope !== "user") {
    throw new Error(`Credential "${idSource}" has invalid scope during migration`);
  }

  const migrated: WorkspaceCredentialRequirementSummary = {
    path: readRequiredString(requirement.path, `${idSource}.path`),
    exportName: readRequiredString(requirement.exportName, `${idSource}.exportName`),
    id: idSource,
    label: typeof requirement.label === "string" && requirement.label.trim() ? requirement.label : undefined,
    group: typeof requirement.group === "string" && requirement.group.trim() ? requirement.group : undefined,
    kind,
    scope,
    description: typeof requirement.description === "string" ? requirement.description : undefined,
    placeholder: typeof requirement.placeholder === "string" ? requirement.placeholder : undefined,
    optional: typeof requirement.optional === "boolean" ? requirement.optional : undefined,
    fallback: migrateLinkedCredentialValue(requirement.fallback),
  };

  if (kind === "env") {
    const config = isRecord(requirement.config) ? requirement.config : {};
    migrated.config = {
      variableName: readRequiredString(config.variableName, `${idSource}.config.variableName`),
      ...(config.decryptionKey !== undefined
        ? { decryptionKey: migrateLinkedCredentialValue(config.decryptionKey) }
        : {}),
    };
  } else if (kind === "oauth") {
    const config = isRecord(requirement.config) ? requirement.config : {};
    migrated.config = {
      grantType: readRequiredString(config.grantType, `${idSource}.config.grantType`),
      clientId: readRequiredString(migrateLinkedCredentialValue(config.clientId), `${idSource}.config.clientId`),
      clientSecret: readRequiredString(
        migrateLinkedCredentialValue(config.clientSecret),
        `${idSource}.config.clientSecret`,
      ),
      authorizeUrl: readRequiredString(config.authorizeUrl, `${idSource}.config.authorizeUrl`),
      tokenUrl: readRequiredString(config.tokenUrl, `${idSource}.config.tokenUrl`),
      scopes: readScopes(config.scopes, `${idSource}.config.scopes`),
    };
  }

  return migrated;
}

export const migrateLegacyCredentialDataInternal = internalMutation({
  args: {},
  handler: async (ctx) => {
    let migratedRevisions = 0;
    let migratedCredentialValues = 0;
    let migratedOauthAuthorizations = 0;

    const revisions = await ctx.db.query("revisions").collect();
    for (const revision of revisions) {
      const existing = revision.credentialRequirements;
      if (!existing) {
        continue;
      }
      const migrated = existing
        .map((requirement) => migrateCredentialRequirementSummary(requirement))
        .filter((requirement): requirement is WorkspaceCredentialRequirementSummary => requirement !== undefined);
      const changed = JSON.stringify(existing) !== JSON.stringify(migrated);
      if (changed) {
        await ctx.db.patch(revision._id, {
          credentialRequirements: migrated,
        });
        migratedRevisions += 1;
      }
    }

    const credentialRows = (await ctx.db.query("credentialValues").collect()) as Array<
      Doc<"credentialValues"> & { reference?: string }
    >;
    for (const row of credentialRows) {
      const legacyReference = typeof row.reference === "string" ? row.reference : undefined;
      if (!legacyReference) {
        continue;
      }

      const credentialId = unwrapLegacyCredentialReference(legacyReference);
      const existing = await ctx.db
        .query("credentialValues")
        .withIndex("by_workspace_credential_id_scope_subject", (q) =>
          q
            .eq("workspaceId", row.workspaceId)
            .eq("credentialId", credentialId)
            .eq("scope", row.scope)
            .eq("subject", row.subject),
        )
        .first();

      if (!existing) {
        const payload =
          row.kind === "secret"
            ? await decryptLegacyCredentialPayload<SecretCredentialPayload>(
                {
                  keyVersion: row.keyVersion,
                  iv: row.iv,
                  ciphertext: row.ciphertext,
                },
                {
                  workspaceId: String(row.workspaceId),
                  reference: legacyReference,
                  scope: row.scope,
                  subject: row.subject,
                  kind: row.kind,
                  keyVersion: row.keyVersion,
                },
              )
            : await decryptLegacyCredentialPayload<OAuthCredentialPayload>(
                {
                  keyVersion: row.keyVersion,
                  iv: row.iv,
                  ciphertext: row.ciphertext,
                },
                {
                  workspaceId: String(row.workspaceId),
                  reference: legacyReference,
                  scope: row.scope,
                  subject: row.subject,
                  kind: row.kind,
                  keyVersion: row.keyVersion,
                },
              );

        const encrypted = await encryptCredentialPayload(payload, {
          workspaceId: String(row.workspaceId),
          credentialId,
          scope: row.scope,
          subject: row.subject,
          kind: row.kind,
          keyVersion: row.keyVersion,
        });

        await ctx.db.insert("credentialValues", {
          workspaceId: row.workspaceId,
          credentialId,
          scope: row.scope,
          subject: row.subject,
          kind: row.kind,
          keyVersion: encrypted.keyVersion,
          iv: encrypted.iv,
          ciphertext: encrypted.ciphertext,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          updatedByUserId: row.updatedByUserId,
        });
      }

      await ctx.db.delete(row._id);
      migratedCredentialValues += 1;
    }

    const authorizations = (await ctx.db.query("oauthAuthorizations").collect()) as Array<
      Doc<"oauthAuthorizations"> & { reference?: string }
    >;
    for (const authorization of authorizations) {
      const legacyReference = typeof authorization.reference === "string" ? authorization.reference : undefined;
      if (!legacyReference) {
        continue;
      }

      const credentialId = unwrapLegacyCredentialReference(legacyReference);
      const existing = await ctx.db
        .query("oauthAuthorizations")
        .withIndex("by_state", (q) => q.eq("state", authorization.state))
        .collect();

      const hasOtherRowWithSameState = existing.some((row) => row._id !== authorization._id);

      if (!hasOtherRowWithSameState) {
        await ctx.db.insert("oauthAuthorizations", {
          workspaceId: authorization.workspaceId,
          revisionId: authorization.revisionId,
          credentialId,
          scope: authorization.scope,
          subject: authorization.subject,
          initiatedByUserId: authorization.initiatedByUserId,
          grantType: authorization.grantType,
          state: authorization.state,
          codeVerifier: authorization.codeVerifier,
          returnPath: authorization.returnPath,
          createdAt: authorization.createdAt,
          expiresAt: authorization.expiresAt,
          consumedAt: authorization.consumedAt,
          status: authorization.status,
        });
      }

      await ctx.db.delete(authorization._id);
      migratedOauthAuthorizations += 1;
    }

    return {
      migratedRevisions,
      migratedCredentialValues,
      migratedOauthAuthorizations,
    };
  },
});
