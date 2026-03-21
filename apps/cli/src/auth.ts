/**
 * CLI Authentication using WorkOS Device Authorization Grant Flow
 * @see https://workos.com/docs/user-management/cli-auth
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pc from "picocolors";

export const DEFAULT_WEB_APP_URL = "https://app.tokenspace.ai";
const DEFAULT_DEVICE_AUTH_SCOPE = "openid profile email";
const WORKOS_API_BASE_URL = "https://api.workos.com";

// Verbose logging flag
let verbose = false;

interface DeviceAuthResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
}

interface PublicCliConfigResponse {
  version: 1;
  webAppUrl: string;
  workosClientId: string;
  deviceAuthScope: string;
}

interface AuthenticatedCliConfigResponse {
  version: 1;
  convexUrl: string;
}

interface DiscoveredAuthSettings {
  webAppUrl: string;
  workosClientId: string;
  convexUrl?: string;
  deviceAuthScope: string;
}

export interface StoredAuth {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  userId?: string;
  webAppUrl?: string;
  workosClientId?: string;
  convexUrl?: string;
  deviceAuthScope?: string;
  defaultWorkspaceSlug?: string;
}

function getConfigDir(): string {
  return process.env.TOKENSPACE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".tokenspace");
}

function getTokenFilePath(): string {
  return path.join(getConfigDir(), "auth.json");
}

/**
 * Enable or disable verbose logging
 */
export function setVerbose(enabled: boolean): void {
  verbose = enabled;
  if (verbose) {
    debug("Verbose logging enabled");
  }
}

/**
 * Log debug message if verbose mode is enabled
 */
function debug(message: string, data?: unknown): void {
  if (!verbose) return;
  const timestamp = new Date().toISOString();
  if (data !== undefined) {
    console.log(pc.dim(`[${timestamp}] [DEBUG] ${message}`), data);
  } else {
    console.log(pc.dim(`[${timestamp}] [DEBUG] ${message}`));
  }
}

export function normalizeWebAppUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    return DEFAULT_WEB_APP_URL;
  }
  return trimmed.replace(/\/+$/, "");
}

function getStringRecordValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid CLI config response: '${field}' must be a non-empty string`);
  }
  return value;
}

function parsePublicCliConfigResponse(payload: unknown): PublicCliConfigResponse {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Invalid CLI config response");
  }

  const record = payload as Record<string, unknown>;
  if (record.version !== 1) {
    throw new Error(`Unsupported CLI config version: ${String(record.version)}`);
  }

  return {
    version: 1,
    webAppUrl: normalizeWebAppUrl(getStringRecordValue(record.webAppUrl, "webAppUrl")),
    workosClientId: getStringRecordValue(record.workosClientId, "workosClientId"),
    deviceAuthScope: getStringRecordValue(record.deviceAuthScope, "deviceAuthScope"),
  };
}

function parseAuthenticatedCliConfigResponse(payload: unknown): AuthenticatedCliConfigResponse {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Invalid authenticated CLI config response");
  }

  const record = payload as Record<string, unknown>;
  if (record.version !== 1) {
    throw new Error(`Unsupported authenticated CLI config version: ${String(record.version)}`);
  }

  return {
    version: 1,
    convexUrl: getStringRecordValue(record.convexUrl, "convexUrl"),
  };
}

async function fetchJson<T>(
  url: string,
  init: RequestInit,
  parser: (payload: unknown) => T,
  errorPrefix: string,
): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${errorPrefix}: ${response.status} ${response.statusText}${body ? ` - ${body}` : ""}`);
  }
  return parser(await response.json());
}

async function fetchPublicCliConfig(webAppUrl: string): Promise<PublicCliConfigResponse> {
  const normalizedUrl = normalizeWebAppUrl(webAppUrl);
  debug("Fetching public CLI config", { webAppUrl: normalizedUrl });
  return await fetchJson(
    `${normalizedUrl}/api/cli/config`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    },
    parsePublicCliConfigResponse,
    "Failed to fetch CLI config",
  );
}

async function fetchAuthenticatedCliConfig(
  webAppUrl: string,
  accessToken: string,
): Promise<AuthenticatedCliConfigResponse> {
  const normalizedUrl = normalizeWebAppUrl(webAppUrl);
  debug("Fetching authenticated CLI config", { webAppUrl: normalizedUrl });
  return await fetchJson(
    `${normalizedUrl}/api/cli/auth/config`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    },
    parseAuthenticatedCliConfigResponse,
    "Failed to fetch authenticated CLI config",
  );
}

