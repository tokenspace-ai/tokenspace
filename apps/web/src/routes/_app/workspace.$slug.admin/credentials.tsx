import { createFileRoute } from "@tanstack/react-router";
import { api } from "@tokenspace/backend/convex/_generated/api";
import { useQuery } from "convex/react";
import { WorkspaceCredentialsSettings } from "@/components/workspace-settings/workspace-credentials-settings";
import { useWorkspaceContext } from "../workspace.$slug";

export const Route = createFileRoute("/_app/workspace/$slug/admin/credentials")({
  component: CredentialsPage,
  ssr: false,
});

function CredentialsPage() {
  const { workspaceId, workspaceSlug, branchStateId } = useWorkspaceContext();
  const workspace = useQuery(api.workspace.getBySlug, { slug: workspaceSlug });
  const revision = useQuery(api.branchStates.getCurrentRevision, branchStateId ? { branchStateId } : "skip");

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
      <div className="mx-auto w-full max-w-2xl space-y-8 p-8">
        <div>
          <h1 className="text-lg font-semibold">Credentials</h1>
          <p className="text-sm text-muted-foreground">
            Configure workspace credentials and review runtime credential requirements.
          </p>
        </div>

        <WorkspaceCredentialsSettings
          workspaceId={workspaceId}
          revisionId={revision?._id ?? null}
          isWorkspaceAdmin={workspace.role === "workspace_admin"}
        />
      </div>
    </div>
  );
}
