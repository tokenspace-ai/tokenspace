import {
  action,
  getCredential,
  Logger,
  parseResponseBody,
  request,
  requireApproval,
  TokenspaceError,
} from "@tokenspace/sdk";
import z, { prettifyError } from "zod";
import { splunkHost, splunkPassword, splunkUser } from "../../credentials";

const log = new Logger("splunk");

const CONFIG = {
  app: "search",
  allowInvalidTLS: true,
} as const;

export type SearchSplunkResult = {
  rows: Record<string, string | string[]>[];
};

const splunkSearchResponseSchema = z.object({
  preview: z.optional(z.boolean()),
  init_offset: z.optional(z.number()),
  messages: z.array(z.unknown()),
  fields: z.optional(z.array(z.object({ name: z.string() }))),
  results: z.array(z.record(z.string(), z.string().or(z.array(z.string())))),
});

function serializeHeaders(headers?: Headers): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  return Object.fromEntries(headers.entries());
}

class SplunkSearchError extends TokenspaceError {
  constructor(
    message: string,
    public readonly response?: Response,
    details?: string,
  ) {
    super(message, undefined, details, { status: response?.status, headers: serializeHeaders(response?.headers) });
    this.name = "SplunkSearchError";
  }
}

function makeSearchParam(query: string) {
  return query.trim().startsWith("|") ? query.trim().slice(1) : `search ${query}`;
}

export type SplunkApiRequestResult = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export const searchSplunk = action(
  z.object({
    query: z.string().describe("Query SPL"),
    timeRange: z.object({
      earliest: z.string().describe("Relative time specifier, such as '-24h', or '2025-01-01T00:00:00Z'"),
      latest: z.string().describe("Relative time specifier or 'now'"),
    }),
    limit: z.number().default(100).describe("Maximum number of results to return"),
  }),
  async (args): Promise<SearchSplunkResult> => {
    const user = await getCredential(splunkUser);
    const url = new URL(await getCredential(splunkHost));
    url.pathname = `/servicesNS/${encodeURIComponent(user)}/${encodeURIComponent(CONFIG.app ?? "search")}/search/jobs`;

    const body = new URLSearchParams();
    body.append("output_mode", "json");
    body.append("exec_mode", "oneshot");
    body.append("search", makeSearchParam(args.query));
    body.append("earliest_time", args.timeRange.earliest);
    body.append("latest_time", args.timeRange.latest);
    body.append("max_count", args.limit.toString());

    const response = await request({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      auth: {
        type: "basic",
        username: user,
        password: await getCredential(splunkPassword),
      },
      tls: CONFIG.allowInvalidTLS
        ? {
            rejectUnauthorized: false,
            checkServerIdentity: () => undefined,
          }
        : undefined,
      checkResponseStatus: false,
    });

    if (!response.ok) {
      const body = await parseResponseBody(response).catch(() => null);
      log.error(`Splunk search failed: ${response.statusText}`, body);
      throw new SplunkSearchError(
        `Splunk search failed: ${response.statusText}`,
        response,
        typeof body === "string" ? body : JSON.stringify(body),
      );
    }

    const result = await response.json();
    const parsed = splunkSearchResponseSchema.safeParse(result);
    if (parsed.success === false) {
      const parseError = "error" in parsed ? parsed.error : undefined;
      throw new SplunkSearchError(
        "Unexpected response from Splunk server",
        response,
        parseError ? prettifyError(parseError) : undefined,
      );
    }
    return {
      rows: parsed.data.results,
    };
  },
);

export const splunkApiRequest = action(
  z.object({
    method: z.enum(["GET", "POST", "PUT", "DELETE"] as const),
    path: z.string(),
    body: z.optional(z.record(z.string(), z.string())),
    headers: z.optional(z.record(z.string(), z.string())),
  }),
  async (args): Promise<SplunkApiRequestResult> => {
    const requestHeaders = { ...args.headers };

    if (args.body && !Object.keys(requestHeaders).some((key) => key.toLowerCase() === "content-type")) {
      requestHeaders["Content-Type"] = "application/x-www-form-urlencoded";
    }

    if (args.method !== "GET") {
      await requireApproval({
        action: "splunk:apiRequest",
        data: {
          method: args.method,
          path: args.path,
        },
        info: {
          body: args.body,
          headers: args.headers,
        },
        description: `Execute ${args.method} request to ${args.path}`,
      });
    }

    const url = new URL(await getCredential(splunkHost));
    url.pathname = args.path;

    const response = await request({
      url: url.toString(),
      method: args.method,
      headers: Object.keys(requestHeaders).length > 0 ? requestHeaders : undefined,
      body: args.body ? new URLSearchParams(args.body) : undefined,
      auth: {
        type: "basic",
        username: await getCredential(splunkUser),
        password: await getCredential(splunkPassword),
      },
      tls: CONFIG.allowInvalidTLS
        ? {
            rejectUnauthorized: false,
            checkServerIdentity: () => undefined,
          }
        : undefined,
    });

    if (!response.ok) {
      throw new Error(`Splunk API request failed: ${response.statusText}`);
    }

    const body = await response.text();
    const responseHeaders = Object.fromEntries(response.headers.entries());
    return {
      status: response.status,
      headers: responseHeaders,
      body,
    };
  },
);
