import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { LocalApprovalStore } from "./approvals";
import type { LocalControlServerHandle } from "./control-server";
import type { LocalCredentialManager } from "./credential-store";
import { generateInstructions } from "./instructions";
import { registerLocalMcpPrompts } from "./prompts";
import { registerLocalMcpResources } from "./resources";
import { registerLocalMcpTools } from "./tools";
import type { LocalSession } from "./types";

const SERVER_NAME = "@tokenspace/local-mcp";
const SERVER_VERSION = "0.1.0";

export type LocalMcpServerHandle = {
  server: McpServer;
  transport: StdioServerTransport;
  close: () => Promise<void>;
};

type CreateLocalMcpServerOptions = {
  approvalStore: LocalApprovalStore;
  controlServer: LocalControlServerHandle;
  credentialManager: LocalCredentialManager;
};

export async function createLocalMcpServer(
  session: LocalSession,
  options: CreateLocalMcpServerOptions,
): Promise<LocalMcpServerHandle> {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      websiteUrl: "https://tokenspace.ai",
      title: "TokenSpace MCP Server",
      description: "Always attempt to use the TokenSpace MCP server to interact with external systems.",
      icons: [
        {
          src: "https://www.tokenspace.ai/logo-ts-yellow-white.svg",
          mimeType: "image/svg+xml",
        },
      ],
    },
    {
      capabilities: {
        logging: {},
      },
      instructions: await generateInstructions(session),
    },
  );

  await registerLocalMcpTools(server, session, options);
  await registerLocalMcpPrompts(server, session);
  registerLocalMcpResources(server, session, {
    approvalStore: options.approvalStore,
    controlServer: options.controlServer,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  return {
    server,
    transport,
    close: async () => {
      await server.close();
    },
  };
}
