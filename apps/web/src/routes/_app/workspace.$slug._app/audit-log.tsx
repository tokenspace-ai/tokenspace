import { createFileRoute } from "@tanstack/react-router";
import { ClipboardListIcon } from "lucide-react";
import { WorkspaceFeaturePlaceholder } from "@/components/workspace-feature-placeholder";

export const Route = createFileRoute("/_app/workspace/$slug/_app/audit-log")({
  component: AuditLogPage,
});

function AuditLogPage() {
  return (
    <WorkspaceFeaturePlaceholder
      title="Audit Log"
      description="Recent workspace activity, configuration changes, and operational history will live here."
      icon={ClipboardListIcon}
    />
  );
}
