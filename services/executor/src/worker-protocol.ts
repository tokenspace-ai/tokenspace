import type { SerializableApproval } from "@tokenspace/sdk";
import type { ToolOutputResult } from "./tool-output";

export type WorkerInitRequest = {
  type: "init";
  requestId: string;
  revisionId: string;
};

export type WorkerExecRequest = {
  type: "exec";
  requestId: string;
  jobId: string;
  revisionId: string;
  instanceToken: string;
  language: "typescript" | "bash";
  code: string;
  bundleUrl?: string | null;
  bundlePath?: string | null;
  sessionId?: string | null;
  approvals?: SerializableApproval[];
  cwd?: string | null;
  timeoutMs?: number | null;
};

export type WorkerTokenUpdateRequest = {
  type: "token_update";
  requestId: string;
  instanceToken: string;
};

export type ParentToChildMessage = WorkerInitRequest | WorkerExecRequest | WorkerTokenUpdateRequest;

export type WorkerReadyResponse = {
  type: "ready";
  requestId: string;
  revisionId: string;
};

export type WorkerResultResponse = {
  type: "result";
  requestId: string;
  jobId: string;
  result: ToolOutputResult;
};

export type WorkerErrorResponse = {
  type: "error";
  requestId: string;
  jobId: string;
  error: { message: string; stack?: string; details?: string; data?: Record<string, unknown> };
};

export type ChildToParentMessage = WorkerReadyResponse | WorkerResultResponse | WorkerErrorResponse;

export function encodeMessage(message: ParentToChildMessage): string {
  return `${JSON.stringify(message)}\n`;
}
