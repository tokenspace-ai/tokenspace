export type CredentialRequirement = {
  id: string;
  label?: string;
  group?: string;
  kind: "secret" | "env" | "oauth";
  scope: "workspace" | "session" | "user";
  description?: string;
  iconPath?: string;
  placeholder?: string;
  optional?: boolean;
  config?: unknown;
};
