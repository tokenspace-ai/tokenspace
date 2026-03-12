import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolRequest, CallToolResult, TextContent } from "@modelcontextprotocol/sdk/types.js";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const EXAMPLES_DIR = path.join(REPO_ROOT, "examples");
const CREDENTIAL_WORKSPACE_DIR = path.join(REPO_ROOT, "apps/local-mcp/fixtures/credential-workspace");
const CLI_PATH = path.join(import.meta.dir, "../src/cli.ts");
const BUN_PATH = Bun.which("bun") ?? process.execPath;
const TEST_ENV_NAME = "TOK_LOCAL_MCP_SERVER_TEST_ENV";
const ORIGINAL_GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ORIGINAL_TEST_ENV_VALUE = process.env[TEST_ENV_NAME];

const clientsToClose: Client[] = [];
const tempDirsToRemove = new Set<string>();

function readTextContent(result: CallToolResult): string {
  const textBlock = result.content.find((entry): entry is TextContent => entry.type === "text");
  return textBlock?.text ?? "";
}

function extractApprovalNonce(approvalUrl: string): string {
  const nonce = new URL(approvalUrl).searchParams.get("nonce");
  if (!nonce) {
    throw new Error(`Approval URL is missing a nonce: ${approvalUrl}`);
  }
  return nonce;
}

async function callToolResult(client: Client, params: CallToolRequest["params"]): Promise<CallToolResult> {
  const result = await client.callTool(params);
  if ("toolResult" in result) {
    throw new Error("Expected direct tool result but received task-wrapped output.");
  }
  return result;
}

async function startClientFromWorkspace(
  workspaceDir: string,
  options?: { env?: Record<string, string | undefined>; buildCacheDir?: string },
): Promise<{ client: Client; sessionsRootDir: string; buildCacheDir: string; getStderr: () => string }> {
  const sessionsRootDir = await mkdtemp(path.join(tmpdir(), "tokenspace-local-mcp-server-"));
  const buildCacheDir = options?.buildCacheDir ?? (await mkdtemp(path.join(tmpdir(), "tokenspace-local-mcp-cache-")));
  tempDirsToRemove.add(sessionsRootDir);
  tempDirsToRemove.add(buildCacheDir);
  const env = { ...process.env } as Record<string, string>;
  for (const [key, value] of Object.entries(options?.env ?? {})) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  const transport = new StdioClientTransport({
    command: BUN_PATH,
    args: ["run", CLI_PATH, workspaceDir, "--sessions-root-dir", sessionsRootDir, "--build-cache-dir", buildCacheDir],
    cwd: REPO_ROOT,
    env,
    stderr: "pipe",
  });
  let stderrOutput = "";
  transport.stderr?.on("data", (chunk) => {
    stderrOutput += String(chunk);
  });

  const client = new Client({
    name: "tokenspace-local-mcp-test",
    version: "0.1.0",
  });
  clientsToClose.push(client);
  await client.connect(transport);

  return {
    client,
    sessionsRootDir,
    buildCacheDir,
    getStderr: () => stderrOutput,
  };
}

async function startClient(
  workspaceName: string,
  options?: { buildCacheDir?: string },
): Promise<{ client: Client; sessionsRootDir: string; buildCacheDir: string; getStderr: () => string }> {
  return await startClientFromWorkspace(path.join(EXAMPLES_DIR, workspaceName), options);
}

function readTextResource(result: Awaited<ReturnType<Client["readResource"]>>): string {
  const entry = result.contents[0];
  if (!entry || !("text" in entry)) {
    throw new Error("Expected text resource content");
  }
  return entry.text;
}

async function getControlServerAccess(client: Client): Promise<{ baseUrl: string; nonce: string }> {
  const request = await callToolResult(client, {
    name: "requestApproval",
    arguments: {
      action: "test:control-access",
      reason: "Extract local control URL for integration tests",
    },
  });
  const requestData = request.structuredContent as {
    approvalUrl: string;
  };
  return {
    baseUrl: new URL(requestData.approvalUrl).origin,
    nonce: extractApprovalNonce(requestData.approvalUrl),
  };
}