/**
 * Get stored authentication credentials (raw, without expiry check)
 */
function getStoredAuthRaw(): StoredAuth | null {
  try {
    const tokenFile = getTokenFilePath();
    if (!fs.existsSync(tokenFile)) {
      debug(`Token file does not exist: ${tokenFile}`);
      return null;
    }
    const data = fs.readFileSync(tokenFile, "utf-8");
    const auth = JSON.parse(data) as StoredAuth;
    debug("Loaded stored auth", {
      hasAccessToken: !!auth.accessToken,
      hasRefreshToken: !!auth.refreshToken,
      expiresAt: auth.expiresAt ? new Date(auth.expiresAt).toISOString() : "not set",
      userId: auth.userId,
      webAppUrl: auth.webAppUrl,
      workosClientId: auth.workosClientId,
      hasConvexUrl: !!auth.convexUrl,
    });
    return auth;
  } catch (error) {
    debug("Failed to read stored auth", error);
    return null;
  }
}

export function getStoredWebAppUrl(): string | null {
  const stored = getStoredAuthRaw();
  return stored?.webAppUrl ? normalizeWebAppUrl(stored.webAppUrl) : null;
}

export function getDefaultWorkspaceSlug(): string | null {
  const stored = getStoredAuthRaw();
  return stored?.defaultWorkspaceSlug?.trim() || null;
}

export function setDefaultWorkspaceSlug(workspaceSlug: string): void {
  const stored = getStoredAuthRaw();
  if (!stored) {
    throw new Error("Not logged in. Run 'tokenspace login' to authenticate.");
  }

  const nextSlug = workspaceSlug.trim();
  if (!nextSlug) {
    throw new Error("Workspace slug is required.");
  }

  storeAuth({
    ...stored,
    defaultWorkspaceSlug: nextSlug,
  });
}

export function resolveLoginWebAppUrl(explicitUrl?: string): string {
  if (explicitUrl) {
    return normalizeWebAppUrl(explicitUrl);
  }

  const storedWebAppUrl = getStoredAuthRaw()?.webAppUrl;
  if (storedWebAppUrl) {
    return normalizeWebAppUrl(storedWebAppUrl);
  }

  return DEFAULT_WEB_APP_URL;
}

function buildStoredAuth(
  accessToken: string,
  refreshToken: string | undefined,
  existing: Partial<StoredAuth> = {},
): StoredAuth {
  const jwtExpiration = getJwtExpiration(accessToken);
  const expiresAt = jwtExpiration || Date.now() + 3600 * 1000;

  debug("buildStoredAuth: extracted JWT expiration", {
    jwtExpiration: jwtExpiration ? new Date(jwtExpiration).toISOString() : "not found",
    usingFallback: !jwtExpiration,
    expiresAt: new Date(expiresAt).toISOString(),
  });

  return {
    accessToken,
    refreshToken,
    expiresAt,
    userId: existing.userId,
    webAppUrl: existing.webAppUrl,
    workosClientId: existing.workosClientId,
    convexUrl: existing.convexUrl,
    deviceAuthScope: existing.deviceAuthScope,
    defaultWorkspaceSlug: existing.defaultWorkspaceSlug,
  };
}

/**
 * Store authentication credentials
 */
function storeAuth(auth: StoredAuth): void {
  const configDir = getConfigDir();
  const tokenFile = getTokenFilePath();

  debug("storeAuth: saving credentials", {
    hasAccessToken: !!auth.accessToken,
    hasRefreshToken: !!auth.refreshToken,
    expiresAt: auth.expiresAt ? new Date(auth.expiresAt).toISOString() : "not set",
    tokenFile,
    webAppUrl: auth.webAppUrl,
    workosClientId: auth.workosClientId,
    hasConvexUrl: !!auth.convexUrl,
  });

  if (!fs.existsSync(configDir)) {
    debug(`storeAuth: creating config directory: ${configDir}`);
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }

  fs.writeFileSync(tokenFile, JSON.stringify(auth, null, 2), { mode: 0o600 });
  debug("storeAuth: credentials saved successfully");
}

function storeAuthFromToken(accessToken: string, refreshToken?: string, existing?: Partial<StoredAuth>): StoredAuth {
  const auth = buildStoredAuth(accessToken, refreshToken, existing);
  storeAuth(auth);
  return auth;
}

