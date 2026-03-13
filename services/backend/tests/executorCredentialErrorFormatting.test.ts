import { describe, expect, it } from "bun:test";

process.env.WORKOS_CLIENT_ID ??= "test-client-id";

const { formatCredentialMissingErrorForTool } = await import("../convex/executor");

function buildCredentialError(reason: "missing" | "expired" | "revoked" | "non_interactive") {
  return {
    message: "Credential unavailable",
    details: "test-details",
    data: {
      errorType: "CREDENTIAL_MISSING",
      credential: {
        id: "my-credential",
        label: "My Credential",
        kind: "secret",
        scope: "user",
        reason,
      },
      details: "payload-details",
    },
  } as const;
}

describe("credential tool error formatting", () => {
  it("formats missing credential errors with setup guidance", () => {
    const formatted = formatCredentialMissingErrorForTool(buildCredentialError("missing"));
    expect(formatted).toContain("CREDENTIAL_MISSING");
    expect(formatted).toContain("Credential: My Credential (user/secret)");
    expect(formatted).toContain("Reason: missing");
    expect(formatted).toContain("Credential ID: my-credential");
    expect(formatted).toContain('Configure "My Credential" for scope "user" and retry.');
    expect(formatted).toContain("Details: test-details");
  });

  it("formats non-interactive credential errors with context guidance", () => {
    const formatted = formatCredentialMissingErrorForTool(buildCredentialError("non_interactive"));
    expect(formatted).toContain("Reason: non_interactive");
    expect(formatted).toContain("cannot resolve user/session-scoped credentials");
  });

  it("formats expired and revoked credential errors with refresh guidance", () => {
    const expired = formatCredentialMissingErrorForTool(buildCredentialError("expired"));
    const revoked = formatCredentialMissingErrorForTool(buildCredentialError("revoked"));
    expect(expired).toContain('Refresh or reconnect "My Credential" and retry.');
    expect(revoked).toContain('Reconnect or reauthorize "My Credential" and retry.');
  });

  it("falls back to generic formatting when payload is not credential-missing", () => {
    const formatted = formatCredentialMissingErrorForTool({
      message: "Something broke",
      details: "generic-details",
      data: { errorType: "OTHER_ERROR" },
    });
    expect(formatted).toContain("Code execution failed:");
    expect(formatted).toContain("Something broke");
    expect(formatted).toContain("generic-details");
  });
});
