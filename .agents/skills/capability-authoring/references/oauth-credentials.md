# OAuth Credentials for Capabilities

Use this reference when a capability needs OAuth-based API access.

## Definition Pattern (`src/credentials.ts`)

```ts
import { credentials } from "@tokenspace/sdk";

export const linearClientSecret = credentials.secret({
  name: "linear-client-secret",
  description: "Linear client secret used for OAuth",
  scope: "workspace",
});

export const linearApiKey = credentials.oauth({
  name: "linear-api-key",
  description: "Linear API key for the SiftD Linear workspace",
  scope: "workspace",
  config: {
    grantType: "authorization_code",
    clientId: "1234567890",
    clientSecret: credentials.ref(linearClientSecret),
    authorizeUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    scopes: ["read", "write", "issues:create", "comments:create"],
  },
});
```

## Consumption Pattern (`capability.ts`)

```ts
import { action, getCredential } from "@tokenspace/sdk";
import z from "zod";
import { linearApiKey } from "../../credentials";

export const listResources = action(z.object({}), async () => {
  const oauth = await getCredential(linearApiKey);
  const token = oauth.accessToken;
  return { hasToken: token.length > 0 };
});
```

## Scope Selection

- `scope: "user"`: per-user identity and permissions.
- `scope: "workspace"`: shared integration account used by all users.
- `scope: "session"`: temporary credential scoped to one session.

## Practical Rules

- Prefer `credentials.ref(secretDef)` for `clientSecret` instead of hardcoding literals.
- Keep credential names unique in `src/credentials.ts`; names are workspace-global.
- Treat missing required user/session credentials as expected failure cases in automation and background runs.
- Use `optional: true` only when capability behavior can degrade safely without the token.
