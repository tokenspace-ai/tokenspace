import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SerializableApproval } from "@tokenspace/sdk";
import type { LocalSession } from "./types";

export type LocalApprovalRequestStatus = "pending" | "approved" | "denied";

export type LocalApprovalRequestInput = {
  action: string;
  data?: any;
  info?: any;
  description?: string;
  reason: string;
};

export type LocalApprovalRequest = LocalApprovalRequestInput & {
  requestId: string;
  status: LocalApprovalRequestStatus;
  createdAt: string;
  resolvedAt?: string;
  resolvedVia?: "local-control-server";
};

type LocalGrantedApprovalRecord = SerializableApproval & {
  requestId: string;
  grantedAt: string;
};

type LocalApprovalStoreState = {
  approvals: LocalGrantedApprovalRecord[];
};

export type LocalApprovalStore = {
  approvalsFilePath: string;
  approvalRequestsDir: string;
  createApprovalRequest: (input: LocalApprovalRequestInput) => Promise<LocalApprovalRequest>;
  getApprovalRequest: (requestId: string) => Promise<LocalApprovalRequest | null>;
  listApprovalRequests: () => Promise<LocalApprovalRequest[]>;
  listGrantedApprovals: () => Promise<SerializableApproval[]>;
  approveApprovalRequest: (requestId: string) => Promise<LocalApprovalRequest>;
  denyApprovalRequest: (requestId: string) => Promise<LocalApprovalRequest>;
};

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class ApprovalRequestNotFoundError extends Error {
  code = "ENOENT" as const;

  constructor(requestId: string) {
    super(`Approval request not found: ${requestId}`);
    this.name = "ApprovalRequestNotFoundError";
  }
}

function validateRequestId(requestId: string): void {
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new ApprovalRequestNotFoundError(requestId);
  }
}

function requestPath(approvalRequestsDir: string, requestId: string): string {
  validateRequestId(requestId);
  return path.join(approvalRequestsDir, `${requestId}.json`);
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function readApprovalState(approvalsFilePath: string): Promise<LocalApprovalStoreState> {
  return await readJsonFile<LocalApprovalStoreState>(approvalsFilePath);
}

async function writeApprovalState(approvalsFilePath: string, state: LocalApprovalStoreState): Promise<void> {
  await writeJsonFile(approvalsFilePath, state);
}

async function readApprovalRequest(filePath: string): Promise<LocalApprovalRequest> {
  return await readJsonFile<LocalApprovalRequest>(filePath);
}

async function writeApprovalRequest(filePath: string, request: LocalApprovalRequest): Promise<void> {
  await writeJsonFile(filePath, request);
}

function sortRequests(requests: LocalApprovalRequest[]): LocalApprovalRequest[] {
  return [...requests].sort((left, right) => {
    const createdDiff = right.createdAt.localeCompare(left.createdAt);
    if (createdDiff !== 0) return createdDiff;
    return right.requestId.localeCompare(left.requestId);
  });
}

export async function createLocalApprovalStore(session: LocalSession): Promise<LocalApprovalStore> {
  const approvalsFilePath = path.join(session.sessionRoot, "approvals.json");
  const approvalRequestsDir = path.join(session.sessionRoot, "approval-requests");
  let updateQueue: Promise<void> = Promise.resolve();

  async function withStoreLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = updateQueue;
    let release = () => {};
    updateQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
    }
  }

  await mkdir(approvalRequestsDir, { recursive: true });
  try {
    await access(approvalsFilePath);
  } catch {
    await writeApprovalState(approvalsFilePath, { approvals: [] });
  }

  return {
    approvalsFilePath,
    approvalRequestsDir,

    async createApprovalRequest(input: LocalApprovalRequestInput): Promise<LocalApprovalRequest> {
      const request: LocalApprovalRequest = {
        requestId: randomUUID(),
        action: input.action,
        data: input.data,
        info: input.info,
        description: input.description,
        reason: input.reason,
        status: "pending",
        createdAt: new Date().toISOString(),
      };

      await writeApprovalRequest(requestPath(approvalRequestsDir, request.requestId), request);
      return request;
    },

    async getApprovalRequest(requestId: string): Promise<LocalApprovalRequest | null> {
      try {
        return await readApprovalRequest(requestPath(approvalRequestsDir, requestId));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },

    async listApprovalRequests(): Promise<LocalApprovalRequest[]> {
      const entries = await readdir(approvalRequestsDir, { withFileTypes: true });
      const requestFiles = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => path.join(approvalRequestsDir, entry.name));
      const requests = await Promise.all(requestFiles.map((filePath) => readApprovalRequest(filePath)));
      return sortRequests(requests);
    },

    async listGrantedApprovals(): Promise<SerializableApproval[]> {
      const state = await readApprovalState(approvalsFilePath);
      return state.approvals.map((approval) => ({
        action: approval.action,
        data: approval.data,
      }));
    },

    async approveApprovalRequest(requestId: string): Promise<LocalApprovalRequest> {
      return await withStoreLock(async () => {
        const filePath = requestPath(approvalRequestsDir, requestId);
        const request = await readApprovalRequest(filePath);
        if (request.status !== "pending") {
          throw new Error(`Approval request ${requestId} is already ${request.status}`);
        }

        const resolvedAt = new Date().toISOString();
        const approvedRequest: LocalApprovalRequest = {
          ...request,
          status: "approved",
          resolvedAt,
          resolvedVia: "local-control-server",
        };

        const state = await readApprovalState(approvalsFilePath);
        state.approvals.push({
          requestId,
          action: request.action,
          data: request.data,
          grantedAt: resolvedAt,
        });
        await writeApprovalState(approvalsFilePath, state);
        await writeApprovalRequest(filePath, approvedRequest);

        return approvedRequest;
      });
    },

    async denyApprovalRequest(requestId: string): Promise<LocalApprovalRequest> {
      return await withStoreLock(async () => {
        const filePath = requestPath(approvalRequestsDir, requestId);
        const request = await readApprovalRequest(filePath);
        if (request.status !== "pending") {
          throw new Error(`Approval request ${requestId} is already ${request.status}`);
        }

        const deniedRequest: LocalApprovalRequest = {
          ...request,
          status: "denied",
          resolvedAt: new Date().toISOString(),
          resolvedVia: "local-control-server",
        };
        await writeApprovalRequest(filePath, deniedRequest);
        return deniedRequest;
      });
    },
  };
}
