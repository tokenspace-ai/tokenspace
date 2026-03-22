import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { api } from "@tokenspace/backend/convex/_generated/api";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { useAction, useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AdminSidebar } from "@/components/admin-sidebar";
import type { Branch, RevisionState, Workspace } from "@/components/sidebar-workspace-selector";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { buildWorkspaceSlug, parseWorkspaceSlug, replaceWorkspaceSlugInPath } from "@/lib/workspace-slug";
import { useWorkspaceContext } from "../workspace.$slug";

export const Route = createFileRoute("/_app/workspace/$slug/admin")({
  component: AdminLayout,
});

function AdminLayout() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const {
    slug,
    workspaceId,
    workspaceSlug: currentWorkspaceSlug,
    branchStateId,
    branchStateName,
    isMainBranchState,
    branchId,
    workingStateHash,
  } = useWorkspaceContext();

  const parsedSlug = parseWorkspaceSlug(slug);
  const ensureBranchStates = useMutation(api.branchStates.ensureInitialized);
  const createCommit = useAction(api.branchStates.createCommit);
  const [branchStatesReady, setBranchStatesReady] = useState(false);
  const branchStateDoc = useQuery(api.branchStates.get, branchStateId ? { branchStateId } : "skip");
  const branchDoc = useQuery(api.vcs.getBranch, branchId ? { branchId } : "skip");
  const branchCommit = useQuery(api.vcs.getCommit, branchDoc ? { commitId: branchDoc.commitId } : "skip");
  const committedTree = useQuery(
    api.trees.getFileTreeStructure,
    branchCommit ? { treeId: branchCommit.treeId } : "skip",
  );
  const workingFiles = useQuery(api.branchStates.getWorkingFiles, branchStateId ? { branchStateId } : "skip");

  // Fetch workspaces and branches
  const workspacesData = useQuery(api.workspace.list);
  const workspaceContext = useQuery(api.workspace.resolveWorkspaceContext, { slug });
  const branchesData = useQuery(
    api.branchStates.list,
    branchStatesReady && workspaceContext?.workspace?._id ? { workspaceId: workspaceContext.workspace._id } : "skip",
  );

  const workspaces: Workspace[] = (workspacesData ?? []).map((w) => ({
    id: w._id,
    name: w.name,
    slug: w.slug,
    iconUrl: w.iconUrl,
  }));

  const branches: Branch[] = (branchesData ?? []).map((b) => ({
    id: b._id,
    name: b.name,
    isDefault: b.isMain,
  }));

  const currentBranchId = branchStateId;
  const includeWorkingState = false;

  const revisionState: RevisionState = workspaceContext?.workspace?.activeRevisionId ? "ready" : "pending";

  const navigateToSlug = useCallback(
    (nextSlug: string, options?: { replace?: boolean }) => {
      const pathname = typeof window !== "undefined" ? window.location.pathname : "";
      const nextPath = replaceWorkspaceSlugInPath(pathname, nextSlug);
      if (nextPath === pathname) {
        navigate({ to: `/workspace/${nextSlug}/admin/editor`, replace: options?.replace });
        return;
      }
      navigate({ to: nextPath, replace: options?.replace });
    },
    [navigate],
  );

  useEffect(() => {
    let canceled = false;
    ensureBranchStates({ workspaceId })
      .then(() => {
        if (!canceled) {
          setBranchStatesReady(true);
        }
      })
      .catch((error) => {
        console.error(error);
        if (!canceled) {
          toast.error(error instanceof Error ? error.message : "Failed to initialize branch states");
        }
      });
    return () => {
      canceled = true;
    };
  }, [ensureBranchStates, workspaceId]);

  const committedPaths = useMemo(() => {
    const paths = new Set<string>();
    const collectPaths = (nodes: typeof committedTree) => {
      if (!nodes) return;
      for (const node of nodes) {
        if (node.type === "file") {
          paths.add(node.path);
        }
        if (node.children) {
          collectPaths(node.children as typeof committedTree);
        }
      }
    };
    collectPaths(committedTree);
    return paths;
  }, [committedTree]);

  const workingChanges = useMemo(() => {
    if (!workingFiles) return [];
    return workingFiles.map((file) => ({
      path: file.path,
      status: file.isDeleted
        ? ("deleted" as const)
        : committedPaths.has(file.path)
          ? ("modified" as const)
          : ("added" as const),
    }));
  }, [workingFiles, committedPaths]);

  const handleCommitChanges = useCallback(
    async (message: string) => {
      if (!branchStateId) {
        throw new Error("Missing branch state context");
      }
      const result = await createCommit({
        branchStateId,
        message,
      });
      toast.success("Changes committed");
      const cleanSlug = buildWorkspaceSlug(currentWorkspaceSlug, result.branchStateName);
      navigateToSlug(cleanSlug);
    },
    [branchStateId, createCommit, currentWorkspaceSlug, navigateToSlug],
  );

  useEffect(() => {
    if (!workingStateHash) return;
    const nextSlug = buildWorkspaceSlug(currentWorkspaceSlug, isMainBranchState ? undefined : branchStateName);
    navigateToSlug(nextSlug, { replace: true });
  }, [workingStateHash, currentWorkspaceSlug, isMainBranchState, branchStateName, navigateToSlug]);

  const handleBranchChange = (newBranchId: string) => {
    const branch = branches.find((b) => b.id === newBranchId);
    if (!branch) return;

    const newSlug = buildWorkspaceSlug(currentWorkspaceSlug, branch.isDefault ? undefined : branch.name);
    navigateToSlug(newSlug);
  };

  const handleSignOut = () => {
    signOut();
  };

  if (!branchStatesReady || (workspaceContext?.workspace && !branchStateDoc && !isMainBranchState)) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading branch states...</div>
      </div>
    );
  }

  return (
    <SidebarProvider>
      <AdminSidebar
        workspaces={workspaces}
        branches={branches}
        currentWorkspaceSlug={parsedSlug.workspaceSlug}
        currentBranchId={currentBranchId}
        includeWorkingState={includeWorkingState}
        workingStateHash={undefined}
        revisionState={revisionState}
        onBranchChange={(id) => handleBranchChange(id)}
        onToggleWorkingState={() => {}}
        workingChanges={workingChanges}
        onCommitChanges={handleCommitChanges}
        user={user}
        onSignOut={handleSignOut}
      />
      <SidebarInset>
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}
