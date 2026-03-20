import type { Readable } from "node:stream";

export function stripSingleTrailingNewline(value: string): string {
  if (value.endsWith("\r\n")) {
    return value.slice(0, -2);
  }
  if (value.endsWith("\n")) {
    return value.slice(0, -1);
  }
  return value;
}

export async function readStdinValue(input: Readable = process.stdin): Promise<string> {
  let value = "";
  for await (const chunk of input) {
    value += chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8") : String(chunk);
  }
  return stripSingleTrailingNewline(value);
}
