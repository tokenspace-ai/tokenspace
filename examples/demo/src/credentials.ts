import { credentials } from "@tokenspace/sdk";

export const splunkHost = credentials.env({
  id: "splunk-host",
  group: "Splunk",
  icon: "./capabilities/splunk/icon.svg",
  variableName: "SPLUNK_HOST",
  description: "Host of the Splunk instance",
});

export const splunkUser = credentials.env({
  id: "splunk-user",
  group: "Splunk",
  icon: "./capabilities/splunk/icon.svg",
  variableName: "SPLUNK_USER",
  description: "User of the Splunk instance",
});

export const splunkPassword = credentials.env({
  id: "splunk-password",
  group: "Splunk",
  icon: "./capabilities/splunk/icon.svg",
  variableName: "SPLUNK_PASSWORD",
  description: "Password of the Splunk user",
});

export const datadogApiKey = credentials.secret({
  id: "datadog-api-key",
  group: "Datadog",
  icon: "./capabilities/datadog/icon.svg",
  label: "API Key",
  description:
    "Create an API key in the Datadog organization settings under [API Keys](https://us5.datadoghq.com/organization-settings/api-keys).",
  scope: "workspace",
});

export const datadogAppKey = credentials.secret({
  id: "datadog-app-key",
  group: "Datadog",
  icon: "./capabilities/datadog/icon.svg",
  label: "App Key",
  description:
    "Create an application key in the Datadog settings under [Application Keys](https://us5.datadoghq.com/personal-settings/application-keys).",
  scope: "workspace",
});

export const githubToken = credentials.env({
  id: "github-token",
  group: "GitHub",
  icon: "./capabilities/github/icon.svg",
  label: "Readonly Token",
  description: "Personal access token with read-only permissions",
  variableName: "GITHUB_TOKEN",
});

export const linearClientId = credentials.secret({
  id: "linear-client-id",
  group: "Linear",
  icon: "./capabilities/linear/icon.svg",
  label: "Client ID",
  description:
    "Linear client ID used for OAuth.\n\nCreate an OAuth application in Linear's **API settings**. Use the following callback URL:\n```https://app.tokenspace.ai/oauth/callback```",
  scope: "workspace",
});

export const linearClientSecret = credentials.secret({
  id: "linear-client-secret",
  group: "Linear",
  icon: "./capabilities/linear/icon.svg",
  label: "Client Secret",
  description: "Client secret of your Linear OAuth application",
  scope: "workspace",
});

export const linearApiKey = credentials.oauth({
  id: "linear-api-key",
  group: "Linear",
  icon: "./capabilities/linear/icon.svg",
  label: "OAuth API Key",
  description: "Linear API key for the Linear workspace",
  scope: "workspace",
  config: {
    grantType: "authorization_code",
    clientId: credentials.ref(linearClientId),
    clientSecret: credentials.ref(linearClientSecret),
    authorizeUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    scopes: ["read", "write"],
  },
});
