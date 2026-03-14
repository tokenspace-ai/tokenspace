import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type ActionCtx, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";

const textEncoder = new TextEncoder();

const TOKEN_SELECTOR_BYTES = 12;
const TOKEN_SECRET_BYTES = 32;

export const EXECUTOR_IMAGE = "ghcr.io/tokenspace/executor:latest";
export const EXECUTOR_BOOTSTRAP_ENV_VAR = "TOKENSPACE_EXECUTOR_BOOTSTRAP_TOKEN";
export const EXECUTOR_CONVEX_URL_ENV_VAR = "CONVEX_URL";
export const EXECUTOR_HEARTBEAT_INTERVAL_MS = 30_000;
export const EXECUTOR_HEARTBEAT_TIMEOUT_MS = 90_000;
export const EXECUTOR_INSTANCE_TOKEN_TTL_MS = 15 * 60_000;
export const EXECUTOR_INSTANCE_TOKEN_REFRESH_WINDOW_MS = 5 * 60_000;

type ExecutorAuthCtx = QueryCtx | MutationCtx | ActionCtx;

export type VerifiedExecutorIdentity = {
  executorId: Id<"executors">;
  instanceId?: Id<"executorInstances">;
  tokenVersion: number;
};

export type ExecutorSetupPayload = {
  image: string;
  requiredEnvVars: string[];
  bootstrapTokenEnvVar: string;
  convexUrlEnvVar: string;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  instanceTokenTtlMs: number;
  instanceTokenRefreshWindowMs: number;
  snippets: {
    docker: string;
    raw: string;
  };
};

type OpaqueTokenParts = {
  token: string;
  tokenId: string;
  tokenHash: string;
};

type ParsedOpaqueToken = {
  tokenId: string;
  secret: string;
};

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const base64 =
    typeof btoa === "function"
      ? btoa(binary)
      : (
          globalThis as { Buffer?: { from: (bytes: Uint8Array) => { toString: (encoding: string) => string } } }
        ).Buffer?.from(bytes).toString("base64");
  if (!base64) {
    throw new Error("Base64 encoding is unavailable in this runtime");
  }
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

async function lookupExecutorByBootstrapTokenId(
  ctx: ExecutorAuthCtx,
  bootstrapTokenId: string,
): Promise<Doc<"executors"> | null> {
  if ("db" in ctx) {
    return await ctx.db
      .query("executors")
      .withIndex("by_bootstrap_token_id", (q) => q.eq("bootstrapTokenId", bootstrapTokenId))
      .first();
  }
  return await ctx.runQuery(internal.executorAuth.getExecutorByBootstrapTokenIdInternal, { bootstrapTokenId });
}

async function lookupInstanceByTokenId(
  ctx: ExecutorAuthCtx,
  instanceTokenId: string,
): Promise<Doc<"executorInstances"> | null> {
  if ("db" in ctx) {
    return await ctx.db
      .query("executorInstances")
      .withIndex("by_instance_token_id", (q) => q.eq("instanceTokenId", instanceTokenId))
      .first();
  }
  return await ctx.runQuery(internal.executorAuth.getExecutorInstanceByTokenIdInternal, { instanceTokenId });
}

async function lookupExecutorById(ctx: ExecutorAuthCtx, executorId: Id<"executors">): Promise<Doc<"executors"> | null> {
  if ("db" in ctx) {
    return await ctx.db.get(executorId);
  }
  return await ctx.runQuery(internal.executors.getExecutorInternal, { executorId });
}

export async function createOpaqueToken(): Promise<OpaqueTokenParts> {
  const tokenId = toBase64Url(randomBytes(TOKEN_SELECTOR_BYTES));
  const secret = toBase64Url(randomBytes(TOKEN_SECRET_BYTES));
  return {
    token: `${tokenId}.${secret}`,
    tokenId,
    tokenHash: await sha256Hex(secret),
  };
}

export function parseOpaqueToken(token: string): ParsedOpaqueToken {
  const trimmed = token.trim();
  const delimiter = trimmed.indexOf(".");
  if (delimiter <= 0 || delimiter === trimmed.length - 1 || trimmed.indexOf(".", delimiter + 1) !== -1) {
    throw new Error("Invalid executor token");
  }
  return {
    tokenId: trimmed.slice(0, delimiter),
    secret: trimmed.slice(delimiter + 1),
  };
}

export async function verifyOpaqueToken(secret: string, expectedHash: string): Promise<boolean> {
  return (await sha256Hex(secret)) === expectedHash;
}

