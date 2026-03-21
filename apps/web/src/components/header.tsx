import { useLocation, useParams } from "@tanstack/react-router";
import { api } from "@tokenspace/backend/convex/_generated/api";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { useQuery } from "convex/react";
import {
  type RevisionState,
  RevisionStatus,
  UserMenu,
  type Workspace,
  WorkspaceSelector,
} from "@/components/header/index";
import { Separator } from "@/components/ui/separator";
import { parseWorkspaceSlug } from "@/lib/workspace-slug";

type RouteSection = "admin" | "app";

function useCurrentRouteSection(): { section: RouteSection; subRoute?: string } {
  const { pathname } = useLocation();

  if (/\/admin(?:\/|$)/.test(pathname)) {
    return { section: "admin" };
  }
  if (pathname.includes("/playground")) return { section: "app", subRoute: "playground" };
  if (pathname.includes("/schedules")) return { section: "app", subRoute: "schedules" };
  if (pathname.includes("/events")) return { section: "app", subRoute: "events" };
  if (pathname.includes("/capabilities")) return { section: "app", subRoute: "capabilities" };
  if (pathname.includes("/credentials")) return { section: "app", subRoute: "credentials" };
  if (pathname.includes("/audit-log")) return { section: "app", subRoute: "audit-log" };
  if (pathname.includes("/chat")) return { section: "app", subRoute: "chat" };
  return { section: "app" };
}

export default function Header() {
  const params = useParams({ strict: false }) as { slug?: string };
  const { user, signOut } = useAuth();
  const { section } = useCurrentRouteSection();

  const workspaceSlug = params.slug;
  const parsedSlug = workspaceSlug ? parseWorkspaceSlug(workspaceSlug) : null;

  const workspacesData = useQuery(api.workspace.list);
  const workspaceContext = useQuery(
    api.workspace.resolveWorkspaceContext,
    workspaceSlug ? { slug: workspaceSlug } : "skip",
  );

  const workspaces: Workspace[] = (workspacesData ?? []).map((w) => ({
    id: w._id,
    name: w.name,
    slug: w.slug,
    iconUrl: w.iconUrl,
  }));

  const revisionState: RevisionState = workspaceContext?.workspace?.activeRevisionId ? "ready" : "pending";

  const handleSignOut = () => {
    signOut();
  };

  // For admin routes, the sidebar handles workspace/branch/user controls
  const isAdminRoute = section === "admin";

  // Don't render header at all for admin routes - sidebar has all controls
  if (isAdminRoute) {
    return null;
  }

  return (
    <header className="border-b bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/60">
      <div className="flex h-12 items-center px-4 gap-2">
        <WorkspaceSelector workspaces={workspaces} currentWorkspaceSlug={parsedSlug?.workspaceSlug} />

        {workspaceSlug && (
          <>
            <Separator orientation="vertical" className="h-6 mx-2" />
            <RevisionStatus revisionId={workspaceContext?.workspace?.activeRevisionId} state={revisionState} />
          </>
        )}

        <div className="flex-1" />

        <UserMenu user={user} onSignOut={handleSignOut} />
      </div>
    </header>
  );
}
