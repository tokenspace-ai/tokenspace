import { useAuth as useAuthKit } from "@workos/authkit-tanstack-react-start/client";

export function useAuth() {
  try {
    // biome-ignore lint/correctness/useHookAtTopLevel: safely handle missing AuthKitProvider during SSR
    return useAuthKit();
  } catch (_e) {
    return { loading: true, user: null, signOut: () => {} };
  }
}