afterEach(async () => {
  if (ORIGINAL_GITHUB_TOKEN === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = ORIGINAL_GITHUB_TOKEN;
  }

  if (ORIGINAL_TEST_ENV_VALUE === undefined) {
    delete process.env[TEST_ENV_NAME];
  } else {
    process.env[TEST_ENV_NAME] = ORIGINAL_TEST_ENV_VALUE;
  }

  while (clientsToClose.length > 0) {
    await clientsToClose.pop()?.close();
  }

  for (const dir of tempDirsToRemove) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirsToRemove.clear();
});

describe("@tokenspace/local-mcp stdio MCP server", () => {
  it("lists the expected MCP tools", async () => {
    const { client } = await startClient("testing");
    const result = await client.listTools();
    const toolNames = result.tools.map((tool) => tool.name).sort();

    expect(toolNames).toEqual(["bash", "readFile", "requestApproval", "runCode", "workspaceOverview", "writeFile"]);
    const runCodeTool = result.tools.find((tool) => tool.name === "runCode");
    expect(runCodeTool?.description).toContain("Available capability namespaces:");
    expect(runCodeTool?.description).toContain("Available capabilities:");
    expect(runCodeTool?.description).toContain("/sandbox");
    expect(runCodeTool?.description).toContain("system-instructions");
  });

  it("exposes a system-instructions prompt", async () => {
    const { client } = await startClient("testing");
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((prompt) => prompt.name)).toContain("system-instructions");

    const prompt = await client.getPrompt({ name: "system-instructions" });
    expect(prompt.description).toContain("General Tokenspace local MCP instructions");
    expect(prompt.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: expect.objectContaining({
          type: "text",
          text: expect.stringContaining("The runtime filesystem is virtual and rooted at `/sandbox`."),
        }),
      }),
    ]);
    const textContent = prompt.messages[0]?.content;
    if (!textContent || textContent.type !== "text") {
      throw new Error("Expected text prompt content");
    }
    expect(textContent.text).toContain("csv: Analyze and transform CSV data");
  });

  it("returns a workspace overview bootstrap tool result", async () => {
    const { client } = await startClient("testing");
    const result = await callToolResult(client, {
      name: "workspaceOverview",
      arguments: {},
    });

    expect(result.isError).toBeUndefined();
    expect(readTextContent(result)).toContain("# Tokenspace Workspace Overview");
    expect(result.structuredContent).toMatchObject({
      overview: expect.stringContaining("All file access is scoped to the virtual filesystem at `/sandbox`."),
    });
  });

  it("lists and reads the expected MCP resources", async () => {
    const { client } = await startClient("testing");
    const resources = await client.listResources();
    const resourceUris = resources.resources.map((resource) => resource.uri).sort();

    expect(resourceUris).toEqual([
      "tokenspace://approvals/pending",
      "tokenspace://session/manifest",
      "tokenspace://workspace/metadata",
      "tokenspace://workspace/token-space-md",
    ]);

    const sessionResource = await client.readResource({ uri: "tokenspace://session/manifest" });
    expect(sessionResource.contents[0]?.mimeType).toBe("application/json");
    const sessionManifest = JSON.parse(readTextResource(sessionResource)) as {
      workspaceName: string;
      buildOrigin: string;
      controlBaseUrl: string;
    };
    expect(sessionManifest.workspaceName).toBe("testing");
    expect(sessionManifest.buildOrigin).toBe("fresh-build");
    expect(sessionManifest.controlBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const metadataResource = await client.readResource({ uri: "tokenspace://workspace/metadata" });
    expect(metadataResource.contents[0]?.mimeType).toBe("application/json");
    const workspaceMetadata = JSON.parse(readTextResource(metadataResource)) as {
      tokenspaceMd?: string;
      capabilities: unknown[];
      skills: unknown[];
    };
    expect(workspaceMetadata.tokenspaceMd).toContain("testing");
    expect(Array.isArray(workspaceMetadata.capabilities)).toBe(true);
    expect(Array.isArray(workspaceMetadata.skills)).toBe(true);

    const tokenspaceResource = await client.readResource({ uri: "tokenspace://workspace/token-space-md" });
    expect(tokenspaceResource.contents[0]?.mimeType).toBe("text/markdown");
    const tokenspaceMd = readTextResource(tokenspaceResource);
    expect(tokenspaceMd).toContain("Testing Example Workspace");

    const approvalsResource = await client.readResource({ uri: "tokenspace://approvals/pending" });
    expect(approvalsResource.contents[0]?.mimeType).toBe("application/json");
    const pendingApprovals = JSON.parse(readTextResource(approvalsResource)) as unknown[];
    expect(pendingApprovals).toEqual([]);
  });

  it("omits the TOKENSPACE.md resource when the workspace has no TOKENSPACE.md", async () => {
    const { client } = await startClientFromWorkspace(CREDENTIAL_WORKSPACE_DIR);
    const resources = await client.listResources();
    const resourceUris = resources.resources.map((resource) => resource.uri).sort();

    expect(resourceUris).toEqual([
      "tokenspace://approvals/pending",
      "tokenspace://session/manifest",
      "tokenspace://workspace/metadata",
    ]);
  });

  it("updates the pending approvals resource after requestApproval", async () => {
    const { client } = await startClient("testing");
    const request = await callToolResult(client, {
      name: "requestApproval",
      arguments: {
        action: "demo:approve",
        description: "Approve this test action",
        reason: "Need local approval for discovery resource coverage",
      },
    });

    const requestData = request.structuredContent as {
      requestId: string;
      approvalUrl: string;
    };
    const pendingApprovals = JSON.parse(
      readTextResource(await client.readResource({ uri: "tokenspace://approvals/pending" })),
    ) as Array<Record<string, string>>;

    expect(pendingApprovals).toEqual([
      expect.objectContaining({
        requestId: requestData.requestId,
        action: "demo:approve",
        reason: "Need local approval for discovery resource coverage",
        description: "Approve this test action",
        approvalUrl: requestData.approvalUrl,
      }),
    ]);
  });

  it("supports runCode, bash, readFile, and writeFile against the session sandbox", async () => {
    const { client } = await startClient("testing");

    const tsResult = await callToolResult(client, {
      name: "runCode",
      arguments: {
        code: `
await fs.write("/sandbox/notes.txt", "line 1\\nline 2");
console.log("ts wrote");
`,
      },
    });
    expect(tsResult.isError).toBeUndefined();
    expect(readTextContent(tsResult)).toContain("ts wrote");

    const bashResult = await callToolResult(client, {
      name: "bash",
      arguments: {
        command: 'cat /sandbox/notes.txt && printf "\\nfrom bash" > /sandbox/from-bash.txt',
      },
    });
    expect(bashResult.isError).toBeUndefined();
    expect(readTextContent(bashResult)).toContain("line 1");

    const readResult = await callToolResult(client, {
      name: "readFile",
      arguments: {
        path: "/sandbox/notes.txt",
        startLine: 2,
        lineCount: 1,
      },
    });
    expect(readResult.isError).toBeUndefined();
    expect(readResult.structuredContent).toMatchObject({
      path: "/sandbox/notes.txt",
      content: "line 2",
      startLine: 2,
      endLine: 2,
      totalLines: 2,
    });

    const writeResult = await callToolResult(client, {
      name: "writeFile",
      arguments: {
        path: "/sandbox/from-tool.txt",
        content: "hello from writeFile",
      },
    });
    expect(writeResult.isError).toBeUndefined();
    expect(writeResult.structuredContent).toMatchObject({
      path: "/sandbox/from-tool.txt",
      appended: false,
      bytesWritten: 20,
    });

    const verifyResult = await callToolResult(client, {
      name: "runCode",
      arguments: {
        code: `
console.log(await fs.readText("/sandbox/from-bash.txt"));
console.log(await fs.readText("/sandbox/from-tool.txt"));
`,
      },
    });
    expect(verifyResult.isError).toBeUndefined();
    expect(readTextContent(verifyResult)).toContain("from bash");
    expect(readTextContent(verifyResult)).toContain("hello from writeFile");
  });

  it("returns a structured missing env credential tool error", async () => {
    const { client } = await startClientFromWorkspace(CREDENTIAL_WORKSPACE_DIR, {
      env: {
        [TEST_ENV_NAME]: undefined,
      },
    });
    const result = await callToolResult(client, {
      name: "runCode",
      arguments: {
        code: "await credentials.readEnv({});",
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      errorType: "CREDENTIAL_MISSING",
      controlUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      credential: {
        id: "workspace-env",
        kind: "env",
        scope: "workspace",
        reason: "missing",
      },
    });
    expect(readTextContent(result)).toContain("inspect or configure credentials");
  });

  it("suggests workspaceOverview on generic execution errors", async () => {
    const { client } = await startClient("testing");
    const result = await callToolResult(client, {
      name: "runCode",
      arguments: {
        code: "throw new Error('boom');",
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      errorType: "EXECUTION_ERROR",
      bootstrapTool: "workspaceOverview",
    });
    expect(readTextContent(result)).toContain("call workspaceOverview first");
  });

  it("creates a local approval request from requestApproval", async () => {
    const { client } = await startClient("testing");
    const result = await callToolResult(client, {
      name: "requestApproval",
      arguments: {
        action: "demo:write",
        reason: "Need approval",
      },
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      status: "pending",
      requestId: expect.any(String),
      approvalUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/approvals\//),
    });
    expect(readTextContent(result)).toContain("Ask the user to open");
    expect(readTextContent(result)).toContain("local control UI");
  });

  it("recovers from Claude Desktop-style requestApproval arguments", async () => {
    const { client } = await startClient("testing");
    const command = String.raw`printf '{"ok":true,"n":7}\n' | validate_json --require-approval`;

    const blocked = await callToolResult(client, {
      name: "bash",
      arguments: {
        command,
      },
    });
    expect(blocked.isError).toBe(true);
    expect(blocked.structuredContent).toMatchObject({
      errorType: "APPROVAL_REQUIRED",
      approval: {
        action: "testing:validate_json",
        data: { command: "validate_json" },
      },
    });

    const request = await callToolResult(client, {
      name: "requestApproval",
      arguments: {
        action: "testing.validate_json",
        data: JSON.stringify({
          command: "validate_json",
          extra: "ignored",
        }),
        reason: "Approve the validate_json command for this session",
      },
    });

    expect(request.isError).toBeUndefined();
    expect(request.structuredContent).toMatchObject({
      status: "pending",
      approval: {
        action: "testing:validate_json",
        data: { command: "validate_json" },
      },
    });

    const requestData = request.structuredContent as {
      requestId: string;
      approvalUrl: string;
    };

    const approveResponse = await fetch(
      `${new URL(requestData.approvalUrl).origin}/api/approvals/${requestData.requestId}/approve`,
      {
        method: "POST",
        body: new URLSearchParams({
          nonce: extractApprovalNonce(requestData.approvalUrl),
        }),
      },
    );
    expect(approveResponse.status).toBe(200);

    const retried = await callToolResult(client, {
      name: "bash",
      arguments: {
        command,
      },
    });
    expect(retried.isError).toBeUndefined();
    expect(readTextContent(retried)).toContain("valid ok=true n=7");
  });

  it("supports approving a request over HTTP and succeeding on retry", async () => {
    const { client } = await startClient("testing");
    const command = String.raw`printf '{"ok":true,"n":7}\n' | validate_json --require-approval`;

    const blocked = await callToolResult(client, {
      name: "bash",
      arguments: {
        command,
      },
    });
    expect(blocked.isError).toBe(true);
    expect(blocked.structuredContent).toMatchObject({
      errorType: "APPROVAL_REQUIRED",
      approval: {
        action: "testing:validate_json",
        data: { command: "validate_json" },
      },
    });

    const approval = blocked.structuredContent as {
      approval?: {
        action: string;
        data?: Record<string, unknown>;
        info?: Record<string, unknown>;
        description?: string;
      };
    };
    const request = await callToolResult(client, {
      name: "requestApproval",
      arguments: {
        action: approval.approval?.action,
        data: approval.approval?.data,
        info: approval.approval?.info,
        description: approval.approval?.description,
        reason: "Approve the validate_json command for this session",
      },
    });

    expect(request.isError).toBeUndefined();
    const requestData = request.structuredContent as {
      requestId: string;
      status: string;
      approvalUrl: string;
    };
    expect(requestData.status).toBe("pending");

    const approveResponse = await fetch(
      `${new URL(requestData.approvalUrl).origin}/api/approvals/${requestData.requestId}/approve`,
      {
        method: "POST",
        body: new URLSearchParams({
          nonce: extractApprovalNonce(requestData.approvalUrl),
        }),
      },
    );
    expect(approveResponse.status).toBe(200);

    const retried = await callToolResult(client, {
      name: "bash",
      arguments: {
        command,
      },
    });
    expect(retried.isError).toBeUndefined();
    expect(readTextContent(retried)).toContain("valid ok=true n=7");
  });

  it("keeps denied requests from unblocking retries", async () => {
    const { client } = await startClient("testing");
    const command = String.raw`printf '{"ok":true}\n' | validate_json --require-approval`;

    const blocked = await callToolResult(client, {
      name: "bash",
      arguments: {
        command,
      },
    });
    const approval = (
      blocked.structuredContent as {
        approval?: {
          action: string;
          data?: Record<string, unknown>;
          info?: Record<string, unknown>;
          description?: string;
        };
      }
    ).approval;
    const request = await callToolResult(client, {
      name: "requestApproval",
      arguments: {
        action: approval?.action,
        data: approval?.data,
        info: approval?.info,
        description: approval?.description,
        reason: "Deny this validation command",
      },
    });
    const requestData = request.structuredContent as {
      requestId: string;
      approvalUrl: string;
    };

    const denyResponse = await fetch(
      `${new URL(requestData.approvalUrl).origin}/api/approvals/${requestData.requestId}/deny`,
      {
        method: "POST",
        body: new URLSearchParams({
          nonce: extractApprovalNonce(requestData.approvalUrl),
        }),
      },
    );
    expect(denyResponse.status).toBe(200);

    const retried = await callToolResult(client, {
      name: "bash",
      arguments: {
        command,
      },
    });
    expect(retried.isError).toBe(true);
    expect(retried.structuredContent).toMatchObject({
      errorType: "APPROVAL_REQUIRED",
      approval: {
        action: "testing:validate_json",
      },
    });
  });

  it("supports configuring workspace and local-scoped secrets through the control server", async () => {
    const { client } = await startClientFromWorkspace(CREDENTIAL_WORKSPACE_DIR);
    const access = await getControlServerAccess(client);

    await fetch(`${access.baseUrl}/api/credentials/workspace-secret`, {
      method: "DELETE",
      headers: {
        "x-tokenspace-nonce": access.nonce,
      },
    });
    await fetch(`${access.baseUrl}/api/credentials/session-secret`, {
      method: "DELETE",
      headers: {
        "x-tokenspace-nonce": access.nonce,
      },
    });
    await fetch(`${access.baseUrl}/api/credentials/user-secret`, {
      method: "DELETE",
      headers: {
        "x-tokenspace-nonce": access.nonce,
      },
    });

    const missing = await callToolResult(client, {
      name: "runCode",
      arguments: {
        code: "console.log(await credentials.readSecret({}));",
      },
    });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toMatchObject({
      errorType: "CREDENTIAL_MISSING",
      credential: {
        id: "workspace-secret",
        kind: "secret",
        scope: "workspace",
        reason: "missing",
      },
    });

    const storeWorkspaceSecret = await fetch(`${access.baseUrl}/api/credentials/workspace-secret`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-tokenspace-nonce": access.nonce,
      },
      body: JSON.stringify({ value: "workspace-secret-value" }),
    });
    expect(storeWorkspaceSecret.status).toBe(200);

    const storeSessionSecret = await fetch(`${access.baseUrl}/api/credentials/session-secret`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-tokenspace-nonce": access.nonce,
      },
      body: JSON.stringify({ value: "session-secret-value" }),
    });
    expect(storeSessionSecret.status).toBe(200);

    const storeUserSecret = await fetch(`${access.baseUrl}/api/credentials/user-secret`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-tokenspace-nonce": access.nonce,
      },
      body: JSON.stringify({ value: "user-secret-value" }),
    });
    expect(storeUserSecret.status).toBe(200);

    const configured = await callToolResult(client, {
      name: "runCode",
      arguments: {
        code: `
console.log(await credentials.readSecret({}));
console.log(await credentials.readSessionSecret({}));
console.log(await credentials.readUserSecret({}));
`,
      },
    });
    expect(configured.isError).toBeUndefined();
    expect(readTextContent(configured)).toContain("workspace-secret-value");
    expect(readTextContent(configured)).toContain("session-secret-value");
    expect(readTextContent(configured)).toContain("user-secret-value");

    const credentialsResponse = await fetch(`${access.baseUrl}/api/credentials`);
    const credentialsPayload = (await credentialsResponse.json()) as {
      credentials: Array<Record<string, unknown>>;
    };
    expect(credentialsPayload.credentials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "session-secret",
          scope: "session",
          effectiveScope: "workspace",
          configured: true,
        }),
        expect.objectContaining({
          id: "user-secret",
          scope: "user",
          effectiveScope: "workspace",
          configured: true,
        }),
      ]),
    );

    const deleteWorkspaceSecret = await fetch(`${access.baseUrl}/api/credentials/workspace-secret`, {
      method: "DELETE",
      headers: {
        "x-tokenspace-nonce": access.nonce,
      },
    });
    expect(deleteWorkspaceSecret.status).toBe(200);

    await fetch(`${access.baseUrl}/api/credentials/session-secret`, {
      method: "DELETE",
      headers: {
        "x-tokenspace-nonce": access.nonce,
      },
    });
    await fetch(`${access.baseUrl}/api/credentials/user-secret`, {
      method: "DELETE",
      headers: {
        "x-tokenspace-nonce": access.nonce,
      },
    });
  });

  it("resolves env credentials and surfaces unsupported oauth errors", async () => {
    const { client } = await startClientFromWorkspace(CREDENTIAL_WORKSPACE_DIR, {
      env: {
        [TEST_ENV_NAME]: "env-secret-value",
      },
    });

    const envResult = await callToolResult(client, {
      name: "runCode",
      arguments: {
        code: "console.log(await credentials.readEnv({}));",
      },
    });
    expect(envResult.isError).toBeUndefined();
    expect(readTextContent(envResult)).toContain("env-secret-value");

    const oauthResult = await callToolResult(client, {
      name: "runCode",
      arguments: {
        code: "await credentials.readOauth({});",
      },
    });
    expect(oauthResult.isError).toBe(true);
    expect(oauthResult.structuredContent).toMatchObject({
      errorType: "CREDENTIAL_MISSING",
      credential: {
        id: "workspace-oauth",
        kind: "oauth",
        scope: "workspace",
        reason: "non_interactive",
      },
    });
    expect(oauthResult.structuredContent).toMatchObject({
      details: expect.stringContaining("OAuth credentials are not supported in local MCP yet."),
    });
  });

  it("has publish-ready package metadata", async () => {
    const packageJson = JSON.parse(await readFile(path.join(REPO_ROOT, "apps/local-mcp/package.json"), "utf8")) as {
      private?: boolean;
      bin?: Record<string, string>;
    };

    expect(packageJson.private).toBeUndefined();
    expect(packageJson.bin?.["tokenspace-local-mcp"]).toBe("./dist/cli.js");
  });

  it("logs startup metadata to stderr and keeps stdout clean before MCP traffic", async () => {
    const { client, getStderr } = await startClient("testing");
    await client.listTools();

    const stderr = getStderr();
    expect(stderr).toContain("Tokenspace local MCP ready on stdio");
    expect(stderr).toContain("Fingerprint:");
    expect(stderr).toContain("Build: fresh-build");
    expect(stderr).toContain("Control: http://127.0.0.1:");
  });
});
