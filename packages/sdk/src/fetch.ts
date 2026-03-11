import type { JSONValue } from "./builtin-types";
import { TokenspaceError } from "./error";
import { Logger } from "./logger";

const log = new Logger("fetch");

export class FetchError extends TokenspaceError {
  constructor(
    message: string,
    public readonly response?: Response,
    public readonly cause?: Error,
  ) {
    super(message, cause);
    this.name = "TokenspaceFetchError";
  }
}

type AuthConfig = { type: "basic"; username: string; password: string } | { type: "bearer"; token: string };

export function makeAuthHeaders(auth: AuthConfig | undefined): Record<string, string> | undefined {
  if (auth == null) {
    return undefined;
  }
  if (auth.type === "basic") {
    return { Authorization: `Basic ${btoa(`${auth.username ?? ""}:${auth.password ?? ""}`)}` };
  }
  if (auth.type === "bearer") {
    return { Authorization: `Bearer ${auth.token}` };
  }
  return undefined;
}

function makeHeaders(...parts: (Record<string, string> | undefined)[]): Record<string, string> {
  return Object.assign({}, ...parts.filter((p) => p != null));
}

function headersToRecord(headers: Bun.HeadersInit | undefined): Record<string, string> | undefined {
  if (headers == null) {
    return undefined;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  if (headers instanceof Headers) {
    // Use forEach to iterate over Headers since tsc doesn't always recognize it as iterable
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }
  // Flatten ReadonlyArray values to strings (take first value)
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = Array.isArray(value) ? (value[0] ?? "") : value;
  }
  return result;
}

export async function request({
  url,
  checkResponseStatus = true,
  ...req
}: BunFetchRequestInit & { url: string | URL; checkResponseStatus?: boolean; auth?: AuthConfig }): Promise<Response> {
  try {
    log.debug(`Fetching ${req.method} ${url}`);
    const response = await fetch(url, {
      ...req,
      headers: makeHeaders(makeAuthHeaders(req.auth), headersToRecord(req.headers)),
    });
    log.debug(`Received response ${response.status} ${response.statusText}`);

    if (checkResponseStatus) {
      if (!response.ok) {
        throw new FetchError(`Request failed with status ${response.status}`, response);
      }
    }

    return response;
  } catch (e: any) {
    if (e instanceof FetchError) {
      throw e;
    }
    if (e instanceof TypeError && e.message.includes("failed to fetch")) {
      throw new FetchError(`HTTP request ${req.method} ${url} failed`);
    }
    throw new FetchError(`HTTP request ${req.method} ${url} failed: ${e.message}`, undefined, e);
  }
}

export async function parseResponseBody(response: Response): Promise<string | JSONValue> {
  const contentType = response.headers.get("content-type");
  if (contentType?.includes("application/json")) {
    return (await response.json()) as JSONValue;
  }
  return await response.text();
}
