import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Readable } from "node:stream";

let linkedWorkspaceRoot: string | null;
let linkedWorkspaceConfig: { version: 1; workspaceSlug: string } | null;
let workspace: any;
let defaultBranch: any;
let workingStateHash: string | null;
let revisionId: string | null;
let credentialRequirements: any[];
let workspaceBindings: any[];
let workspaceBindingsError: Error | null;
let promptSecretValue: string;
let promptSecretCalls: string[];
let upsertCalls: Array<{ credentialId: string; revisionId: string; value: string; workspaceId: string }>;
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

const logMock = mock((..._args: unknown[]) => {});
const errorMock = mock((..._args: unknown[]) => {});

mock.module("../client.js", () => ({
  exitWithError: (message: string): never => {
    throw new Error(`EXIT:${message}`);
  },
  getCredentialRequirementsForRevision: async (_revisionId: string) => credentialRequirements,
  getCurrentWorkingStateHash: async (_workspaceId: string, _branchId: string) => workingStateHash,
  getDefaultBranch: async (_workspaceId: string) => defaultBranch,
  getWorkspaceBySlug: async (_slug: string) => workspace,
  getWorkspaceRevision: async (_workspaceId: string, _branchId: string, _workingStateHash?: string) => revisionId,
  listWorkspaceCredentialBindings: async (_workspaceId: string) => {
    if (workspaceBindingsError) {
      throw workspaceBindingsError;
    }
    return workspaceBindings;
  },
  upsertWorkspaceSecretCredential: async (
    workspaceIdArg: string,
    revisionIdArg: string,
    credentialIdArg: string,
    valueArg: string,
  ) => {
    upsertCalls.push({
      workspaceId: workspaceIdArg,
      revisionId: revisionIdArg,
      credentialId: credentialIdArg,
      value: valueArg,
    });
    return "cred_value_1";
  },
}));

mock.module("../local-workspace.js", () => ({
  findNearestLinkedWorkspaceRoot: async (_cwd: string) => linkedWorkspaceRoot,
  printWorkspaceResolution: (label: string, dir: string) => {
    console.log(`RESOLVE ${label}: ${dir}`);
  },
  readLinkedWorkspaceConfig: async (_workspaceDir: string) => linkedWorkspaceConfig,
}));

mock.module("../prompts.js", () => ({
  promptSecret: async (question: string) => {
    promptSecretCalls.push(question);
    return promptSecretValue;
  },
}));

const {
  listCredentials,
  partitionCredentialRequirements,
  readSecretFromStdin,
  resolveSettableWorkspaceSecretRequirement,
  setWorkspaceCredential,
  stripSingleTrailingNewline,
} = await import("./credentials");

