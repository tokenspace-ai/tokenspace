import type { CommandContext, ExecResult } from "@tokenspace/commands";
import { requireApproval } from "@tokenspace/sdk";
import { z } from "zod";

const schema = z
  .object({
    ok: z.boolean(),
    n: z.number().optional(),
  })
  .passthrough();

export default async function validateJson(args: string[], ctx: CommandContext): Promise<ExecResult> {
  if (args.includes("--require-approval")) {
    requireApproval({
      action: "testing:validate_json",
      data: { command: "validate_json" },
      description: "Allow validate_json to run in approved mode",
    });
  }

  const input = ctx.stdin.trim();
  if (!input) {
    return { stdout: "no input\n", stderr: "", exitCode: 0 };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    return { stdout: "", stderr: `invalid json: ${String(error)}\n`, exitCode: 1 };
  }

  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    return { stdout: "", stderr: `schema mismatch: ${validated.error.message}\n`, exitCode: 1 };
  }

  const n = validated.data.n;
  return {
    stdout: `valid ok=${validated.data.ok}${n === undefined ? "" : ` n=${n}`}\n`,
    stderr: "",
    exitCode: 0,
  };
}