/**
 * Clear stored authentication
 */
export function clearAuth(): void {
  const tokenFile = getTokenFilePath();
  if (fs.existsSync(tokenFile)) {
    fs.unlinkSync(tokenFile);
  }
}

/**
 * Check if stored token is expired
 */
export function isTokenExpired(): boolean {
  const auth = getStoredAuthRaw();
  if (!auth) {
    debug("isTokenExpired: no auth stored, returning false");
    return false;
  }

  const now = Date.now();
  const bufferMs = 30 * 1000;
  const jwtExpiration = getJwtExpiration(auth.accessToken);
  if (jwtExpiration) {
    const expired = now > jwtExpiration - bufferMs;
    debug("isTokenExpired check (JWT)", {
      now: new Date(now).toISOString(),
      jwtExpiration: new Date(jwtExpiration).toISOString(),
      expired,
      timeUntilExpiry: `${Math.round((jwtExpiration - now) / 1000)}s`,
    });
    return expired;
  }

  const expiresAtWithBuffer = auth.expiresAt - bufferMs;
  const expired = auth.expiresAt != null && now > expiresAtWithBuffer;
  debug("isTokenExpired check (stored)", {
    now: new Date(now).toISOString(),
    expiresAt: auth.expiresAt ? new Date(auth.expiresAt).toISOString() : "not set",
    expiresAtWithBuffer: auth.expiresAt ? new Date(expiresAtWithBuffer).toISOString() : "not set",
    expired,
    timeUntilExpiry: auth.expiresAt ? `${Math.round((auth.expiresAt - now) / 1000)}s` : "n/a",
  });
  return expired;
}

/**
 * Get stored authentication credentials
 */
export function getStoredAuth(): StoredAuth | null {
  const auth = getStoredAuthRaw();
  if (!auth) {
    debug("getStoredAuth: no raw auth available");
    return null;
  }

  const now = Date.now();
  const bufferMs = 30 * 1000;
  const jwtExpiration = getJwtExpiration(auth.accessToken);
  if (jwtExpiration) {
    if (now > jwtExpiration - bufferMs) {
      debug("getStoredAuth: JWT token expired or expiring soon", {
        now: new Date(now).toISOString(),
        jwtExpiration: new Date(jwtExpiration).toISOString(),
        expiredBy: `${Math.round((now - (jwtExpiration - bufferMs)) / 1000)}s`,
      });
      return null;
    }
    debug("getStoredAuth: JWT expiration valid", {
      jwtExpiration: new Date(jwtExpiration).toISOString(),
      timeRemaining: `${Math.round((jwtExpiration - now) / 1000)}s`,
    });
  } else if (auth.expiresAt && now > auth.expiresAt - bufferMs) {
    debug("getStoredAuth: stored token expired or expiring soon (fallback)", {
      now: new Date(now).toISOString(),
      expiresAt: new Date(auth.expiresAt).toISOString(),
      expiredBy: `${Math.round((now - (auth.expiresAt - bufferMs)) / 1000)}s`,
    });
    return null;
  }

  debug("getStoredAuth: returning valid auth");
  return auth;
}

/**
 * Extract expiration time from JWT token
 * Returns the expiration timestamp in milliseconds, or null if unable to parse
 */
function getJwtExpiration(token: string): number | null {
  try {
    const parts = token.split(".");
    const payloadPart = parts[1];
    if (!payloadPart) return null;

    const payload = JSON.parse(Buffer.from(payloadPart, "base64").toString());
    if (typeof payload.exp === "number") {
      return payload.exp * 1000;
    }
    return null;
  } catch {
    return null;
  }
}

function getCurrentDiscoveryState(auth: StoredAuth, webAppUrlOverride?: string): DiscoveredAuthSettings {
  return {
    webAppUrl: normalizeWebAppUrl(webAppUrlOverride ?? auth.webAppUrl ?? DEFAULT_WEB_APP_URL),
    workosClientId: auth.workosClientId ?? "",
    convexUrl: auth.convexUrl,
    deviceAuthScope: auth.deviceAuthScope ?? DEFAULT_DEVICE_AUTH_SCOPE,
  };
}

