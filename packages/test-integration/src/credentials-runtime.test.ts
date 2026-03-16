import { beforeAll, describe, expect, it } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getSharedHarness, waitForSetup } from "./setup";
import {
  enqueueAndWaitForRevision,
  getFunctionName,
  internal,
  readFilesRecursively,
  TEST_ENV_CREDENTIAL_NAME,
  TEST_ENV_CREDENTIAL_VALUE,
  waitForJobCompletion,
} from "./test-utils";

const REPO_ROOT = path.join(import.meta.dir, "../../..");
const EXAMPLE_SOURCE = path.join(REPO_ROOT, "examples/testing");
const WORKSPACE_CREDENTIAL_SUBJECT = "__workspace__";

type SeededWorkspace = {
  workspaceId: string;
  branchId: string;
  revisionId: string;
};

function createWorkspaceSlug(): string {
  return `credentials-runtime-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seedCredentialWorkspace(slug: string): Promise<SeededWorkspace> {
  const harness = getSharedHarness();
  const backend = harness.getBackend();
  const workspaceDir = await mkdtemp(path.join(tmpdir(), "tokenspace-credentials-workspace-"));

  try {
    await cp(EXAMPLE_SOURCE, workspaceDir, { recursive: true, dereference: true });
    const packageJsonPath = path.join(workspaceDir, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    packageJson.dependencies = {
      ...(packageJson.dependencies ?? {}),
      "@tokenspace/sdk": "workspace:*",
    };
    await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");

    await writeFile(
      path.join(workspaceDir, "src/credentials.ts"),
      `import * as credentials from "@tokenspace/sdk/credentials";

export const workspaceSecret = credentials.secret({
  id: "workspace-secret",
  scope: "workspace",
  description: "Workspace secret for integration tests",
});

export const workspaceEnv = credentials.env({
  id: "workspace-env",
  variableName: "${TEST_ENV_CREDENTIAL_NAME}",
  description: "Environment credential for integration tests",
});

export const workspaceOauth = credentials.oauth({
  id: "workspace-oauth",
  scope: "workspace",
  description: "Workspace oauth credential for integration tests",
  config: {
    grantType: "client_credentials",
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    authorizeUrl: "https://example.com/oauth/authorize",
    tokenUrl: "https://example.com/oauth/token",
    scopes: ["read", "write"],
  },
});

export const missingOptional = credentials.secret({
  id: "missing-optional",
  scope: "workspace",
  optional: true,
});

export const missingRequired = credentials.secret({
  id: "missing-required",
  scope: "workspace",
});

export const sessionRequired = credentials.secret({
  id: "session-required",
  scope: "session",
});

export const sessionOptional = credentials.secret({
  id: "session-optional",
  scope: "session",
  optional: true,
});

export const userRequired = credentials.secret({
  id: "user-required",
  scope: "user",
});

export const userOptional = credentials.secret({
  id: "user-optional",
  scope: "user",
  optional: true,
});
`,
      "utf8",
    );

    await mkdir(path.join(workspaceDir, "src/capabilities/credentials"), { recursive: true });
    await writeFile(
      path.join(workspaceDir, "src/capabilities/credentials/CAPABILITY.md"),
      `---
name: Credentials
description: Runtime credential resolution test capability
---

# Credentials
`,
      "utf8",
    );

    await writeFile(
      path.join(workspaceDir, "src/capabilities/credentials/capability.ts"),
      `import { action, getSessionFilesystem } from "@tokenspace/sdk";
import { getCredential } from "@tokenspace/sdk/credentials";
import z from "zod";
import {
  workspaceSecret,
  workspaceEnv,
  workspaceOauth,
  missingOptional,
  missingRequired,
  sessionRequired,
  sessionOptional,
  userRequired,
  userOptional,
} from "../../credentials";

export const readSecret = action(z.object({}), async () => {
  return await getCredential(workspaceSecret);
});

export const readEnv = action(z.object({}), async () => {
  return await getCredential(workspaceEnv);
});

export const readOauth = action(z.object({}), async () => {
  const token = await getCredential(workspaceOauth);
  return token.accessToken;
});

export const readOptionalMissing = action(z.object({}), async () => {
  return await getCredential(missingOptional);
});

export const readMissingRequired = action(z.object({}), async () => {
  return await getCredential(missingRequired);
});

export const readSessionRequired = action(z.object({}), async () => {
  return await getCredential(sessionRequired);
});

export const readSessionOptional = action(z.object({}), async () => {
  return await getCredential(sessionOptional);
});

export const readUserRequired = action(z.object({}), async () => {
  return await getCredential(userRequired);
});

export const readUserOptional = action(z.object({}), async () => {
  return await getCredential(userOptional);
});

export const writeSessionFile = action(
  z.object({
    path: z.string(),
    content: z.string(),
  }),
  async ({ path, content }) => {
    const fs = getSessionFilesystem();
    await fs.write(path, content);
    return { ok: true };
  },
);

export const readSessionFile = action(
  z.object({
    path: z.string(),
  }),
  async ({ path }) => {
    const fs = getSessionFilesystem();
    return await fs.readText(path);
  },
);
`,
      "utf8",
    );

    const exists = (await backend.runFunction(getFunctionName(internal.seed.workspaceExists), { slug })) as boolean;
    if (exists) {
      await backend.runFunction(getFunctionName(internal.seed.deleteWorkspace), { slug });
    }

    const files = readFilesRecursively(workspaceDir);
    const seeded = (await backend.runFunction(getFunctionName(internal.seed.seedWorkspace), {
      slug,
      name: "Credentials Runtime Workspace",
      files,
    })) as { workspaceId: string };

    const branch = (await backend.runFunction(getFunctionName(internal.vcs.getDefaultBranchInternal), {
      workspaceId: seeded.workspaceId,
    })) as { _id: string };

    await harness.assignSharedExecutorToWorkspace(seeded.workspaceId);

    const revisionId = await enqueueAndWaitForRevision(backend, {
      workspaceId: seeded.workspaceId,
      branchId: branch._id,
      includeWorkingState: false,
    });

    return { workspaceId: seeded.workspaceId, branchId: branch._id, revisionId };
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function createSession(revisionId: string): Promise<string> {
  const backend = getSharedHarness().getBackend();
  return (await backend.runFunction(getFunctionName(internal.sessions.createSession), {
    userId: "test-user",
    revisionId,
  })) as string;
}

async function runSnippet(revisionId: string, code: string, sessionId?: string) {
  const backend = getSharedHarness().getBackend();
  const jobId = (await backend.runFunction(getFunctionName(internal.executor.createJob), {
    code,
    language: "typescript",
    revisionId,
    sessionId,
  })) as string;

  return await waitForJobCompletion(backend, jobId);
}

async function upsertCredentialValue(args: {
  workspaceId: string;
  credentialId: string;
  scope: "workspace" | "session" | "user";
  subject: string;
  kind: "secret" | "oauth";
  value:
    | { value: string }
    | { accessToken: string; tokenType?: string; scope?: string[]; expiresAt?: number; refreshToken?: string };
}) {
  const backend = getSharedHarness().getBackend();
  await backend.runFunction(getFunctionName(internal.credentials.upsertCredentialValueInternal), {
    workspaceId: args.workspaceId,
    credentialId: args.credentialId,
    scope: args.scope,
    subject: args.subject,
    kind: args.kind,
    value: args.value,
    updatedByUserId: "test-user",
  });
}

describe("credential runtime resolution", () => {
  let workspace: SeededWorkspace;

  beforeAll(async () => {
    await waitForSetup();
    workspace = await seedCredentialWorkspace(createWorkspaceSlug());

    await upsertCredentialValue({
      workspaceId: workspace.workspaceId,
      credentialId: "workspace-secret",
      scope: "workspace",
      subject: WORKSPACE_CREDENTIAL_SUBJECT,
      kind: "secret",
      value: { value: "secret-value" },
    });

    await upsertCredentialValue({
      workspaceId: workspace.workspaceId,
      credentialId: "workspace-oauth",
      scope: "workspace",
      subject: WORKSPACE_CREDENTIAL_SUBJECT,
      kind: "oauth",
      value: {
        accessToken: "oauth-access-token",
        tokenType: "Bearer",
        scope: ["read", "write"],
      },
    });
  }, 180_000);

  it("resolves workspace secret via getCredential()", async () => {
    const job = await runSnippet(
      workspace.revisionId,
      `
const value = await credentials.readSecret({});
console.log("SECRET_VALUE", value);
`,
    );

    expect(job.status).toBe("completed");
    expect(job.output).toContain("SECRET_VALUE secret-value");
  });

  it("stores credential values encrypted at rest", async () => {
    const backend = getSharedHarness().getBackend();
    const rows = (await backend.runFunction(getFunctionName(internal.credentials.listCredentialValuesInternal), {
      workspaceId: workspace.workspaceId,
    })) as Array<{
      credentialId: string;
      keyVersion: number;
      iv: string;
      ciphertext: string;
    }>;

    const secretRow = rows.find((row) => row.credentialId === "workspace-secret");
    expect(secretRow).toBeDefined();
    expect(secretRow?.keyVersion).not.toBeUndefined();
    expect(secretRow?.keyVersion ?? 0).toBeGreaterThan(0);
    expect(secretRow?.iv).toBeString();
    expect(secretRow?.ciphertext).toBeString();
    expect(secretRow?.ciphertext).not.toContain("secret-value");
  });

  it("resolves credentials through backend resolver APIs", async () => {
    const backend = getSharedHarness().getBackend();

    const secret = (await backend.runFunction(getFunctionName(internal.credentials.resolveCredentialForExecution), {
      workspaceId: workspace.workspaceId,
      credentialId: "workspace-secret",
      scope: "workspace",
      subject: WORKSPACE_CREDENTIAL_SUBJECT,
      expectedKind: "secret",
      optional: false,
      credentialLabel: "workspace-secret",
    })) as string;
    expect(secret).toBe("secret-value");

    const oauth = (await backend.runFunction(getFunctionName(internal.credentials.resolveCredentialForExecution), {
      workspaceId: workspace.workspaceId,
      credentialId: "workspace-oauth",
      scope: "workspace",
      subject: WORKSPACE_CREDENTIAL_SUBJECT,
      expectedKind: "oauth",
      optional: false,
      credentialLabel: "workspace-oauth",
    })) as { accessToken: string };
    expect(oauth.accessToken).toBe("oauth-access-token");

    const envValue = (await backend.runFunction(getFunctionName(internal.credentials.resolveCredentialForExecution), {
      workspaceId: workspace.workspaceId,
      credentialId: "workspace-env",
      scope: "workspace",
      subject: WORKSPACE_CREDENTIAL_SUBJECT,
      expectedKind: "env",
      optional: false,
      credentialLabel: "workspace-env",
      envConfig: { variableName: TEST_ENV_CREDENTIAL_NAME },
    })) as string;
    expect(envValue).toBe(TEST_ENV_CREDENTIAL_VALUE);
  });

  it("resolves env credential via getCredential()", async () => {
    const job = await runSnippet(
      workspace.revisionId,
      `
const value = await credentials.readEnv({});
console.log("ENV_VALUE", value);
`,
    );

    expect(job.status).toBe("completed");
    expect(job.output).toContain(`ENV_VALUE ${TEST_ENV_CREDENTIAL_VALUE}`);
  });

  it("persists capability filesystem writes across jobs in the same session", async () => {
    const sessionId = await createSession(workspace.revisionId);

    const writeJob = await runSnippet(
      workspace.revisionId,
      `
await credentials.writeSessionFile({
  path: "/sandbox/capability-session.txt",
  content: "session filesystem content",
});
console.log("WROTE_FILE");
`,
      sessionId,
    );

    expect(writeJob.status).toBe("completed");
    expect(writeJob.output).toContain("WROTE_FILE");

    const readJob = await runSnippet(
      workspace.revisionId,
      `
const value = await credentials.readSessionFile({
  path: "/sandbox/capability-session.txt",
});
console.log("SESSION_FILE", value);
`,
      sessionId,
    );

    expect(readJob.status).toBe("completed");
    expect(readJob.output).toContain("SESSION_FILE session filesystem content");
  });

  it("resolves oauth credential via getCredential()", async () => {
    const job = await runSnippet(
      workspace.revisionId,
      `
const token = await credentials.readOauth({});
console.log("OAUTH_ACCESS_TOKEN", token);
`,
    );

    expect(job.status).toBe("completed");
    expect(job.output).toContain("OAUTH_ACCESS_TOKEN oauth-access-token");
  });

  it("treats expired oauth credentials as missing with reason expired", async () => {
    await upsertCredentialValue({
      workspaceId: workspace.workspaceId,
      credentialId: "workspace-oauth",
      scope: "workspace",
      subject: WORKSPACE_CREDENTIAL_SUBJECT,
      kind: "oauth",
      value: {
        accessToken: "expired-oauth-access-token",
        tokenType: "Bearer",
        scope: ["read", "write"],
        expiresAt: Date.now() - 5_000,
      },
    });

    try {
      const job = await runSnippet(
        workspace.revisionId,
        `
	await credentials.readOauth({});
	`,
      );

      expect(job.status).toBe("failed");
      expect((job.error?.data as any)?.errorType).toBe("CREDENTIAL_MISSING");
      expect((job.error?.data as any)?.credential?.reason).toBe("expired");
      expect((job.error?.data as any)?.credential?.id).toBe("workspace-oauth");
    } finally {
      await upsertCredentialValue({
        workspaceId: workspace.workspaceId,
        credentialId: "workspace-oauth",
        scope: "workspace",
        subject: WORKSPACE_CREDENTIAL_SUBJECT,
        kind: "oauth",
        value: {
          accessToken: "oauth-access-token",
          tokenType: "Bearer",
          scope: ["read", "write"],
        },
      });
    }
  });

  it("returns null for optional expired oauth credential", async () => {
    await upsertCredentialValue({
      workspaceId: workspace.workspaceId,
      credentialId: "workspace-oauth",
      scope: "workspace",
      subject: WORKSPACE_CREDENTIAL_SUBJECT,
      kind: "oauth",
      value: {
        accessToken: "expired-optional-oauth-access-token",
        tokenType: "Bearer",
        scope: ["read", "write"],
        expiresAt: Date.now() - 5_000,
      },
    });

    try {
      const backend = getSharedHarness().getBackend();
      const resolved = await backend.runFunction(getFunctionName(internal.credentials.resolveCredentialForExecution), {
        workspaceId: workspace.workspaceId,
        credentialId: "workspace-oauth",
        scope: "workspace",
        subject: WORKSPACE_CREDENTIAL_SUBJECT,
        expectedKind: "oauth",
        optional: true,
        credentialLabel: "workspace-oauth",
      });

      expect(resolved).toBeNull();
    } finally {
      await upsertCredentialValue({
        workspaceId: workspace.workspaceId,
        credentialId: "workspace-oauth",
        scope: "workspace",
        subject: WORKSPACE_CREDENTIAL_SUBJECT,
        kind: "oauth",
        value: {
          accessToken: "oauth-access-token",
          tokenType: "Bearer",
          scope: ["read", "write"],
        },
      });
    }
  });

  it("returns undefined for missing optional credential", async () => {
    const job = await runSnippet(
      workspace.revisionId,
      `
const value = await credentials.readOptionalMissing({});
console.log("OPTIONAL_VALUE", value === undefined ? "undefined" : value);
`,
    );

    expect(job.status).toBe("completed");
    expect(job.output).toContain("OPTIONAL_VALUE undefined");
  });

  it("fails deterministically for missing required credential", async () => {
    const job = await runSnippet(
      workspace.revisionId,
      `
await credentials.readMissingRequired({});
console.log("should-not-print");
`,
    );

    expect(job.status).toBe("failed");
    expect(job.error?.message).toContain("required but unavailable");
    expect((job.error?.data as any)?.errorType).toBe("CREDENTIAL_MISSING");
    expect((job.error?.data as any)?.credential?.id).toBe("missing-required");
  });

  it("fails required session credential in non-interactive runs", async () => {
    const job = await runSnippet(
      workspace.revisionId,
      `
await credentials.readSessionRequired({});
`,
    );

    expect(job.status).toBe("failed");
    expect((job.error?.data as any)?.errorType).toBe("CREDENTIAL_MISSING");
    expect((job.error?.data as any)?.credential?.id).toBe("session-required");
    expect((job.error?.data as any)?.credential?.scope).toBe("session");
    expect((job.error?.data as any)?.credential?.reason).toBe("non_interactive");
  });

  it("returns undefined for optional session credential in non-interactive runs", async () => {
    const job = await runSnippet(
      workspace.revisionId,
      `
const value = await credentials.readSessionOptional({});
console.log("SESSION_OPTIONAL_VALUE", value === undefined ? "undefined" : value);
`,
    );

    expect(job.status).toBe("completed");
    expect(job.output).toContain("SESSION_OPTIONAL_VALUE undefined");
  });

  it("fails required session credential with missing reason when interactive", async () => {
    const sessionId = await createSession(workspace.revisionId);
    const job = await runSnippet(
      workspace.revisionId,
      `
await credentials.readSessionRequired({});
`,
      sessionId,
    );

    expect(job.status).toBe("failed");
    expect((job.error?.data as any)?.credential?.reason).toBe("missing");
    expect((job.error?.data as any)?.credential?.scope).toBe("session");
  });

  it("resolves required session credential when interactive and configured", async () => {
    const sessionId = await createSession(workspace.revisionId);
    await upsertCredentialValue({
      workspaceId: workspace.workspaceId,
      credentialId: "session-required",
      scope: "session",
      subject: sessionId,
      kind: "secret",
      value: { value: "session-secret-value" },
    });

    const job = await runSnippet(
      workspace.revisionId,
      `
const value = await credentials.readSessionRequired({});
console.log("SESSION_REQUIRED_VALUE", value);
`,
      sessionId,
    );

    expect(job.status).toBe("completed");
    expect(job.output).toContain("SESSION_REQUIRED_VALUE session-secret-value");
  });

  it("fails required user credential in non-interactive runs", async () => {
    const job = await runSnippet(
      workspace.revisionId,
      `
await credentials.readUserRequired({});
`,
    );

    expect(job.status).toBe("failed");
    expect((job.error?.data as any)?.errorType).toBe("CREDENTIAL_MISSING");
    expect((job.error?.data as any)?.credential?.id).toBe("user-required");
    expect((job.error?.data as any)?.credential?.scope).toBe("user");
    expect((job.error?.data as any)?.credential?.reason).toBe("non_interactive");
  });

  it("returns undefined for optional user credential in non-interactive runs", async () => {
    const job = await runSnippet(
      workspace.revisionId,
      `
const value = await credentials.readUserOptional({});
console.log("USER_OPTIONAL_VALUE", value === undefined ? "undefined" : value);
`,
    );

    expect(job.status).toBe("completed");
    expect(job.output).toContain("USER_OPTIONAL_VALUE undefined");
  });

  it("fails required user credential with missing reason when interactive", async () => {
    const sessionId = await createSession(workspace.revisionId);
    const job = await runSnippet(
      workspace.revisionId,
      `
await credentials.readUserRequired({});
`,
      sessionId,
    );

    expect(job.status).toBe("failed");
    expect((job.error?.data as any)?.credential?.reason).toBe("missing");
    expect((job.error?.data as any)?.credential?.scope).toBe("user");
  });

  it("resolves required user credential when interactive and configured", async () => {
    const sessionId = await createSession(workspace.revisionId);
    await upsertCredentialValue({
      workspaceId: workspace.workspaceId,
      credentialId: "user-required",
      scope: "user",
      subject: "test-user",
      kind: "secret",
      value: { value: "user-secret-value" },
    });

    const job = await runSnippet(
      workspace.revisionId,
      `
const value = await credentials.readUserRequired({});
console.log("USER_REQUIRED_VALUE", value);
`,
      sessionId,
    );

    expect(job.status).toBe("completed");
    expect(job.output).toContain("USER_REQUIRED_VALUE user-secret-value");
  });
});
