export type SessionInfo = {
  sessionId: string;
  workspaceName: string;
  workspaceDir: string;
  sessionRoot: string;
  sandboxDir: string;
  buildDir: string;
  sourceFingerprint: string;
  buildOrigin: string;
  controlBaseUrl: string;
  capabilities: CapabilityInfo[];
  skills: SkillInfo[];
};

export type CapabilityInfo = {
  name: string;
  description: string;
  namespace: string;
};

export type SkillInfo = {
  name: string;
  description: string;
};

export type ApprovalRequestStatus = "pending" | "approved" | "denied";

export type ApprovalRequest = {
  requestId: string;
  action: string;
  description?: string;
  reason: string;
  data?: unknown;
  info?: unknown;
  status: ApprovalRequestStatus;
  createdAt: string;
  resolvedAt?: string;
  resolvedVia?: string;
};

export type CredentialKind = "secret" | "env" | "oauth";
export type CredentialStatus = "configured" | "missing" | "unsupported";

export type CredentialSummary = {
  id: string;
  label?: string;
  group?: string;
  description?: string;
  kind: CredentialKind;
  scope: string;
  optional: boolean;
  status: CredentialStatus;
  configured?: boolean;
  placeholder?: string;
  effectiveScope?: string;
  variableName?: string;
  supported: boolean;
  unsupportedReason?: string;
  localScopeNote?: string;
  overridden?: boolean;
};
