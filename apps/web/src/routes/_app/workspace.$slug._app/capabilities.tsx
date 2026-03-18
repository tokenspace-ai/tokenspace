import { createFileRoute } from "@tanstack/react-router";
import { Layers3Icon } from "lucide-react";
import { WorkspaceFeaturePlaceholder } from "@/components/workspace-feature-placeholder";

export const Route = createFileRoute("/_app/workspace/$slug/_app/capabilities")({
  component: CapabilitiesPage,
});

function CapabilitiesPage() {
  return (
    <WorkspaceFeaturePlaceholder
      title="Capabilities"
      description="An overview of the capabilities available in the current workspace will live here."
      icon={Layers3Icon}
    />
  );
}