export function shouldRotateInstanceToken(expiresAt: number, now: number = Date.now()): boolean {
  return expiresAt - now <= EXECUTOR_INSTANCE_TOKEN_REFRESH_WINDOW_MS;
}

export function buildExecutorSetupPayload(bootstrapToken: string): ExecutorSetupPayload {
  return {
    image: EXECUTOR_IMAGE,
    requiredEnvVars: [EXECUTOR_CONVEX_URL_ENV_VAR, EXECUTOR_BOOTSTRAP_ENV_VAR],
    bootstrapTokenEnvVar: EXECUTOR_BOOTSTRAP_ENV_VAR,
    convexUrlEnvVar: EXECUTOR_CONVEX_URL_ENV_VAR,
    heartbeatIntervalMs: EXECUTOR_HEARTBEAT_INTERVAL_MS,
    heartbeatTimeoutMs: EXECUTOR_HEARTBEAT_TIMEOUT_MS,
    instanceTokenTtlMs: EXECUTOR_INSTANCE_TOKEN_TTL_MS,
    instanceTokenRefreshWindowMs: EXECUTOR_INSTANCE_TOKEN_REFRESH_WINDOW_MS,
    snippets: {
      docker: [
        "docker run \\",
        `  -e ${EXECUTOR_CONVEX_URL_ENV_VAR}="<your-convex-url>" \\`,
        `  -e ${EXECUTOR_BOOTSTRAP_ENV_VAR}="${bootstrapToken}" \\`,
        `  ${EXECUTOR_IMAGE}`,
      ].join("\n"),
      raw: [
        `export ${EXECUTOR_CONVEX_URL_ENV_VAR}="<your-convex-url>"`,
        `export ${EXECUTOR_BOOTSTRAP_ENV_VAR}="${bootstrapToken}"`,
        "bun run ./services/executor/src/main.ts",
      ].join("\n"),
    },
  };
}

export async function verifyExecutorBootstrapToken(
  ctx: ExecutorAuthCtx,
  bootstrapToken: string,
): Promise<{ executor: Doc<"executors"> } & VerifiedExecutorIdentity> {
  const parsed = parseOpaqueToken(bootstrapToken);
  const executor = await lookupExecutorByBootstrapTokenId(ctx, parsed.tokenId);
  if (!executor || !(await verifyOpaqueToken(parsed.secret, executor.bootstrapTokenHash))) {
    throw new Error("Unauthorized");
  }
  if (executor.status !== "active") {
    throw new Error("Executor is not active");
  }
  return {
    executor,
    executorId: executor._id,
    tokenVersion: executor.tokenVersion,
  };
}

export async function verifyExecutorInstanceToken(
  ctx: ExecutorAuthCtx,
  instanceToken: string,
  now: number = Date.now(),
): Promise<{ executor: Doc<"executors">; instance: Doc<"executorInstances"> } & VerifiedExecutorIdentity> {
  const parsed = parseOpaqueToken(instanceToken);
  const instance = await lookupInstanceByTokenId(ctx, parsed.tokenId);
  if (!instance || !(await verifyOpaqueToken(parsed.secret, instance.instanceTokenHash))) {
    throw new Error("Unauthorized");
  }
  if (instance.instanceTokenExpiresAt < now) {
    throw new Error("Executor instance token expired");
  }

  const executor = await lookupExecutorById(ctx, instance.executorId);
  if (!executor) {
    throw new Error("Executor not found");
  }
  if (executor.status !== "active") {
    throw new Error("Executor is not active");
  }
  if (executor.tokenVersion !== instance.tokenVersion) {
    throw new Error("Executor token version mismatch");
  }
  if (instance.status !== "online") {
    throw new Error("Executor instance is not online");
  }

  return {
    executor,
    instance,
    executorId: executor._id,
    instanceId: instance._id,
    tokenVersion: executor.tokenVersion,
  };
}

export const getExecutorByBootstrapTokenIdInternal = internalQuery({
  args: {
    bootstrapTokenId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("executors")
      .withIndex("by_bootstrap_token_id", (q) => q.eq("bootstrapTokenId", args.bootstrapTokenId))
      .first();
  },
});

export const getExecutorInstanceByTokenIdInternal = internalQuery({
  args: {
    instanceTokenId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("executorInstances")
      .withIndex("by_instance_token_id", (q) => q.eq("instanceTokenId", args.instanceTokenId))
      .first();
  },
});