export async function ensureStoredAuthDiscovery(options?: {
  accessToken?: string;
  requireConvexUrl?: boolean;
  webAppUrl?: string;
}): Promise<StoredAuth | null> {
  const auth = getStoredAuthRaw();
  if (!auth) {
    return null;
  }

  const current = getCurrentDiscoveryState(auth, options?.webAppUrl);
  let changed = false;
  let resolved: StoredAuth = { ...auth, webAppUrl: current.webAppUrl };

  if (!auth.webAppUrl || normalizeWebAppUrl(auth.webAppUrl) !== current.webAppUrl) {
    changed = true;
  }

  if (!auth.workosClientId || !auth.deviceAuthScope || !auth.webAppUrl || changed) {
    const publicConfig = await fetchPublicCliConfig(current.webAppUrl);
    resolved = {
      ...resolved,
      webAppUrl: publicConfig.webAppUrl,
      workosClientId: publicConfig.workosClientId,
      deviceAuthScope: publicConfig.deviceAuthScope,
    };
    changed = true;
  }

  if (options?.requireConvexUrl && !resolved.convexUrl) {
    const accessToken = options.accessToken ?? resolved.accessToken;
    const authenticatedConfig = await fetchAuthenticatedCliConfig(
      resolved.webAppUrl ?? DEFAULT_WEB_APP_URL,
      accessToken,
    );
    resolved = {
      ...resolved,
      convexUrl: authenticatedConfig.convexUrl,
    };
    changed = true;
  }

  if (changed) {
    storeAuth(resolved);
  }

  return resolved;
}

/**
 * Refresh the access token using the refresh token
 */
