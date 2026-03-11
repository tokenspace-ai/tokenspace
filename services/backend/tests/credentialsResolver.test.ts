import { describe, expect, it } from "bun:test";
import { buildMissingCredentialPayload, resolveEnvCredentialValue } from "../convex/credentials";

describe("credentials resolver helpers", () => {
  it("returns environment credential when present", () => {
    const previous = process.env.MY_TEST_ENV_CREDENTIAL;
    process.env.MY_TEST_ENV_CREDENTIAL = "abc123";
    try {
      const value = resolveEnvCredentialValue({
        variableName: "MY_TEST_ENV_CREDENTIAL",
        credentialId: "env-credential",
        scope: "workspace",
      });
      expect(value).toBe("abc123");
    } finally {
      if (previous === undefined) {
        delete process.env.MY_TEST_ENV_CREDENTIAL;
      } else {
        process.env.MY_TEST_ENV_CREDENTIAL = previous;
      }
    }
  });

  it("returns undefined when optional env credential is missing", () => {
    const previous = process.env.MY_TEST_ENV_CREDENTIAL_MISSING;
    delete process.env.MY_TEST_ENV_CREDENTIAL_MISSING;
    try {
      const value = resolveEnvCredentialValue({
        variableName: "MY_TEST_ENV_CREDENTIAL_MISSING",
        optional: true,
        credentialId: "env-credential",
        scope: "workspace",
      });
      expect(value).toBeUndefined();
    } finally {
      if (previous !== undefined) {
        process.env.MY_TEST_ENV_CREDENTIAL_MISSING = previous;
      }
    }
  });

  it("throws structured missing payload when required env credential is missing", () => {
    const previous = process.env.MY_TEST_ENV_CREDENTIAL_REQUIRED;
    delete process.env.MY_TEST_ENV_CREDENTIAL_REQUIRED;
    try {
      expect(() =>
        resolveEnvCredentialValue({
          variableName: "MY_TEST_ENV_CREDENTIAL_REQUIRED",
          optional: false,
          credentialId: "required-env",
          scope: "workspace",
          credentialLabel: "required-env",
        }),
      ).toThrow();

      let payload: unknown;
      try {
        resolveEnvCredentialValue({
          variableName: "MY_TEST_ENV_CREDENTIAL_REQUIRED",
          optional: false,
          credentialId: "required-env",
          scope: "workspace",
          credentialLabel: "required-env",
        });
      } catch (error) {
        payload = (error as { data?: unknown }).data;
      }

      expect(payload).toEqual(
        buildMissingCredentialPayload({
          credentialId: "required-env",
          credentialLabel: "required-env",
          kind: "env",
          scope: "workspace",
          reason: "missing",
          details: "Environment variable MY_TEST_ENV_CREDENTIAL_REQUIRED is not set",
        }),
      );
    } finally {
      if (previous !== undefined) {
        process.env.MY_TEST_ENV_CREDENTIAL_REQUIRED = previous;
      }
    }
  });
});
