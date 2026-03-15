import { createFileRoute } from "@tanstack/react-router";
import { api } from "@tokenspace/backend/convex/_generated/api";
import { useQuery } from "convex/react";
import { WorkspaceExecutorSettings } from "@/components/workspace-settings/workspace-executor-settings";
import { parseWorkspaceSlug } from "@/lib/workspace-slug";
import { useWorkspaceContext } from "../workspace.$slug";

export const Route = createFileRoute("/_app/workspace/$slug/admin/executor")({
  component: ExecutorSettingsPage,
  ssr: false,
});

function ExecutorSettingsPage() {
  const { workspaceId, slug } = useWorkspaceContext();
  const { workspaceSlug } = parseWorkspaceSlug(slug);
  const workspace = useQuery(api.workspace.getBySlug, { slug: workspaceSlug });

  if (workspace === undefined) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (workspace === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Workspace not found or access denied.</div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-8 p-8">
        <div>
          <h1 className="text-lg font-semibold">Execution Environment</h1>
          <p className="text-sm text-muted-foreground">
            Assign a self-hosted executor, inspect instance health, and bootstrap new executor fleets.
          </p>
        </div>

        <WorkspaceExecutorSettings workspaceId={workspaceId} isWorkspaceAdmin={workspace.role === "workspace_admin"} />
      </div>
    </div>
  );
}
