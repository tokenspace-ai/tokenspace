import { describe, expect, test } from "bun:test";
import { hasApproval } from "./approvals";
import type { TokenspaceFilesystem } from "./builtin-types";
import { type CredentialStore, getCredential, secret } from "./credentials";
import { getExecutionContext, runWithExecutionContext } from "./runtime-context";
import { getSessionFilesystem, SessionFilesystemNotInitializedError } from "./session-filesystem";
import type { UserStore } from "./users";
import { getCurrentUserInfo } from "./users";

describe("@tokenspace/sdk runtime context", () => {
  test("preserves execution-scoped state across await boundaries", async () => {
    const demoSecret = secret({
      id: "demo-secret",
      scope: "workspace",
    });

    const credentialStore: CredentialStore = {
      load: async () => "scoped-value" as never,
    };
    const userStore: UserStore = {
      getCurrentUserInfo: async () => ({ id: "user-1", email: "user@example.com" }),
      getInfo: async () => null,
    };
    const filesystem: TokenspaceFilesystem = {
      list: async () => [],
      stat: async () => ({ isDirectory: false, isFile: true, size: 0 }),
      read: async () => new ArrayBuffer(0),
      readText: async () => "scoped-file",
      write: async () => {},
      delete: async () => {},
    };

    const value = await runWithExecutionContext(
      {
        credentialStore,
        userStore,
        approvals: [{ action: "demo:allowed" }],
        filesystem,
      },
      async () => {
        await Bun.sleep(0);

        expect(getExecutionContext()).toBeDefined();
        expect(hasApproval({ action: "demo:allowed" })).toBe(true);
        expect(getSessionFilesystem()).toBe(filesystem);
        expect(await getCurrentUserInfo()).toEqual({ id: "user-1", email: "user@example.com" });

        return await getCredential(demoSecret);
      },
    );

    expect(value).toBe("scoped-value");
  });

  test("throws when session filesystem is accessed without runtime context", () => {
    expect(() => getSessionFilesystem()).toThrow(SessionFilesystemNotInitializedError);
  });
});
