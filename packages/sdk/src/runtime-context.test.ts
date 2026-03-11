import { describe, expect, test } from "bun:test";
import { hasApproval } from "./approvals";
import { type CredentialStore, getCredential, secret } from "./credentials";
import { getExecutionContext, runWithExecutionContext } from "./runtime-context";

describe("@tokenspace/sdk runtime context", () => {
  test("preserves execution-scoped state across await boundaries", async () => {
    const demoSecret = secret({
      id: "demo-secret",
      scope: "workspace",
    });

    const credentialStore: CredentialStore = {
      load: async () => "scoped-value" as never,
    };

    const value = await runWithExecutionContext(
      {
        credentialStore,
        approvals: [{ action: "demo:allowed" }],
      },
      async () => {
        await Bun.sleep(0);

        expect(getExecutionContext()).toBeDefined();
        expect(hasApproval({ action: "demo:allowed" })).toBe(true);

        return await getCredential(demoSecret);
      },
    );

    expect(value).toBe("scoped-value");
  });
});
