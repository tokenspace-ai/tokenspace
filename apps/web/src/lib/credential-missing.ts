export type CredentialMissingPayload = {
  errorType: "CREDENTIAL_MISSING";
  credential: {
    id: string;
    label?: string;
    kind: "secret" | "env" | "oauth";
    scope: "workspace" | "session" | "user";
    reason: "missing" | "expired" | "revoked" | "non_interactive";
  };
  details?: string;
};

export function parseCredentialMissingPayload(data: unknown): CredentialMissingPayload | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const maybe = data as Partial<CredentialMissingPayload>;
  if (maybe.errorType !== "CREDENTIAL_MISSING") return null;
  if (!maybe.credential || typeof maybe.credential !== "object" || Array.isArray(maybe.credential)) return null;
  const credential = maybe.credential as Record<string, unknown>;
  if (
    typeof credential.id !== "string" ||
    (credential.label !== undefined && typeof credential.label !== "string") ||
    (credential.kind !== "secret" && credential.kind !== "env" && credential.kind !== "oauth") ||
    (credential.scope !== "workspace" && credential.scope !== "session" && credential.scope !== "user") ||
    (credential.reason !== "missing" &&
      credential.reason !== "expired" &&
      credential.reason !== "revoked" &&
      credential.reason !== "non_interactive")
  ) {
    return null;
  }
  return {
    errorType: "CREDENTIAL_MISSING",
    credential: {
      id: credential.id,
      label: typeof credential.label === "string" ? credential.label : undefined,
      kind: credential.kind,
      scope: credential.scope,
      reason: credential.reason,
    },
    details: typeof maybe.details === "string" ? maybe.details : undefined,
  };
}

function displayName(payload: CredentialMissingPayload): string {
  return payload.credential.label ?? payload.credential.id;
}

export function credentialMissingHint(payload: CredentialMissingPayload, retryLabel = "re-run"): string {
  if (payload.credential.reason === "non_interactive") {
    return "This run needs session/user context and cannot resolve this credential in the current mode.";
  }
  if (payload.credential.reason === "missing") {
    return `Configure "${displayName(payload)}" for ${payload.credential.scope} scope, then ${retryLabel}.`;
  }
  if (payload.credential.reason === "expired") {
    return `Refresh "${displayName(payload)}" and ${retryLabel}.`;
  }
  return `Reconnect "${displayName(payload)}" and ${retryLabel}.`;
}
