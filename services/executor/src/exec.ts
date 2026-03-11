import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import type { RuntimeExecutionOptions, ToolOutputResult } from "@tokenspace/runtime-core";
import type { CredentialStore, MissingCredentialReason } from "@tokenspace/sdk";
import { MissingCredentialError, TokenspaceError } from "@tokenspace/sdk";

export { ExecutionError } from "@tokenspace/runtime-core";

import { executeCode as executeRuntimeCode } from "@tokenspace/runtime-core";
import { ConvexFs } from "@tokenspace/session-fs";
import type { ConvexClient } from "convex/browser";
import { InMemoryFs } from "just-bash";

export type ExecutionOptions = Omit<RuntimeExecutionOptions, "credentialStore" | "fileSystem">;

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

function toCredentialDefForError(payload: CredentialMissingPayload): any {
  return {
    id: payload.credential.id,
    label: payload.credential.label,
    kind: payload.credential.kind,
    scope: payload.credential.scope,
  };
}

function createCredentialStore(convex: ConvexClient, options?: ExecutionOptions): CredentialStore {
  const jobId = options?.jobId ?? null;
  const executorToken = process.env.TOKENSPACE_EXECUTOR_TOKEN?.trim();

  return {
    load: (async (credentialId: string) => {
      if (!jobId) {
        throw new TokenspaceError(
          "Credential resolution is unavailable for this execution",
          undefined,
          "Job ID is required to resolve credentials",
          { errorType: "CREDENTIAL_STORE_NOT_INITIALIZED" },
        );
      }
      if (!executorToken) {
        throw new TokenspaceError(
          "Credential resolution is unavailable for this execution",
          undefined,
          "Executor misconfigured: TOKENSPACE_EXECUTOR_TOKEN is not set",
          { errorType: "CREDENTIAL_STORE_NOT_INITIALIZED" },
        );
      }

      try {
        const resolved = (await convex.query(api.executor.resolveCredentialForJob, {
          jobId: jobId as Id<"jobs">,
          credentialId,
          executorToken,
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

export async function executeCode(
  code: string,
  convex: ConvexClient,
  options?: ExecutionOptions,
): Promise<ToolOutputResult> {
  const fileSystem =
    options?.sessionId != null
      ? new ConvexFs({
          client: convex,
          sessionId: options.sessionId,
          allowWrites: true,
        })
      : new InMemoryFs();

  return await executeRuntimeCode(code, {
    ...options,
    fileSystem,
    credentialStore: createCredentialStore(convex, options),
  });
}
