import { Buffer } from "node:buffer";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import nodePath from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApprovalRequirement } from "@tokenspace/sdk";
import { ApprovalRequiredError } from "@tokenspace/sdk";
import { z } from "zod";
import type { LocalApprovalStore } from "./approvals";
import type { LocalControlServerHandle } from "./control-server";
import type { LocalCredentialManager } from "./credential-store";
import { generateRunCodeDescription, generateWorkspaceOverview } from "./instructions";
import { toToolErrorResult, toToolSuccessResult } from "./mcp-errors";
import { resolveSandboxPath } from "./path-safety";
import { executeLocalSessionBash, executeLocalSessionCode } from "./runtime";
import type { LocalSession } from "./types";

const runCodeSchema = z.object({
  code: z.string().min(1),
  description: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const bashSchema = z.object({
  command: z.string().min(1),
  description: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const readFileSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().min(1).optional(),
  lineCount: z.number().int().min(1).optional(),
});

const writeFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  append: z.boolean().optional(),
});

const approvalRequirementSchema = z.object({
  action: z.string().min(1),
  data: z.unknown().optional(),
  info: z.unknown().optional(),
  description: z.string().min(1).optional(),
});

const requestApprovalSchema = z
  .object({
    approval: approvalRequirementSchema.optional(),
    action: z.string().min(1).optional(),
    data: z.unknown().optional(),
    info: z.unknown().optional(),
    description: z.string().min(1).optional(),
    reason: z.string().min(1),
  })
  .refine((value) => value.approval != null || value.action != null, {
    message: "approval or action is required",
    path: ["action"],
  });

const workspaceOverviewSchema = z.object({});

type ReadSlice = {
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
};

function splitLines(content: string): string[] {
  if (content === "") return [];
  const normalized = content.replace(/\r\n/g, "\n");
  const pieces = normalized.split("\n");
  if (normalized.endsWith("\n")) {
    pieces.pop();
  }
  return pieces;
}

function sliceContentByLines(content: string, startLine?: number, lineCount?: number): ReadSlice {
  if (startLine == null) {
    const lines = splitLines(content);
    return {
      content,
      startLine: lines.length > 0 ? 1 : 1,
      endLine: lines.length,
      totalLines: lines.length,
    };
  }

  const lines = splitLines(content);
  const startIndex = Math.max(0, startLine - 1);
  const endExclusive = lineCount == null ? lines.length : startIndex + lineCount;
  const selection = lines.slice(startIndex, endExclusive);
  return {
    content: selection.join("\n"),
    startLine,
    endLine:
      selection.length === 0 ? Math.max(0, Math.min(lines.length, startLine - 1)) : startLine + selection.length - 1,
    totalLines: lines.length,
  };
}

function normalizeApprovalAction(action: string): string {
  if (action.includes(":") || !action.includes(".")) {
    return action;
  }

  const [namespace, ...rest] = action.split(".");
  if (!namespace || rest.length === 0) {
    return action;
  }

  return `${namespace}:${rest.join(".")}`;
}

function parseJsonString(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }

  return value;
}

function normalizeApprovalRequirement(input: z.infer<typeof approvalRequirementSchema>): ApprovalRequirement {
  return {
    action: normalizeApprovalAction(input.action),
    data: parseJsonString(input.data) as Record<string, any> | undefined,
    info: parseJsonString(input.info) as Record<string, any> | undefined,
    description: input.description,
  };
}

type RegisterLocalMcpToolsOptions = {
  approvalStore: LocalApprovalStore;
  controlServer: LocalControlServerHandle;
  credentialManager: LocalCredentialManager;
};

