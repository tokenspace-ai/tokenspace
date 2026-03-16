import { beforeEach, describe, expect, it } from "bun:test";
import {
  clearTypeScriptSandboxCache,
  compileTypeScriptForExecution,
  createCredentialStore,
  createUserStore,
  executeCode,
} from "./exec";

describe("executor execution helpers", () => {
  beforeEach(() => {
    clearTypeScriptSandboxCache();
  });

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

  it("caches the TypeScript sandbox by revision", async () => {
    let actionCalls = 0;
    const convex = {
      action: async () => {
        actionCalls += 1;
        return { builtins: "", sandboxApis: [] };
      },
    } as any;

    await compileTypeScriptForExecution("const value: number = 1;\nconsole.log(value);", convex, {
      revisionId: "revision_1",
      getInstanceToken: () => "instance-token-1",
    });
    await compileTypeScriptForExecution("const value: number = 2;\nconsole.log(value);", convex, {
      revisionId: "revision_1",
      getInstanceToken: () => "instance-token-1",
    });

    expect(actionCalls).toBe(1);
  });

  it("reports TypeScript diagnostics before execution", async () => {
    const convex = {
      action: async () => ({ builtins: "", sandboxApis: [] }),
    } as any;

    await expect(
      compileTypeScriptForExecution("const value: string = 123;", convex, {
        revisionId: "revision_1",
        getInstanceToken: () => "instance-token-1",
      }),
    ).rejects.toThrow(/TypeScript compilation failed/);
  });

  it("compiles raw TypeScript before executing it", async () => {
    const convex = {
      action: async () => ({ builtins: "", sandboxApis: [] }),
    } as any;

    const result = await executeCode(
      `
const value: number = await Promise.resolve(7);
console.log("value", value);
`,
      convex,
      {
        language: "typescript",
        revisionId: "revision_1",
        getInstanceToken: () => "instance-token-1",
      },
    );

    expect(result.output).toContain("value 7");
  });
});
