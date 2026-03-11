import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LocalApprovalStore } from "./approvals";
import type { LocalControlServerHandle } from "./control-server";
import type { LocalSession } from "./types";

const SESSION_MANIFEST_URI = "tokenspace://session/manifest";
const WORKSPACE_METADATA_URI = "tokenspace://workspace/metadata";
const WORKSPACE_TOKENSPACE_MD_URI = "tokenspace://workspace/token-space-md";
const APPROVALS_PENDING_URI = "tokenspace://approvals/pending";

function toJsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

type RegisterLocalMcpResourcesOptions = {
  approvalStore: LocalApprovalStore;
  controlServer: LocalControlServerHandle;
};

export function registerLocalMcpResources(
  server: McpServer,
  session: LocalSession,
  { approvalStore, controlServer }: RegisterLocalMcpResourcesOptions,
): void {
  server.registerResource(
    "session-manifest",
    SESSION_MANIFEST_URI,
    {
      title: "Tokenspace Session Manifest",
      description: "Session metadata, control URL, and build origin for the current local MCP process.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: SESSION_MANIFEST_URI,
          mimeType: "application/json",
          text: toJsonText({
            ...session.manifest,
            controlBaseUrl: controlServer.baseUrl,
          }),
        },
      ],
    }),
  );

  server.registerResource(
    "workspace-metadata",
    WORKSPACE_METADATA_URI,
    {
      title: "Tokenspace Workspace Metadata",
      description: "Compiler metadata for the current Tokenspace workspace.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: WORKSPACE_METADATA_URI,
          mimeType: "application/json",
          text: toJsonText(session.buildResult.metadata),
        },
      ],
    }),
  );

  const tokenspaceMd = session.buildResult.metadata.tokenspaceMd;
  if (tokenspaceMd) {
    server.registerResource(
      "workspace-token-space-md",
      WORKSPACE_TOKENSPACE_MD_URI,
      {
        title: "TOKENSPACE.md",
        description: "Workspace-specific instructions from TOKENSPACE.md, when present.",
        mimeType: "text/markdown",
      },
      async () => ({
        contents: [
          {
            uri: WORKSPACE_TOKENSPACE_MD_URI,
            mimeType: "text/markdown",
            text: tokenspaceMd,
          },
        ],
      }),
    );
  }

  server.registerResource(
    "approvals-pending",
    APPROVALS_PENDING_URI,
    {
      title: "Pending Approval Requests",
      description: "Pending approvals that can be reviewed in the local control server.",
      mimeType: "application/json",
    },
    async () => {
      const approvals = await approvalStore.listApprovalRequests();
      const pendingApprovals = approvals
        .filter((approval) => approval.status === "pending")
        .map((approval) => ({
          requestId: approval.requestId,
          action: approval.action,
          reason: approval.reason,
          description: approval.description,
          createdAt: approval.createdAt,
          approvalUrl: controlServer.getApprovalUrl(approval.requestId),
        }));

      return {
        contents: [
          {
            uri: APPROVALS_PENDING_URI,
            mimeType: "application/json",
            text: toJsonText(pendingApprovals),
          },
        ],
      };
    },
  );
}
