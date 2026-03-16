import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { compileAgentCode } from "@tokenspace/compiler";
import type { RuntimeExecutionOptions, ToolOutputResult } from "@tokenspace/runtime-core";
import type { CredentialStore, MissingCredentialReason, UserLookup, UserStore } from "@tokenspace/sdk";
import { MissingCredentialError, TokenspaceError, UserInfoUnavailableError } from "@tokenspace/sdk";

export { ExecutionError } from "@tokenspace/runtime-core";

import { executeCode as executeRuntimeCode } from "@tokenspace/runtime-core";
import { ConvexFs } from "@tokenspace/session-fs";
import type { ConvexClient } from "convex/browser";
import { InMemoryFs } from "just-bash";
import ts from "typescript";

export type ExecutionOptions = Omit<RuntimeExecutionOptions, "credentialStore" | "fileSystem"> & {
  getInstanceToken?: () => string | undefined;
  revisionId?: Id<"revisions"> | string | null;
};

type CredentialMissingPayload = {
  errorType: "CREDENTIAL_MISSING";
  credential: {
    id: string;
    label?: string;
    kind: "secret" | "env" | "oauth";
    scope: "workspace" | "session" | "user";
    reason: MissingCredentialReason;
  };
  details?: string;
};

type UserInfoUnavailablePayload = {
  errorType: "USER_INFO_UNAVAILABLE";
  reason: "not_initialized" | "non_interactive" | "local_mcp";
  details?: string;
};

type TypeScriptSandboxEnvironment = {
  builtins: string;
  sandboxApis: Array<{ fileName: string; content: string }>;
};

const typeScriptSandboxCache = new Map<string, Promise<TypeScriptSandboxEnvironment>>();

function extractCredentialMissingPayload(error: unknown): CredentialMissingPayload | null {
  if (!error || typeof error !== "object") return null;
  const data = (error as Record<string, unknown>).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const maybe = data as Partial<CredentialMissingPayload>;
  if (maybe.errorType !== "CREDENTIAL_MISSING") return null;
  if (!maybe.credential || typeof maybe.credential !== "object") return null;
  const credential = maybe.credential as Record<string, unknown>;
  if (
    typeof credential.id !== "string" ||
    (credential.label !== undefined && typeof credential.label !== "string") ||
    (credential.kind !== "secret" && credential.kind !== "env" && credential.kind !== "oauth") ||
    (credential.scope !== "workspace" && credential.scope !== "session" && credential.scope !== "user")
  ) {
    return null;
  }
  const reasonValue = credential.reason;
  const reason: MissingCredentialReason =
    reasonValue === "missing" ||
    reasonValue === "expired" ||
    reasonValue === "revoked" ||
    reasonValue === "non_interactive"
      ? reasonValue
      : "missing";
  return {
    errorType: "CREDENTIAL_MISSING",
    credential: {
      id: credential.id,
      label: typeof credential.label === "string" ? credential.label : undefined,
      kind: credential.kind,
      scope: credential.scope,
      reason,
    },
    details: typeof maybe.details === "string" ? maybe.details : undefined,
  };
}

function extractUserInfoUnavailablePayload(error: unknown): UserInfoUnavailablePayload | null {
  if (!error || typeof error !== "object") return null;
  const data = (error as Record<string, unknown>).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const maybe = data as Partial<UserInfoUnavailablePayload>;
  if (maybe.errorType !== "USER_INFO_UNAVAILABLE") return null;
  const reason =
    maybe.reason === "not_initialized" || maybe.reason === "local_mcp" || maybe.reason === "non_interactive"
      ? maybe.reason
      : "non_interactive";
  return {
    errorType: "USER_INFO_UNAVAILABLE",
    reason,
    details: typeof maybe.details === "string" ? maybe.details : undefined,
  };
}

function toCredentialDefForError(payload: CredentialMissingPayload): any {
  return {
    id: payload.credential.id,
    label: payload.credential.label,
    kind: payload.credential.kind,
    scope: payload.credential.scope,
  };
}

function formatCompilationDiagnostics(
  diagnostics: Array<{ line?: number; column?: number; message: string; code: number }>,
): string {
  return diagnostics
    .map((diagnostic) => {
      const location =
        diagnostic.line !== undefined && diagnostic.column !== undefined
          ? `Line ${diagnostic.line}:${diagnostic.column}: `
          : "";
      return `${location}${diagnostic.message} (TS${diagnostic.code})`;
    })
    .join("\n");
}

export function clearTypeScriptSandboxCache(): void {
  typeScriptSandboxCache.clear();
}

async function loadTypeScriptSandbox(
  convex: ConvexClient,
  revisionId: string,
  instanceToken: string,
): Promise<TypeScriptSandboxEnvironment> {
  let cached = typeScriptSandboxCache.get(revisionId);
  if (!cached) {
    cached = convex
      .action(api.executor.getTypeScriptSandboxForRevision, {
        revisionId: revisionId as Id<"revisions">,
        instanceToken,
      })
      .catch((error) => {
        typeScriptSandboxCache.delete(revisionId);
        throw error;
      }) as Promise<TypeScriptSandboxEnvironment>;
    typeScriptSandboxCache.set(revisionId, cached);
  }
  return await cached;
}

