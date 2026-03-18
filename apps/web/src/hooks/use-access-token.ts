import { useAccessToken as useAccessTokenFromAuthKit } from "@workos/authkit-tanstack-react-start/client";

export function useAccessToken() {
  try {
    // biome-ignore lint/correctness/useHookAtTopLevel: safely handle missing AuthKitProvider during SSR
    return useAccessTokenFromAuthKit();
  } catch (_error) {
    return {
      getAccessToken: async () => null,
      refresh: async () => null,
    };
  }
}