async function refreshAccessToken(refreshToken: string, clientId: string): Promise<TokenResponse | null> {
  debug("Attempting token refresh", {
    clientId,
    refreshTokenLength: refreshToken.length,
    refreshTokenPrefix: `${refreshToken.substring(0, 20)}...`,
  });

  try {
    const response = await fetch(`${WORKOS_API_BASE_URL}/user_management/authenticate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    debug("Token refresh response", {
      status: response.status,
      statusText: response.statusText,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      debug("Token refresh failed", {
        status: response.status,
        error: errorBody,
      });
      return null;
    }

    const tokenResponse = (await response.json()) as TokenResponse;
    debug("Token refresh succeeded", {
      hasAccessToken: !!tokenResponse.access_token,
      hasRefreshToken: !!tokenResponse.refresh_token,
      expiresIn: tokenResponse.expires_in,
    });
    return tokenResponse;
  } catch (error) {
    debug("Token refresh threw exception", error);
    return null;
  }
}

/**
 * Try to refresh an expired token
 * Returns true if refresh succeeded, false otherwise
 */
export async function tryRefreshToken(): Promise<boolean> {
  debug("tryRefreshToken: starting");
  const auth = getStoredAuthRaw();
  if (!auth?.refreshToken) {
    debug("tryRefreshToken: no refresh token available", {
      hasAuth: !!auth,
      hasRefreshToken: !!auth?.refreshToken,
    });
    return false;
  }

  let discovered: StoredAuth | null = null;
  try {
    discovered = await ensureStoredAuthDiscovery({
      requireConvexUrl: false,
      webAppUrl: auth.webAppUrl,
    });
  } catch (error) {
    debug("tryRefreshToken: failed to hydrate auth discovery", error);
  }

  const clientId = discovered?.workosClientId ?? auth.workosClientId;
  if (!clientId) {
    debug("tryRefreshToken: no WorkOS client ID available");
    return false;
  }

  debug("tryRefreshToken: calling refreshAccessToken");
  const tokenResponse = await refreshAccessToken(auth.refreshToken, clientId);
  if (!tokenResponse) {
    debug("tryRefreshToken: refresh failed, no token response");
    return false;
  }

  if (!tokenResponse.refresh_token) {
    debug("tryRefreshToken: WARNING - no new refresh token in response, session may not persist");
  }

  debug("tryRefreshToken: storing new tokens", {
    hasNewRefreshToken: !!tokenResponse.refresh_token,
    newRefreshTokenPrefix: tokenResponse.refresh_token ? `${tokenResponse.refresh_token.substring(0, 10)}...` : "none",
  });

  storeAuthFromToken(tokenResponse.access_token, tokenResponse.refresh_token, discovered ?? auth);

  debug("tryRefreshToken: resetting Convex client");
  const { resetClient } = await import("./client.js");
  resetClient();

  debug("tryRefreshToken: refresh succeeded");
  return true;
}

/**
 * Check if user is authenticated
 */
export function isAuthenticated(): boolean {
  return getStoredAuth() !== null;
}

/**
 * Get access token (sync version, no refresh)
 */
export function getAccessToken(): string | null {
  const auth = getStoredAuth();
  return auth?.accessToken ?? null;
}

/**
 * Get access token, attempting refresh if expired
 */
export async function getAccessTokenWithRefresh(): Promise<string | null> {
  debug("getAccessTokenWithRefresh: starting");

  let auth = getStoredAuth();
  if (auth) {
    debug("getAccessTokenWithRefresh: found valid token");
    return auth.accessToken;
  }

  debug("getAccessTokenWithRefresh: no valid token from getStoredAuth");

  const rawAuth = getStoredAuthRaw();
  if (!rawAuth) {
    debug("getAccessTokenWithRefresh: no stored auth at all");
    return null;
  }

  if (rawAuth.refreshToken) {
    debug("getAccessTokenWithRefresh: have refresh token, attempting refresh");
    const refreshed = await tryRefreshToken();
    debug("getAccessTokenWithRefresh: refresh result", { refreshed });
    if (refreshed) {
      auth = getStoredAuth();
      const token = auth?.accessToken ?? null;
      debug("getAccessTokenWithRefresh: got refreshed token", { hasToken: !!token });
      return token;
    }
    debug("getAccessTokenWithRefresh: refresh failed");
  } else {
    debug("getAccessTokenWithRefresh: no refresh token available to refresh with");
  }

  debug("getAccessTokenWithRefresh: returning null (no valid token available)");
  return null;
}

/**
 * Proactively refresh token if it will expire soon
 * @param bufferMinutes - refresh if token expires within this many minutes (default: 2)
 * @returns true if token is valid (refreshed or still valid), false if refresh failed
 */
export async function ensureValidToken(bufferMinutes = 2): Promise<boolean> {
  const auth = getStoredAuthRaw();
  if (!auth) {
    debug("ensureValidToken: no stored auth");
    return false;
  }

  const now = Date.now();
  const bufferMs = bufferMinutes * 60 * 1000;
  const jwtExpiration = getJwtExpiration(auth.accessToken);
  const expiresAt = jwtExpiration || auth.expiresAt;
  const timeUntilExpiry = expiresAt - now;

  debug("ensureValidToken: checking token", {
    expiresAt: new Date(expiresAt).toISOString(),
    usingJwt: !!jwtExpiration,
    timeUntilExpiry: `${Math.round(timeUntilExpiry / 1000)}s`,
    bufferMinutes,
    needsRefresh: timeUntilExpiry < bufferMs,
  });

  if (timeUntilExpiry > bufferMs) {
    return true;
  }

  if (!auth.refreshToken) {
    debug("ensureValidToken: token expiring but no refresh token");
    return false;
  }

  debug("ensureValidToken: proactively refreshing token");
  const refreshed = await tryRefreshToken();

  if (refreshed) {
    debug("ensureValidToken: token refreshed successfully");
  } else {
    debug("ensureValidToken: token refresh failed");
  }

  return refreshed;
}

/**
 * Start device authorization flow
 */
async function startDeviceAuth(clientId: string, scope: string): Promise<DeviceAuthResponse> {
  const response = await fetch(`${WORKOS_API_BASE_URL}/user_management/authorize/device`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      scope,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to start device authorization: ${error}`);
  }

  return (await response.json()) as DeviceAuthResponse;
}

/**
 * Poll for token after user authenticates
 */
