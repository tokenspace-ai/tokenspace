import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_WEB_APP_URL, ensureStoredAuthDiscovery, resolveLoginWebAppUrl, tryRefreshToken } from "./auth.js";

type FetchInput = string | URL | Request;

function createJwt(expirationOffsetSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + expirationOffsetSeconds,
      sub: "user_123",
    }),
  ).toString("base64url");
  return `${header}.${payload}.signature`;
}

async function writeAuthFile(configDir: string, auth: Record<string, unknown>): Promise<void> {
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, "auth.json"), `${JSON.stringify(auth, null, 2)}\n`, "utf8");
}

describe("auth discovery helpers", () => {
  let configDir: string;
  let originalFetch: typeof globalThis.fetch;
  let originalConfigDir: string | undefined;

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(tmpdir(), "tokenspace-cli-auth-"));
    originalConfigDir = process.env.TOKENSPACE_CONFIG_DIR;
    process.env.TOKENSPACE_CONFIG_DIR = configDir;
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (originalConfigDir === undefined) {
      delete process.env.TOKENSPACE_CONFIG_DIR;
    } else {
      process.env.TOKENSPACE_CONFIG_DIR = originalConfigDir;
    }
    await rm(configDir, { recursive: true, force: true });
  });

  it("resolves login target from explicit url, stored url, then default", async () => {
    expect(resolveLoginWebAppUrl()).toBe(DEFAULT_WEB_APP_URL);

    await writeAuthFile(configDir, {
      accessToken: createJwt(3600),
      expiresAt: Date.now() + 3600_000,
      webAppUrl: "http://localhost:31337/",
    });

    expect(resolveLoginWebAppUrl()).toBe("http://localhost:31337");
    expect(resolveLoginWebAppUrl("http://localhost:9999/")).toBe("http://localhost:9999");
  });

  it("upgrades older auth files with discovered settings", async () => {
    const accessToken = createJwt(3600);
    await writeAuthFile(configDir, {
      accessToken,
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 3600_000,
    });

    globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === `${DEFAULT_WEB_APP_URL}/api/cli/config`) {
        return Response.json({
          version: 1,
          webAppUrl: DEFAULT_WEB_APP_URL,
          workosClientId: "client_discovered",
          deviceAuthScope: "openid profile email",
        });
      }
      if (url === `${DEFAULT_WEB_APP_URL}/api/cli/auth/config`) {
        expect(init?.headers).toMatchObject({
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
        });
        return Response.json({
          version: 1,
          convexUrl: "https://tokenspace.convex.cloud",
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const auth = await ensureStoredAuthDiscovery({ requireConvexUrl: true });
    expect(auth?.webAppUrl).toBe(DEFAULT_WEB_APP_URL);
    expect(auth?.workosClientId).toBe("client_discovered");
    expect(auth?.convexUrl).toBe("https://tokenspace.convex.cloud");
    expect(auth?.deviceAuthScope).toBe("openid profile email");

    const stored = JSON.parse(await readFile(path.join(configDir, "auth.json"), "utf8")) as Record<string, string>;
    expect(stored.webAppUrl).toBe(DEFAULT_WEB_APP_URL);
    expect(stored.workosClientId).toBe("client_discovered");
    expect(stored.convexUrl).toBe("https://tokenspace.convex.cloud");
    expect(stored.deviceAuthScope).toBe("openid profile email");
  });

  it("refreshes tokens with the stored WorkOS client ID", async () => {
    await writeAuthFile(configDir, {
      accessToken: createJwt(-3600),
      refreshToken: "refresh-token",
      expiresAt: Date.now() - 3600_000,
      webAppUrl: DEFAULT_WEB_APP_URL,
      workosClientId: "client_stored",
      convexUrl: "https://tokenspace.convex.cloud",
      deviceAuthScope: "openid profile email",
    });

    let refreshClientId: string | undefined;
    globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://api.workos.com/user_management/authenticate") {
        const body = JSON.parse(String(init?.body)) as { client_id: string; grant_type: string };
        refreshClientId = body.client_id;
        expect(body.grant_type).toBe("refresh_token");
        return Response.json({
          access_token: createJwt(3600),
          refresh_token: "refresh-token-2",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const refreshed = await tryRefreshToken();
    expect(refreshed).toBe(true);
    expect(refreshClientId).toBe("client_stored");

    const stored = JSON.parse(await readFile(path.join(configDir, "auth.json"), "utf8")) as Record<string, string>;
    expect(stored.workosClientId).toBe("client_stored");
    expect(stored.refreshToken).toBe("refresh-token-2");
  });
});