export function registerLocalMcpTools(
  server: McpServer,
  session: LocalSession,
  { approvalStore, controlServer, credentialManager }: RegisterLocalMcpToolsOptions,
): Promise<void> | void {
  const errorContext = {
    controlUrl: controlServer.baseUrl,
    bootstrapToolName: "workspaceOverview",
  };
  const latestApprovalRequirementsByAction = new Map<string, ApprovalRequirement>();
  const runCodeDescriptionPromise = generateRunCodeDescription(session);
  const workspaceOverviewPromise = generateWorkspaceOverview(session);

  const registerTools = async () => {
    server.registerTool(
      "workspaceOverview",
      {
        title: "Workspace Overview",
        description:
          "Return a high-signal overview of the current Tokenspace workspace, including capabilities, filesystem rules, skills, discovery resources, approvals, and credentials.",
        inputSchema: workspaceOverviewSchema,
      },
      async () => {
        const overview = await workspaceOverviewPromise;
        return toToolSuccessResult(
          {
            overview,
          },
          overview,
        );
      },
    );

    server.registerTool(
      "runCode",
      {
        title: "Run Tokenspace TypeScript",
        description: await runCodeDescriptionPromise,
        inputSchema: runCodeSchema,
      },
      async ({ code, timeoutMs }: z.infer<typeof runCodeSchema>) => {
        try {
          const approvals = await approvalStore.listGrantedApprovals();
          const result = await executeLocalSessionCode(session, code, {
            timeoutMs,
            approvals,
            credentialStore: credentialManager,
          });
          return toToolSuccessResult(result, result.output);
        } catch (error) {
          if (error instanceof ApprovalRequiredError) {
            for (const requirement of error.requirements) {
              latestApprovalRequirementsByAction.set(requirement.action, requirement);
            }
          }
          return toToolErrorResult(error, errorContext);
        }
      },
    );

    server.registerTool(
      "bash",
      {
        title: "Run Tokenspace Bash",
        description: "Execute bash inside the current session sandbox, not on the host filesystem.",
        inputSchema: bashSchema,
      },
      async ({ command, cwd, timeoutMs }: z.infer<typeof bashSchema>) => {
        try {
          const approvals = await approvalStore.listGrantedApprovals();
          const result = await executeLocalSessionBash(session, command, {
            cwd,
            timeoutMs,
            approvals,
            credentialStore: credentialManager,
          });
          return toToolSuccessResult(result, result.output);
        } catch (error) {
          if (error instanceof ApprovalRequiredError) {
            for (const requirement of error.requirements) {
              latestApprovalRequirementsByAction.set(requirement.action, requirement);
            }
          }
          return toToolErrorResult(error, errorContext);
        }
      },
    );

    server.registerTool(
      "readFile",
      {
        title: "Read Session Sandbox File",
        description: "Read a text file from the Tokenspace session sandbox. This does not read the host filesystem.",
        inputSchema: readFileSchema,
      },
      async ({ path, startLine, lineCount }: z.infer<typeof readFileSchema>) => {
        try {
          const resolved = await resolveSandboxPath({
            sandboxRoot: session.sandboxDir,
            path,
          });
          const content = await readFile(resolved.absolutePath, "utf8");
          const sliced = sliceContentByLines(content, startLine, lineCount);
          return toToolSuccessResult(
            {
              path: resolved.relativePath ? `/sandbox/${resolved.relativePath}` : "/sandbox",
              content: sliced.content,
              startLine: sliced.startLine,
              endLine: sliced.endLine,
              totalLines: sliced.totalLines,
            },
            sliced.content,
          );
        } catch (error) {
          return toToolErrorResult(error, errorContext);
        }
      },
    );

    server.registerTool(
      "writeFile",
      {
        title: "Write Session Sandbox File",
        description:
          "Write a text file inside the Tokenspace session sandbox. This does not write to the host filesystem.",
        inputSchema: writeFileSchema,
      },
      async ({ path, content, append }: z.infer<typeof writeFileSchema>) => {
        try {
          const resolved = await resolveSandboxPath({
            sandboxRoot: session.sandboxDir,
            path,
          });
          await mkdir(nodePath.dirname(resolved.absolutePath), { recursive: true });
          if (append) {
            await appendFile(resolved.absolutePath, content, "utf8");
          } else {
            await writeFile(resolved.absolutePath, content, "utf8");
          }
          return toToolSuccessResult(
            {
              path: resolved.relativePath ? `/sandbox/${resolved.relativePath}` : "/sandbox",
              appended: append ?? false,
              bytesWritten: Buffer.byteLength(content),
            },
            `Wrote ${Buffer.byteLength(content)} bytes to ${
              resolved.relativePath ? `/sandbox/${resolved.relativePath}` : "/sandbox"
            }.`,
          );
        } catch (error) {
          return toToolErrorResult(error, errorContext);
        }
      },
    );

    server.registerTool(
      "requestApproval",
      {
        title: "Request Approval",
        description:
          "Create a local approval request and return a browser URL where a human can approve or deny it. Prefer passing the exact approval object returned by an APPROVAL_REQUIRED error.",
        inputSchema: requestApprovalSchema,
      },
      async ({ approval, action, data, info, description, reason }: z.infer<typeof requestApprovalSchema>) => {
        try {
          const normalizedApproval = approval ? normalizeApprovalRequirement(approval) : undefined;
          const normalizedAction = action ? normalizeApprovalAction(action) : undefined;
          const normalizedData = parseJsonString(data) as Record<string, any> | undefined;
          const normalizedInfo = parseJsonString(info) as Record<string, any> | undefined;
          const canonicalApproval = normalizedApproval ??
            (normalizedAction ? latestApprovalRequirementsByAction.get(normalizedAction) : undefined) ?? {
              action: normalizedAction ?? "",
              data: normalizedData,
              info: normalizedInfo,
              description,
            };

          const request = await approvalStore.createApprovalRequest({
            action: canonicalApproval.action,
            data: canonicalApproval.data,
            info: canonicalApproval.info,
            description: canonicalApproval.description,
            reason,
          });
          const approvalUrl = controlServer.getApprovalUrl(request.requestId);
          return toToolSuccessResult(
            {
              requestId: request.requestId,
              status: request.status,
              approvalUrl,
              approval: {
                action: request.action,
                data: request.data,
                info: request.info,
                description: request.description,
              },
            },
            `Approval request created for ${request.action}. Ask the user to open ${approvalUrl} in the local control UI, approve or deny the request there, then retry after they respond.`,
          );
        } catch (error) {
          return toToolErrorResult(error, errorContext);
        }
      },
    );
  };

  return registerTools();
}
