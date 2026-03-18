import { createFileRoute } from "@tanstack/react-router";
import { WorkspaceAppCredentialsPage } from "@/components/credentials/workspace-app-credentials-page";
import { useWorkspaceContext } from "./route";

export const Route = createFileRoute("/_app/workspace/$slug/_app/credentials")({
  component: WorkspaceCredentialsPage,
  ssr: false,
});

function WorkspaceCredentialsPage() {
  const { workspaceId, revisionId, slug, workspaceRole } = useWorkspaceContext();

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-8 p-8">
        <div>
          <h1 className="text-lg font-semibold">Credentials</h1>
          <p className="text-sm text-muted-foreground">
            Review what this revision needs and configure the credentials you can act on directly.
          </p>
        </div>

        <WorkspaceAppCredentialsPage
          workspaceId={workspaceId}
          revisionId={revisionId ?? null}
          workspaceSlug={slug}
          isWorkspaceAdmin={workspaceRole === "workspace_admin"}
        />
      </div>
    </div>
  );
}