function stripAnsi(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape sequence matching
  return value.replace(/\x1B\[[0-9;]*m/g, "");
}

function getConsoleText(spy: typeof logMock): string {
  return stripAnsi(
    spy.mock.calls
      .map((call) => call.map((entry) => (typeof entry === "string" ? entry : String(entry))).join(" "))
      .join("\n"),
  );
}

beforeEach(() => {
  linkedWorkspaceRoot = "/tmp/demo";
  linkedWorkspaceConfig = {
    version: 1,
    workspaceSlug: "demo-workspace",
  };
  workspace = {
    _id: "ws_1",
    name: "Demo Workspace",
    slug: "demo-workspace",
    role: "workspace_admin",
    createdAt: 1,
    updatedAt: 2,
  };
  defaultBranch = {
    _id: "branch_1",
    workspaceId: "ws_1",
    name: "main",
    commitId: "commit_1",
    isDefault: true,
  };
  workingStateHash = "working_hash";
  revisionId = "revision_1";
  credentialRequirements = [];
  workspaceBindings = [];
  workspaceBindingsError = null;
  promptSecretValue = "super-secret";
  promptSecretCalls = [];
  upsertCalls = [];
  logMock.mockClear();
  errorMock.mockClear();
  console.log = logMock as typeof console.log;
  console.error = errorMock as typeof console.error;
});

afterEach(() => {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
});

describe("credentials helpers", () => {
  it("partitions requirements by workspace vs runtime scope", () => {
    const result = partitionCredentialRequirements([
      { id: "user-secret", kind: "secret", scope: "user", label: "User Secret" },
      { id: "workspace-secret", kind: "secret", scope: "workspace", label: "Workspace Secret" },
      { id: "workspace-env", kind: "env", scope: "workspace", label: "Workspace Env" },
    ] as any);

    expect(result.workspace.map((entry) => entry.id)).toEqual(["workspace-env", "workspace-secret"]);
    expect(result.runtime.map((entry) => entry.id)).toEqual(["user-secret"]);
  });

  it("rejects non-settable requirements with explicit reasons", () => {
    const oauthResult = resolveSettableWorkspaceSecretRequirement(
      [{ id: "oauth", label: "OAuth", kind: "oauth", scope: "workspace" }] as any,
      "oauth",
    );
    expect(oauthResult).toEqual({
      ok: false,
      error: 'Credential "OAuth" is an OAuth credential. OAuth connect is list-only in CLI v1.',
    });

    const runtimeResult = resolveSettableWorkspaceSecretRequirement(
      [{ id: "runtime", label: "Runtime", kind: "secret", scope: "user" }] as any,
      "runtime",
    );
    expect(runtimeResult).toEqual({
      ok: false,
      error:
        'Credential "Runtime" has scope "user". Only workspace-scoped secret credentials can be set with this command.',
    });
  });

  it("strips only one trailing newline from stdin input", () => {
    expect(stripSingleTrailingNewline("secret\n")).toBe("secret");
    expect(stripSingleTrailingNewline("secret\r\n")).toBe("secret");
    expect(stripSingleTrailingNewline("secret\n\n")).toBe("secret\n");
  });

  it("reads secret values from stdin streams", async () => {
    const value = await readSecretFromStdin(Readable.from(["top-secret\n"]));
    expect(value).toBe("top-secret");
  });
});

describe("credentials list", () => {
  it("lists mixed credential requirements with configured status", async () => {
    credentialRequirements = [
      {
        id: "db-secret",
        label: "Database Secret",
        group: "Core",
        kind: "secret",
        scope: "workspace",
        description: "Used for primary database access.",
      },
      {
        id: "github-oauth",
        label: "GitHub OAuth",
        group: "Core",
        kind: "oauth",
        scope: "workspace",
        config: { grantType: "authorization_code" },
      },
      {
        id: "executor-token",
        label: "Executor Token",
        kind: "env",
        scope: "workspace",
        config: { variableName: "EXECUTOR_TOKEN" },
      },
      {
        id: "session-secret",
        label: "Session Secret",
        kind: "secret",
        scope: "session",
      },
    ];
    workspaceBindings = [
      {
        _id: "binding_1",
        workspaceId: "ws_1",
        credentialId: "db-secret",
        scope: "workspace",
        subject: "__workspace__",
        kind: "secret",
        keyVersion: 1,
        createdAt: 1,
        updatedAt: 1_700_000_000_000,
      },
    ];

    await listCredentials();

    const output = getConsoleText(logMock);
    expect(output).toContain("Listing credentials for demo-workspace");
    expect(output).toContain("Workspace Credentials");
    expect(output).toContain("Core");
    expect(output).toContain("Database Secret (db-secret)");
    expect(output).toContain("workspace/secret");
    expect(output).toContain("Status: configured");
    expect(output).toContain("GitHub OAuth (github-oauth)");
    expect(output).toContain("Grant type: authorization_code");
    expect(output).toContain("OAuth credentials are list-only in CLI v1.");
    expect(output).toContain("Executor Token (executor-token)");
    expect(output).toContain("Environment variable: EXECUTOR_TOKEN");
    expect(output).toContain("Runtime-Scoped Credentials");
    expect(output).toContain("Session Secret (session-secret)");
    expect(output).toContain("Configured at runtime in chat/playground; CLI set is not supported in v1.");
  });

  it("fails when no linked workspace exists", async () => {
    linkedWorkspaceRoot = null;

    await expect(listCredentials()).rejects.toThrow("EXIT:No linked tokenspace found. Run `tokenspace link` first.");
  });

  it("fails when no compiled revision exists", async () => {
    revisionId = null;

    await expect(listCredentials()).rejects.toThrow(
      "EXIT:No compiled revision found for 'demo-workspace'. Run `tokenspace push` first.",
    );
  });

  it("degrades to requirements-only output when workspace bindings are unauthorized", async () => {
    credentialRequirements = [
      {
        id: "db-secret",
        label: "Database Secret",
        kind: "secret",
        scope: "workspace",
      },
    ];
    workspaceBindingsError = new Error("Unauthorized");

    await listCredentials();

    const output = getConsoleText(logMock);
    expect(output).toContain("Database Secret (db-secret)");
    expect(output).toContain("Status: unavailable (workspace admin access required)");
  });
});

describe("credentials set", () => {
  it("saves a workspace secret credential", async () => {
    credentialRequirements = [
      {
        id: "db-secret",
        label: "Database Secret",
        kind: "secret",
        scope: "workspace",
      },
    ];

    await setWorkspaceCredential("db-secret", {});

    expect(promptSecretCalls).toHaveLength(1);
    expect(upsertCalls).toEqual([
      {
        workspaceId: "ws_1",
        revisionId: "revision_1",
        credentialId: "db-secret",
        value: "super-secret",
      },
    ]);
    expect(getConsoleText(logMock)).toContain("Saved workspace secret Database Secret (db-secret)");
  });

  it("reads secret input from stdin without prompting", async () => {
    credentialRequirements = [
      {
        id: "db-secret",
        label: "Database Secret",
        kind: "secret",
        scope: "workspace",
      },
    ];

    await setWorkspaceCredential("db-secret", { stdin: true }, { stdin: Readable.from(["from-stdin\n"]) });

    expect(promptSecretCalls).toHaveLength(0);
    expect(upsertCalls[0]).toEqual({
      workspaceId: "ws_1",
      revisionId: "revision_1",
      credentialId: "db-secret",
      value: "from-stdin",
    });
  });

  it("rejects workspace oauth, env, and runtime-scoped credentials", async () => {
    credentialRequirements = [
      {
        id: "oauth-secret",
        label: "OAuth Secret",
        kind: "oauth",
        scope: "workspace",
      },
      {
        id: "env-secret",
        label: "Env Secret",
        kind: "env",
        scope: "workspace",
      },
      {
        id: "runtime-secret",
        label: "Runtime Secret",
        kind: "secret",
        scope: "user",
      },
    ];

    await expect(setWorkspaceCredential("oauth-secret", {})).rejects.toThrow(
      'EXIT:Credential "OAuth Secret" is an OAuth credential. OAuth connect is list-only in CLI v1.',
    );
    await expect(setWorkspaceCredential("env-secret", {})).rejects.toThrow(
      'EXIT:Credential "Env Secret" is an env credential. Env credentials are provided by executor environment variables and cannot be set with this CLI command.',
    );
    await expect(setWorkspaceCredential("runtime-secret", {})).rejects.toThrow(
      'EXIT:Credential "Runtime Secret" has scope "user". Only workspace-scoped secret credentials can be set with this command.',
    );
  });

  it("fails when the credential id is not declared", async () => {
    credentialRequirements = [
      {
        id: "workspace-secret",
        kind: "secret",
        scope: "workspace",
      },
    ];

    await expect(setWorkspaceCredential("missing-secret", {})).rejects.toThrow(
      'EXIT:Credential "missing-secret" is not declared in the current revision. Available workspace secret credentials: workspace-secret',
    );
  });
});
