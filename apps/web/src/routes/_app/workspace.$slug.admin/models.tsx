import { createFileRoute } from "@tanstack/react-router";
import { api } from "@tokenspace/backend/convex/_generated/api";
import { useQuery } from "convex/react";
import { WorkspaceModelsSection } from "@/components/workspace-editor/workspace-models-section";
import { useWorkspaceContext } from "../workspace.$slug";

export const Route = createFileRoute("/_app/workspace/$slug/admin/models")({
  component: ModelsPage,
  ssr: false,
});

function ModelsPage() {
  const { branchStateId } = useWorkspaceContext();
  const models = useQuery(api.branchStates.getModels, branchStateId ? { branchStateId } : "skip");

  if (!branchStateId || models == null) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl space-y-8 p-8">
        <div>
          <h1 className="text-lg font-semibold">Models</h1>
          <p className="text-sm text-muted-foreground">Configure which LLM models are available in this tokenspace.</p>
        </div>

        {models !== undefined && <WorkspaceModelsSection branchStateId={branchStateId} models={models} />}
      </div>
    </div>
  );
}
