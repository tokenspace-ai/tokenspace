import { createFileRoute } from "@tanstack/react-router";
import { CalendarClockIcon } from "lucide-react";
import { WorkspaceFeaturePlaceholder } from "@/components/workspace-feature-placeholder";

export const Route = createFileRoute("/_app/workspace/$slug/_app/schedules")({
  component: SchedulesPage,
});

function SchedulesPage() {
  return (
    <WorkspaceFeaturePlaceholder
      title="Schedules"
      description="Recurring automations and scheduled tasks for this workspace will live here."
      icon={CalendarClockIcon}
    />
  );
}
