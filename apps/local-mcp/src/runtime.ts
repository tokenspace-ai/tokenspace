import type { RuntimeExecutionOptions, ToolOutputResult } from "@tokenspace/runtime-core";
import { executeCode } from "@tokenspace/runtime-core";
import type { UserStore } from "@tokenspace/sdk";
import { UserInfoUnavailableError } from "@tokenspace/sdk";
import type { LocalSession } from "./types";

type ExecuteLocalSessionOptions = Omit<RuntimeExecutionOptions, "bundlePath" | "fileSystem" | "sessionId">;

const localMcpUserStore: UserStore = {
  getCurrentUserInfo: async () => {
    throw new UserInfoUnavailableError(
      "User info is unavailable in local MCP sessions",
      "local_mcp",
      "The users API is only available in full Tokenspace server executions.",
    );
  },
  getInfo: async () => {
    throw new UserInfoUnavailableError(
      "User info is unavailable in local MCP sessions",
      "local_mcp",
      "The users API is only available in full Tokenspace server executions.",
    );
  },
};

export async function executeLocalSessionCode(
  session: LocalSession,
  code: string,
  options?: ExecuteLocalSessionOptions,
): Promise<ToolOutputResult> {
  return await executeCode(code, {
    ...options,
    bundlePath: session.bundlePath,
    fileSystem: session.fileSystem,
    sessionId: session.manifest.sessionId,
    userStore: localMcpUserStore,
  });
}

export async function executeLocalSessionBash(
  session: LocalSession,
  command: string,
  options?: Omit<ExecuteLocalSessionOptions, "language">,
): Promise<ToolOutputResult> {
  return await executeLocalSessionCode(session, command, {
    ...options,
    language: "bash",
  });
}
