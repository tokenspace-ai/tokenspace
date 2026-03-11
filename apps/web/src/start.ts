import { createMiddleware, createStart } from "@tanstack/react-start";
import { authkitMiddleware } from "@workos/authkit-tanstack-react-start";

// Satisfy authkit-session's required config validation — the actual redirect URI
// is computed per-request from the origin by the middleware below.
process.env.WORKOS_REDIRECT_URI ??= "https://app.tokenspace.ai/api/auth/callback";

const dynamicRedirectUri = createMiddleware().server(async (args) => {
  const url = new URL(args.request.url);
  const redirectUri = `${url.origin}/api/auth/callback`;
  return args.next({ context: { redirectUri } });
});

export const startInstance = createStart(() => {
  return {
    requestMiddleware: [authkitMiddleware(), dynamicRedirectUri],
  };
});
