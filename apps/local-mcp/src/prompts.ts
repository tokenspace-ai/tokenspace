import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { generateSystemInstructionsPrompt } from "./instructions";
import type { LocalSession } from "./types";

export async function registerLocalMcpPrompts(server: McpServer, session: LocalSession): Promise<void> {
  server.registerPrompt(
    "system-instructions",
    {
      title: "System Instructions",
      description: "General guidance for runCode, the virtual filesystem, approvals, and available skills.",
    },
    async () => ({
      description:
        "General Tokenspace local MCP instructions for clients that do not surface server instructions well.",
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: await generateSystemInstructionsPrompt(session),
          },
        },
      ],
    }),
  );
}
