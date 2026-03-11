import type { CallToolResult, TextContent } from "@modelcontextprotocol/sdk/types.js";
import { ExecutionError } from "@tokenspace/runtime-core";
import {
  ApprovalRequiredError,
  CredentialStoreNotInitializedError,
  MissingCredentialError,
  TokenspaceError,
} from "@tokenspace/sdk";
import { SandboxPathError } from "./path-safety";

type ErrorPayload = Record<string, unknown>;
type ErrorContext = {
  controlUrl?: string;
  bootstrapToolName?: string;
};

function textContent(text: string): TextContent {
  return {
    type: "text",
    text,
  };
}

function buildErrorResult(message: string, structuredContent: ErrorPayload): CallToolResult {
  return {
    content: [textContent(message)],
    structuredContent,
    isError: true,
  };
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function toToolSuccessResult(structuredContent: Record<string, unknown>, text?: string): CallToolResult {
  const outputText = text ?? (typeof structuredContent.output === "string" ? structuredContent.output : "");
  return {
    content: [textContent(outputText || "(no output)")],
    structuredContent,
  };
}

function withControlUrl(details: string | undefined, controlUrl: string | undefined): string | undefined {
  if (!controlUrl) return details;
  return details
    ? `${details} Configure credentials in the local control UI: ${controlUrl}`
    : `Configure credentials in the local control UI: ${controlUrl}`;
}

export function toToolErrorResult(error: unknown, context?: ErrorContext): CallToolResult {
  if (error instanceof ApprovalRequiredError) {
    const approval = error.requirements[0];
    return buildErrorResult(
      "Approval is required before this action can run. Call requestApproval with approval set to the included approval object verbatim, ask the user to open the returned approvalUrl in the local control UI, then retry after approval.",
      {
        errorType: "APPROVAL_REQUIRED",
        approval: approval
          ? {
              action: approval.action,
              data: approval.data,
              info: approval.info,
              description: approval.description,
            }
          : undefined,
        requestApprovalArgs: approval
          ? {
              approval: {
                action: approval.action,
                data: approval.data,
                info: approval.info,
                description: approval.description,
              },
            }
          : undefined,
        retryable: true,
      },
    );
  }

  if (error instanceof MissingCredentialError) {
    const data = error.data as Record<string, unknown> | undefined;
    const details = withControlUrl(error.details, context?.controlUrl);
    return buildErrorResult(
      context?.controlUrl ? `${error.message} Open ${context.controlUrl} to configure credentials.` : error.message,
      {
        errorType: "CREDENTIAL_MISSING",
        credential:
          data && typeof data.credential === "object" && data.credential !== null
            ? (data.credential as Record<string, unknown>)
            : undefined,
        details,
        controlUrl: context?.controlUrl,
      },
    );
  }

  if (error instanceof CredentialStoreNotInitializedError) {
    const details = withControlUrl(error.details, context?.controlUrl);
    const message = context?.controlUrl
      ? `Credential resolution is unavailable in this local MCP session. Open ${context.controlUrl} to inspect or configure credentials.`
      : error.message;
    return buildErrorResult(message, {
      errorType: "CREDENTIAL_STORE_NOT_INITIALIZED",
      message,
      details,
      controlUrl: context?.controlUrl,
    });
  }

  if (error instanceof SandboxPathError) {
    return buildErrorResult(error.message, {
      errorType: "INVALID_SANDBOX_PATH",
      message: error.message,
    });
  }

  if (isNodeErrorWithCode(error, "ENOENT")) {
    const message = error instanceof Error ? error.message : "Sandbox file was not found.";
    return buildErrorResult(message, {
      errorType: "FILE_NOT_FOUND",
      message,
    });
  }

  if (error instanceof TokenspaceError) {
    const data = error.data;
    const errorType =
      data && typeof data === "object" && "errorType" in data && typeof data.errorType === "string"
        ? data.errorType
        : "EXECUTION_ERROR";
    const isCredentialError = errorType === "CREDENTIAL_MISSING" || errorType === "CREDENTIAL_STORE_NOT_INITIALIZED";
    const details = isCredentialError ? withControlUrl(error.details, context?.controlUrl) : error.details;
    const message =
      isCredentialError && context?.controlUrl
        ? `${error.message} Open ${context.controlUrl} to inspect or configure credentials.`
        : error.message;
    return buildErrorResult(message, {
      errorType,
      message,
      details,
      ...(isCredentialError && context?.controlUrl ? { controlUrl: context.controlUrl } : {}),
      ...(data && typeof data === "object" ? data : {}),
    });
  }

  if (error instanceof ExecutionError) {
    const message = context?.bootstrapToolName
      ? `${error.message} If you are missing workspace context, call ${context.bootstrapToolName} first.`
      : error.message;
    return buildErrorResult(message, {
      errorType: "EXECUTION_ERROR",
      message,
      ...(context?.bootstrapToolName ? { bootstrapTool: context.bootstrapToolName } : {}),
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  const finalMessage = context?.bootstrapToolName
    ? `${message} If you are missing workspace context, call ${context.bootstrapToolName} first.`
    : message;
  return buildErrorResult(finalMessage, {
    errorType: "EXECUTION_ERROR",
    message: finalMessage,
    ...(context?.bootstrapToolName ? { bootstrapTool: context.bootstrapToolName } : {}),
  });
}
