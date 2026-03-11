import { createFileRoute, Outlet } from "@tanstack/react-router";
import { getSignInUrl } from "@workos/authkit-tanstack-react-start";
import { useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";

export const Route = createFileRoute("/_app")({
  component: RouteComponent,
});

function RouteComponent() {
  const { loading, user } = useAuth();

  useEffect(() => {
    if (!loading && !user) {
      getSignInUrl({
        data: { redirectUri: `${window.location.origin}/api/auth/callback`, returnPathname: window.location.pathname },
      }).then((url) => {
        window.location.href = url;
      });
    }
  }, [loading, user]);

  if (loading || !user) {
    return null;
  }

  return <Outlet />;
}
