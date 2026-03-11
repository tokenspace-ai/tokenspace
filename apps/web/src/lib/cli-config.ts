import { createRemoteJWKSet, jwtVerify } from "jose";

export const DEFAULT_DEVICE_AUTH_SCOPE = "openid profile email";

function requireWorkOSClientId(): string {
  const clientId = process.env.WORKOS_CLIENT_ID?.trim();
  if (!clientId) {
    throw new Error("WORKOS_CLIENT_ID is not configured");
  }
  return clientId;
}

export function buildPublicCliConfig(request: Request): {
  version: 1;
  webAppUrl: string;
  workosClientId: string;
  deviceAuthScope: string;
} {
  const webAppUrl = new URL(request.url).origin;
  return {
    version: 1,
    webAppUrl,
    workosClientId: requireWorkOSClientId(),
    deviceAuthScope: DEFAULT_DEVICE_AUTH_SCOPE,
  };
}

export function buildAuthenticatedCliConfig(): { version: 1; convexUrl: string } {
  const convexUrl = process.env.VITE_CONVEX_URL?.trim() || import.meta.env.VITE_CONVEX_URL?.trim();
  if (!convexUrl) {
    throw new Error("VITE_CONVEX_URL is not configured");
  }
  return {
    version: 1,
    convexUrl,
  };
}

function getBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    return null;
  }

  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }

  return token;
}

export async function hasValidCliBearerToken(request: Request): Promise<boolean> {
  const token = getBearerToken(request);
  if (!token) {
    return false;
  }

  const clientId = requireWorkOSClientId();
  const jwks = createRemoteJWKSet(new URL(`https://api.workos.com/sso/jwks/${clientId}`));

  try {
    await jwtVerify(token, jwks, {
      issuer: ["https://api.workos.com/", `https://api.workos.com/user_management/${clientId}`],
    });
    return true;
  } catch {
    return false;
  }
}
