import { describe, expect, it } from "bun:test";
import { createCredentialStore, createUserStore } from "./exec";

describe("executor execution helpers", () => {
  it("reads the current instance token for each credential lookup", async () => {
    let currentToken = "instance-token-1";
    const seenTokens: string[] = [];
    const credentialStore = createCredentialStore(
      {
        query: async (_ref: unknown, args: Record<string, unknown>) => {
          seenTokens.push(String(args.instanceToken));
          return "resolved";
        },
      } as any,
      {
        jobId: "job_1" as any,
        getInstanceToken: () => currentToken,
      },
    );

    expect((await credentialStore.load("credential-1" as any)) as any).toBe("resolved");
    currentToken = "instance-token-2";
    expect((await credentialStore.load("credential-1" as any)) as any).toBe("resolved");
    expect(seenTokens).toEqual(["instance-token-1", "instance-token-2"]);
  });

  it("reads the current instance token for each user lookup", async () => {
    let currentToken = "instance-token-1";
    const seenTokens: string[] = [];
    const userStore = createUserStore(
      {
        action: async (_ref: unknown, args: Record<string, unknown>) => {
          seenTokens.push(String(args.instanceToken));
          return { id: "user_1" };
        },
      } as any,
      {
        jobId: "job_1" as any,
        getInstanceToken: () => currentToken,
      },
    );

    await userStore.getCurrentUserInfo();
    currentToken = "instance-token-2";
    await userStore.getInfo({ id: "user_1" });

    expect(seenTokens).toEqual(["instance-token-1", "instance-token-2"]);
  });
});