async function pollForToken(
  clientId: string,
  deviceCode: string,
  interval: number,
  expiresIn: number,
): Promise<TokenResponse> {
  const startTime = Date.now();
  const expiresAt = startTime + expiresIn * 1000;
  let pollInterval = interval * 1000;

  while (Date.now() < expiresAt) {
    await sleep(pollInterval);

    const response = await fetch(`${WORKOS_API_BASE_URL}/user_management/authenticate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
      }),
    });

    if (response.ok) {
      return (await response.json()) as TokenResponse;
    }

    const error = (await response.json()) as { error?: string; error_description?: string };

    if (error.error === "authorization_pending") {
      continue;
    }

    if (error.error === "slow_down") {
      pollInterval += 5000;
      continue;
    }

    if (error.error === "access_denied") {
      throw new Error("Access denied. User declined authorization.");
    }

    if (error.error === "expired_token") {
      throw new Error("Authorization request expired. Please try again.");
    }

    throw new Error(`Authentication failed: ${error.error_description || error.error}`);
  }

  throw new Error("Authorization request timed out. Please try again.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Login command - starts device authorization flow
 */
export async function login(explicitUrl?: string): Promise<void> {
  const existingAuth = getStoredAuthRaw();
  const targetWebAppUrl = resolveLoginWebAppUrl(explicitUrl);
  const existingWebAppUrl = existingAuth?.webAppUrl ? normalizeWebAppUrl(existingAuth.webAppUrl) : null;
  const explicitTargetRequested = explicitUrl !== undefined;
  const switchingTargets =
    explicitTargetRequested && existingWebAppUrl !== null && existingWebAppUrl !== targetWebAppUrl;

  if (isAuthenticated() && !explicitTargetRequested) {
    console.log(pc.yellow(`You are already logged in to ${pc.bold(existingWebAppUrl ?? targetWebAppUrl)}.`));
    return;
  }

  if (switchingTargets) {
    console.log(pc.cyan(`Switching authentication target to ${pc.bold(targetWebAppUrl)}...\n`));
  } else {
    console.log(pc.cyan(`Starting authentication against ${pc.bold(targetWebAppUrl)}...\n`));
  }

  try {
    const publicConfig = await fetchPublicCliConfig(targetWebAppUrl);
    const deviceAuth = await startDeviceAuth(publicConfig.workosClientId, publicConfig.deviceAuthScope);

    console.log(pc.bold("To sign in, please visit:"));
    console.log(pc.cyan(`  ${deviceAuth.verification_uri}\n`));
    console.log(pc.bold("And enter the code:"));
    console.log(pc.green(pc.bold(`  ${deviceAuth.user_code}\n`)));
    console.log(pc.dim(`Or visit: ${deviceAuth.verification_uri_complete}\n`));

    const openCommand = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";

    try {
      const { exec } = await import("node:child_process");
      exec(`${openCommand} "${deviceAuth.verification_uri_complete}"`);
      console.log(pc.dim("Opening browser...\n"));
    } catch {
      // Ignore errors opening browser
    }

    console.log(pc.dim("Waiting for authentication..."));

    const tokenResponse = await pollForToken(
      publicConfig.workosClientId,
      deviceAuth.device_code,
      deviceAuth.interval,
      deviceAuth.expires_in,
    );

    debug("login: storing tokens", {
      hasAccessToken: !!tokenResponse.access_token,
      hasRefreshToken: !!tokenResponse.refresh_token,
      webAppUrl: publicConfig.webAppUrl,
      workosClientId: publicConfig.workosClientId,
    });

    if (!tokenResponse.refresh_token) {
      console.log(
        pc.yellow("\nWarning: No refresh token received. You may need to re-login when your session expires."),
      );
    }

    const authenticatedConfig = await fetchAuthenticatedCliConfig(publicConfig.webAppUrl, tokenResponse.access_token);

    storeAuthFromToken(tokenResponse.access_token, tokenResponse.refresh_token, {
      userId: existingAuth?.userId,
      webAppUrl: publicConfig.webAppUrl,
      workosClientId: publicConfig.workosClientId,
      convexUrl: authenticatedConfig.convexUrl,
      deviceAuthScope: publicConfig.deviceAuthScope,
    });

    const { resetClient } = await import("./client.js");
    resetClient();

    console.log(pc.green(`\n✓ Successfully logged in to ${pc.bold(publicConfig.webAppUrl)}!`));
  } catch (error) {
    console.error(pc.red(`\nLogin failed: ${error instanceof Error ? error.message : error}`));
    process.exit(1);
  }
}

/**
 * Logout command - clears stored credentials
 */
export async function logout(): Promise<void> {
  if (!getStoredAuthRaw()) {
    console.log(pc.yellow("You are not logged in."));
    return;
  }

  clearAuth();
  console.log(pc.green("✓ Successfully logged out."));
}

/**
 * Ensure user is authenticated, exit if not
 */
export async function requireAuth(): Promise<string> {
  debug("requireAuth: checking authentication");

  const token = await getAccessTokenWithRefresh();
  if (token) {
    debug("requireAuth: got valid token");
    return token;
  }

  debug("requireAuth: no valid token obtained");

  const rawAuth = getStoredAuthRaw();
  if (rawAuth) {
    console.error(pc.red("Error: Session expired and refresh failed. Run 'tokenspace login' to re-authenticate."));
  } else {
    console.error(pc.red("Error: Not authenticated. Run 'tokenspace login' first."));
  }
  process.exit(1);
}
