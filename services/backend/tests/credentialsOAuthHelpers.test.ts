import { describe, expect, it } from "bun:test";
import { isOAuthCredentialExpired, redactCredentialRequirementForClient } from "../convex/credentials";

describe("oauth credential helpers", () => {
  it("redacts oauth clientSecret from client-facing requirements", () => {
    const requirement = {
      path: "src/credentials.ts",
      exportName: "githubOauth",
      id: "github-oauth",
      label: "GitHub OAuth",
      group: "GitHub",
      kind: "oauth" as const,
      scope: "workspace" as const,
      config: {
        grantType: "authorization_code",
        clientId: "abc123",
        clientSecret: "github-client-secret",
        authorizeUrl: "https://github.com/login/oauth/authorize",
        tokenUrl: "https://github.com/login/oauth/access_token",
        scopes: ["repo"],
      },
    };

    const redacted = redactCredentialRequirementForClient(requirement);
    expect(redacted.config).toEqual({
      grantType: "authorization_code",
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: ["repo"],
    });
    expect((redacted.config as Record<string, unknown>).clientId).toBeUndefined();
    expect((redacted.config as Record<string, unknown>).clientSecret).toBeUndefined();
  });

  it("marks oauth payload as expired only when expiresAt is in the past", () => {
    const now = Date.now();
    expect(
      isOAuthCredentialExpired(
        {
          accessToken: "token",
          expiresAt: now - 1,
        },
        now,
      ),
    ).toBe(true);
    expect(
      isOAuthCredentialExpired(
        {
          accessToken: "token",
          expiresAt: now + 1_000,
        },
        now,
      ),
    ).toBe(false);
    expect(
      isOAuthCredentialExpired(
        {
          accessToken: "token",
        },
        now,
      ),
    ).toBe(false);
  });
});
