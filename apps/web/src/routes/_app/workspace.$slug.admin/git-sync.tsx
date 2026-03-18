import { createFileRoute } from "@tanstack/react-router";
import { GitBranchIcon } from "lucide-react";
import { WorkspaceFeaturePlaceholder } from "@/components/workspace-feature-placeholder";

export const Route = createFileRoute("/_app/workspace/$slug/admin/git-sync")({
  component: GitSyncPage,
});

function GitSyncPage() {
  return (
    <WorkspaceFeaturePlaceholder
      title="Git Sync"
      description="Synchronize workspace contents to and from Git repositories from this page."
      icon={GitBranchIcon}
    />
  );
}
