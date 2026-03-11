import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_WEB_APP_URL } from "./auth.js";
import { getClient, resetClient } from "./client.js";

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

describe("Convex client bootstrap", () => {
  let configDir: string;
  let originalFetch: typeof globalThis.fetch;
  let originalConfigDir: string | undefined;

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(tmpdir(), "tokenspace-cli-client-"));
    originalConfigDir = process.env.TOKENSPACE_CONFIG_DIR;
    process.env.TOKENSPACE_CONFIG_DIR = configDir;
    originalFetch = globalThis.fetch;
    resetClient();
    await mkdir(configDir, { recursive: true });
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    resetClient();
    if (originalConfigDir === undefined) {
      delete process.env.TOKENSPACE_CONFIG_DIR;
    } else {
      process.env.TOKENSPACE_CONFIG_DIR = originalConfigDir;
    }
    await rm(configDir, { recursive: true, force: true });
  });

  it("hydrates a missing convex url from stored auth settings", async () => {
    const accessToken = createJwt(3600);
    await writeFile(
      path.join(configDir, "auth.json"),
      `${JSON.stringify(
        {
          accessToken,
          refreshToken: "refresh-token",
          expiresAt: Date.now() + 3600_000,
          webAppUrl: DEFAULT_WEB_APP_URL,
          workosClientId: "client_stored",
          deviceAuthScope: "openid profile email",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === `${DEFAULT_WEB_APP_URL}/api/cli/auth/config`) {
        expect(init?.headers).toMatchObject({
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
        });
        return Response.json({
          version: 1,
          convexUrl: "https://discovered.convex.cloud",
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const client = await getClient();
    expect(client.url).toBe("https://discovered.convex.cloud");

    const stored = JSON.parse(await readFile(path.join(configDir, "auth.json"), "utf8")) as Record<string, string>;
    expect(stored.convexUrl).toBe("https://discovered.convex.cloud");
  });
});
