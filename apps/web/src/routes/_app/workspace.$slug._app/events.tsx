import { createFileRoute } from "@tanstack/react-router";
import { WebhookIcon } from "lucide-react";
import { WorkspaceFeaturePlaceholder } from "@/components/workspace-feature-placeholder";

export const Route = createFileRoute("/_app/workspace/$slug/_app/events")({
  component: EventsPage,
});

function EventsPage() {
  return (
    <WorkspaceFeaturePlaceholder
      title="Events"
      description="Event-triggered automations and incoming triggers for this workspace will live here."
      icon={WebhookIcon}
    />
  );
}