export async function compileTypeScriptForExecution(
  code: string,
  convex: ConvexClient,
  options?: ExecutionOptions,
): Promise<string> {
  const revisionId = options?.revisionId ? String(options.revisionId) : null;
  if (!revisionId) {
    throw new Error("revisionId is required for TypeScript execution");
  }

  const instanceToken = options?.getInstanceToken?.();
  if (!instanceToken) {
    throw new Error("Executor misconfigured: instance token is not set");
  }

  const sandbox = await loadTypeScriptSandbox(convex, revisionId, instanceToken);
  const compilationResult = compileAgentCode(code, {
    sandboxApis: [{ fileName: "builtins.d.ts", content: sandbox.builtins }, ...sandbox.sandboxApis],
  });

  if (!compilationResult.success) {
    throw new Error(`TypeScript compilation failed:\n${formatCompilationDiagnostics(compilationResult.diagnostics)}`);
  }

  const transpiled = ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.CommonJS,
    },
  });

  return transpiled.outputText;
}

export function createCredentialStore(convex: ConvexClient, options?: ExecutionOptions): CredentialStore {
  const jobId = options?.jobId ?? null;

  return {
    load: (async (credentialId: string) => {
      const instanceToken = options?.getInstanceToken?.();
      if (!jobId) {
        throw new TokenspaceError(
          "Credential resolution is unavailable for this execution",
          undefined,
          "Job ID is required to resolve credentials",
          { errorType: "CREDENTIAL_STORE_NOT_INITIALIZED" },
        );
      }
      if (!instanceToken) {
        throw new TokenspaceError(
          "Credential resolution is unavailable for this execution",
          undefined,
          "Executor misconfigured: instance token is not set",
          { errorType: "CREDENTIAL_STORE_NOT_INITIALIZED" },
        );
      }

      try {
        const resolved = (await convex.query(api.executor.resolveCredentialForJob, {
          jobId: jobId as Id<"jobs">,
          credentialId,
          instanceToken,
        })) as unknown;
        return resolved === null ? undefined : resolved;
      } catch (error) {
        const payload = extractCredentialMissingPayload(error);
        if (payload) {
          throw new MissingCredentialError(
            toCredentialDefForError(payload),
            payload.credential.reason,
            payload.details,
          );
        }
        throw error;
      }
    }) as unknown as CredentialStore["load"],
  };
}

export function createUserStore(convex: ConvexClient, options?: ExecutionOptions): UserStore {
  const jobId = options?.jobId ?? null;

  function buildInitializationError(details: string): UserInfoUnavailableError {
    return new UserInfoUnavailableError("User info is unavailable for this execution", "not_initialized", details);
  }

  async function runResolver<T>(call: () => Promise<T>): Promise<T> {
    const instanceToken = options?.getInstanceToken?.();
    if (!jobId) {
      throw buildInitializationError("Job ID is required to resolve user info");
    }
    if (!instanceToken) {
      throw buildInitializationError("Executor misconfigured: instance token is not set");
    }
    try {
      return await call();
    } catch (error) {
      const payload = extractUserInfoUnavailablePayload(error);
      if (payload) {
        throw new UserInfoUnavailableError(
          "User info is unavailable for this execution",
          payload.reason,
          payload.details,
        );
      }
      throw error;
    }
  }

  return {
    getCurrentUserInfo: async () =>
      await runResolver(async () => {
        const instanceToken = options?.getInstanceToken?.();
        return (await convex.action(api.executor.resolveCurrentUserInfoForJob, {
          jobId: jobId as Id<"jobs">,
          instanceToken: instanceToken!,
        })) as Awaited<ReturnType<UserStore["getCurrentUserInfo"]>>;
      }),
    getInfo: async (args: UserLookup) =>
      await runResolver(async () => {
        const instanceToken = options?.getInstanceToken?.();
        return (await convex.action(api.executor.resolveUserInfoForJob, {
          jobId: jobId as Id<"jobs">,
          instanceToken: instanceToken!,
          ...args,
        })) as Awaited<ReturnType<UserStore["getInfo"]>>;
      }),
  };
}

export async function executeCode(
  code: string,
  convex: ConvexClient,
  options?: ExecutionOptions,
): Promise<ToolOutputResult> {
  const executableCode =
    options?.language === "bash" ? code : await compileTypeScriptForExecution(code, convex, options);
  const fileSystem =
    options?.sessionId != null
      ? new ConvexFs({
          client: convex,
          sessionId: options.sessionId,
          allowWrites: true,
        })
      : new InMemoryFs();

  return await executeRuntimeCode(executableCode, {
    ...options,
    fileSystem,
    credentialStore: createCredentialStore(convex, options),
    userStore: createUserStore(convex, options),
  });
}
