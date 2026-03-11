import type { RuntimeExecutionOptions, ToolOutputResult } from "@tokenspace/runtime-core";
import { executeCode } from "@tokenspace/runtime-core";
import type { LocalSession } from "./types";

type ExecuteLocalSessionOptions = Omit<RuntimeExecutionOptions, "bundlePath" | "fileSystem" | "sessionId">;

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
