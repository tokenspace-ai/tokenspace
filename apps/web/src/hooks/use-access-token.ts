import { useAccessToken as useAccessTokenFromAuthKit } from "@workos/authkit-tanstack-react-start/client";

const SSR_SAFE_FALLBACK = {
  getAccessToken: async () => null,
  refresh: async () => null,
};

export function useAccessToken() {
  if (import.meta.env.SSR) {
    return SSR_SAFE_FALLBACK;
  }
  // biome-ignore lint/correctness/useHookAtTopLevel: SSR builds intentionally no-op; client renders always call the hook.
  return useAccessTokenFromAuthKit();
}
