import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { api } from "@tokenspace/backend/convex/_generated/api";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { useAction, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
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
    branchId,
    branchName,
    workingStateHash,
  } = useWorkspaceContext();

  const parsedSlug = parseWorkspaceSlug(slug);
  const createCommit = useAction(api.vcs.createCommit);
  const liveWorkingStateHash = useQuery(
    api.workspace.getCurrentWorkingStateHash,
    branchId ? { workspaceId, branchId } : "skip",
  );
  const branchDoc = useQuery(api.vcs.getBranch, branchId ? { branchId } : "skip");
  const branchCommit = useQuery(api.vcs.getCommit, branchDoc ? { commitId: branchDoc.commitId } : "skip");
  const committedTree = useQuery(
    api.trees.getFileTreeStructure,
    branchCommit ? { treeId: branchCommit.treeId } : "skip",
  );
  const workingFiles = useQuery(api.fs.working.getAll, branchId ? { branchId } : "skip");

  // Fetch workspaces and branches
  const workspacesData = useQuery(api.workspace.list);
  const workspaceContext = useQuery(api.workspace.resolveWorkspaceContext, { slug });
  const branchesData = useQuery(
    api.vcs.listBranches,
    workspaceContext?.workspace?._id ? { workspaceId: workspaceContext.workspace._id } : "skip",
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
    isDefault: b.isDefault,
  }));

  const currentBranchId = branchId;
  const includeWorkingState = Boolean(workingStateHash);

  const revisionState: RevisionState = workspaceContext?.workspace?.activeCommitId ? "ready" : "pending";
  const lastObservedLiveHashRef = useRef<string | null | undefined>(undefined);

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
      if (!branchId) {
        throw new Error("Missing branch context");
      }
      await createCommit({
        workspaceId,
        branchId,
        message,
      });
      toast.success("Changes committed");
      const cleanSlug = buildWorkspaceSlug(currentWorkspaceSlug, branchName);
      navigateToSlug(cleanSlug);
    },
    [branchId, createCommit, workspaceId, currentWorkspaceSlug, branchName, navigateToSlug],
  );

  useEffect(() => {
    if (!branchId || liveWorkingStateHash === undefined) return;

    const observationKey = `${branchId}:${liveWorkingStateHash ?? "null"}`;
    const liveHashChanged = lastObservedLiveHashRef.current !== observationKey;
    lastObservedLiveHashRef.current = observationKey;
    if (!liveHashChanged) return;

    const currentHash = workingStateHash;
    const nextHash = liveWorkingStateHash ?? undefined;
    if (currentHash === nextHash) return;

    const nextSlug = buildWorkspaceSlug(currentWorkspaceSlug, branchName, nextHash);
    navigateToSlug(nextSlug, { replace: true });
  }, [branchId, liveWorkingStateHash, workingStateHash, currentWorkspaceSlug, branchName, navigateToSlug]);

  const handleBranchChange = (newBranchId: string, _includeWorking: boolean) => {
    const branch = branches.find((b) => b.id === newBranchId);
    if (!branch) return;

    const newSlug = buildWorkspaceSlug(currentWorkspaceSlug, branch.name);
    navigateToSlug(newSlug);
  };

  const handleToggleWorkingState = (include: boolean) => {
    if (!currentBranchId) return;
    const branch = branches.find((b) => b.id === currentBranchId);
    if (!branch) return;

    const newSlug = buildWorkspaceSlug(currentWorkspaceSlug, branch.name, include ? workingStateHash : undefined);
    navigateToSlug(newSlug);
  };

  const handleSignOut = () => {
    signOut();
  };

  return (
    <SidebarProvider>
      <AdminSidebar
        workspaces={workspaces}
        branches={branches}
        currentWorkspaceSlug={parsedSlug.workspaceSlug}
        currentBranchId={currentBranchId}
        includeWorkingState={includeWorkingState}
        workingStateHash={workingStateHash}
        revisionState={revisionState}
        onBranchChange={handleBranchChange}
        onToggleWorkingState={handleToggleWorkingState}
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
