export type { CommandContext, ExecResult } from "just-bash";

export type TokenspaceCommandHandler = (
  args: string[],
  ctx: import("just-bash").CommandContext,
) => Promise<import("just-bash").ExecResult> | import("just-bash").ExecResult;
