import { credentials } from "@tokenspace/sdk";

export const workspaceSecret = credentials.secret({
  id: "workspace-secret",
  label: "Workspace Secret",
  group: "Secrets",
  description: "Workspace secret for local MCP integration tests",
  icon: "./capabilities/credentials/workspace-secret.svg",
  scope: "workspace",
});

export const sessionSecret = credentials.secret({
  id: "session-secret",
  label: "Session Secret",
  group: "Secrets",
  description: "Session secret for local MCP integration tests",
  scope: "session",
});

export const userSecret = credentials.secret({
  id: "user-secret",
  label: "User Secret",
  group: "Secrets",
  description: "User secret for local MCP integration tests",
  scope: "user",
});

export const workspaceEnv = credentials.env({
  id: "workspace-env",
  label: "Workspace Env",
  group: "Environment",
  description: "Workspace env for local MCP integration tests",
  variableName: "TOK_LOCAL_MCP_SERVER_TEST_ENV",
});

export const workspaceOauth = credentials.oauth({
  id: "workspace-oauth",
  label: "Workspace OAuth",
  group: "OAuth",
  description: "Workspace oauth for local MCP integration tests",
  icon: "../docs/workspace-oauth.svg",
  scope: "workspace",
  config: {
    grantType: "authorization_code",
    clientId: "client-id",
    clientSecret: "client-secret",
    authorizeUrl: "https://example.com/authorize",
    tokenUrl: "https://example.com/token",
    scopes: ["read"],
  },
});
