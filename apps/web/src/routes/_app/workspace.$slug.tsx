import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";
import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import { normalizeMemberWorkspaceSlug, parseWorkspaceSlug } from "@/lib/workspace-slug";

// Context type for passing workspace data to child routes
export type WorkspaceContextType = {
  workspaceId: Id<"workspaces">;
  workspaceSlug: string;
  workspaceName: string;
  workspaceRole: "workspace_admin" | "member";
  branchStateId: Id<"branchStates"> | undefined;
  branchStateName: string;
  isMainBranchState: boolean;
  branchId: Id<"branches"> | undefined;
  branchName: string;
  workingStateHash: string | undefined;
  revisionId: Id<"revisions"> | undefined;
  slug: string; // The full slug from URL
};

export const Route = createFileRoute("/_app/workspace/$slug")({
  component: WorkspaceLayout,
});

// Hook to get workspace context - fetches data directly (Convex caches queries)
export function useWorkspaceContext(): WorkspaceContextType {
  const params = useParams({ strict: false }) as { slug?: string };
  const slug = params.slug;

  if (!slug) {
    throw new Error("useWorkspaceContext must be used within a workspace route");
  }

  const { workspaceSlug, branchName, workingStateHash, revisionId } = parseWorkspaceSlug(slug);
  const workspaceContext = useQuery(api.workspace.resolveWorkspaceContext, { slug });

  if (!workspaceContext) {
    throw new Error("Workspace context not loaded yet");
  }

  return {
    workspaceId: workspaceContext.workspace._id,
    workspaceSlug,
    workspaceName: workspaceContext.workspace.name,
    workspaceRole: workspaceContext.workspace.role,
    branchStateId: workspaceContext.branchState?._id,
    branchStateName: workspaceContext.branchState?.name ?? branchName,
    isMainBranchState: workspaceContext.branchState?.isMain ?? branchName === "main",
    branchId: workspaceContext.branch?._id,
    branchName: workspaceContext.branchState?.name ?? workspaceContext.branch?.name ?? branchName,
    workingStateHash: workspaceContext.workingStateHash ?? workingStateHash,
    revisionId:
      (workspaceContext.revisionId as Id<"revisions"> | undefined) ?? (revisionId as Id<"revisions"> | undefined),
    slug,
  };
}

function WorkspaceLayout() {
  const { slug } = Route.useParams();
  const pathname = typeof window !== "undefined" ? window.location.pathname : "";
  const contextSlug = pathname.includes("/admin") ? slug : normalizeMemberWorkspaceSlug(slug);
  const workspaceContext = useQuery(api.workspace.resolveWorkspaceContext, { slug: contextSlug });

  if (!workspaceContext) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading tokenspace...</div>
      </div>
    );
  }

  return <Outlet />;
}
