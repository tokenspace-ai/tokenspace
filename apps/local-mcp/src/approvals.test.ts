import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalApprovalStore } from "./approvals";
import { createLocalSession } from "./session";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const EXAMPLES_DIR = path.join(REPO_ROOT, "examples");

async function createTestingSession() {
  const sessionsRootDir = await mkdtemp(path.join(tmpdir(), "tokenspace-local-mcp-approvals-"));
  return await createLocalSession({
    workspaceDir: path.join(EXAMPLES_DIR, "testing"),
    sessionsRootDir,
  });
}

describe("local approval store", () => {
  it("initializes approvals.json and approval request storage", async () => {
    const session = await createTestingSession();
    const store = await createLocalApprovalStore(session);

    const approvalsText = await readFile(store.approvalsFilePath, "utf8");
    expect(JSON.parse(approvalsText)).toEqual({ approvals: [] });
    expect(store.approvalRequestsDir).toBe(path.join(session.sessionRoot, "approval-requests"));
  });

  it("creates approval requests with raw data and info preserved", async () => {
    const session = await createTestingSession();
    const store = await createLocalApprovalStore(session);

    const request = await store.createApprovalRequest({
      action: "demo:write",
      data: { nested: { id: 7 } },
      info: { preview: ["a", "b"] },
      description: "Need a demo approval",
      reason: "Test request",
    });

    const stored = await store.getApprovalRequest(request.requestId);
    expect(stored).toMatchObject({
      requestId: request.requestId,
      action: "demo:write",
      data: { nested: { id: 7 } },
      info: { preview: ["a", "b"] },
      description: "Need a demo approval",
      reason: "Test request",
      status: "pending",
    });
  });

  it("approves a request and appends the granted approval", async () => {
    const session = await createTestingSession();
    const store = await createLocalApprovalStore(session);
    const request = await store.createApprovalRequest({
      action: "demo:write",
      data: { scope: "repo" },
      reason: "Need approval",
    });

    const approved = await store.approveApprovalRequest(request.requestId);
    const grantedApprovals = await store.listGrantedApprovals();

    expect(approved.status).toBe("approved");
    expect(approved.resolvedAt).toBeDefined();
    expect(grantedApprovals).toEqual([
      {
        action: "demo:write",
        data: { scope: "repo" },
      },
    ]);
  });

  it("denies a request without appending a granted approval", async () => {
    const session = await createTestingSession();
    const store = await createLocalApprovalStore(session);
    const request = await store.createApprovalRequest({
      action: "demo:write",
      data: { scope: "repo" },
      reason: "Need approval",
    });

    const denied = await store.denyApprovalRequest(request.requestId);
    const grantedApprovals = await store.listGrantedApprovals();

    expect(denied.status).toBe("denied");
    expect(denied.resolvedAt).toBeDefined();
    expect(grantedApprovals).toEqual([]);
  });

  it("rejects malformed request ids instead of turning them into paths", async () => {
    const session = await createTestingSession();
    const store = await createLocalApprovalStore(session);

    await expect(store.getApprovalRequest("../escape")).resolves.toBeNull();
    await expect(store.approveApprovalRequest("../escape")).rejects.toThrow("Approval request not found");
  });
});
