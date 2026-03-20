import { createFileRoute, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { useAction, useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { AppSidebar } from "@/components/app-sidebar";
import { ChatCommandMenuProvider } from "@/components/chat-command-menu/chat-command-menu-provider";
import type { Branch, RevisionState, Workspace } from "@/components/sidebar-workspace-selector";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { WorkspaceRevisionProvider } from "@/components/workspace-revision";
import { buildWorkspaceSlug, parseWorkspaceSlug, replaceWorkspaceSlugInPath } from "@/lib/workspace-slug";
import { useWorkspaceContext } from "../workspace.$slug";

export const Route = createFileRoute("/_app/workspace/$slug/_app")({
  component: WorkspaceAppLayout,
});

// Re-export for child routes
export { useWorkspaceContext } from "../workspace.$slug";

function WorkspaceAppLayout() {
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { slug?: string; chatId?: string };
  const slug = params.slug ?? "";
  const currentChatId = params.chatId as Id<"chats"> | undefined;
  const { user, signOut } = useAuth();

  const {
    workspaceId,
    workspaceSlug: currentWorkspaceSlug,
    workspaceRole,
    branchId,
    branchName,
    workingStateHash,
    revisionId,
  } = useWorkspaceContext();

  const parsedSlug = parseWorkspaceSlug(slug);
  const createCommit = useAction(api.vcs.createCommit);

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

  const branchDoc = useQuery(api.vcs.getBranch, branchId ? { branchId } : "skip");
  const branchCommit = useQuery(api.vcs.getCommit, branchDoc ? { commitId: branchDoc.commitId } : "skip");
  const committedTree = useQuery(
    api.trees.getFileTreeStructure,
    branchCommit ? { treeId: branchCommit.treeId } : "skip",
  );
  const workingFiles = useQuery(api.fs.working.getAll, branchId ? { branchId } : "skip");

  const navigateToSlug = useCallback(
    (nextSlug: string, options?: { replace?: boolean }) => {
      const pathname = typeof window !== "undefined" ? window.location.pathname : "";
      const nextPath = replaceWorkspaceSlugInPath(pathname, nextSlug);
      if (nextPath === pathname) {
        navigate({ to: `/workspace/${nextSlug}`, replace: options?.replace });
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

  const deleteChat = useMutation(api.ai.chat.deleteChat);
  const updateChat = useMutation(api.ai.chat.updateChat);
  const starChat = useMutation(api.ai.chat.starChat);
  const unstarChat = useMutation(api.ai.chat.unstarChat);

  // List threads filtered by workspace
  const {
    results: threads,
    status: threadsStatus,
    loadMore,
  } = usePaginatedQuery(api.ai.chat.listChats, workspaceId ? { workspaceId } : ("skip" as any), {
    initialNumItems: 8,
  });

  // Sort threads: starred first, then by createdAt (already sorted by backend)
  const sortedThreads = useMemo(() => {
    if (!threads) return [];
    return [...threads].sort((a, b) => {
      if (a.isStarred && !b.isStarred) return -1;
      if (!a.isStarred && b.isStarred) return 1;
      return 0; // Keep original order within each group
    });
  }, [threads]);

  const handleDeleteThread = useCallback(
    async (threadId: Id<"chats">, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      await deleteChat({ chatId: threadId });
      if (currentChatId === threadId) {
        navigate({ to: "/workspace/$slug/chat", params: { slug } });
      }
    },
    [deleteChat, currentChatId, navigate, slug],
  );

  const handleToggleStar = useCallback(
    async (threadId: Id<"chats">, isStarred: boolean, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (isStarred) {
        await unstarChat({ chatId: threadId });
      } else {
        await starChat({ chatId: threadId });
      }
    },
    [starChat, unstarChat],
  );

  const handleRenameThread = useCallback(
    async (threadId: Id<"chats">, newTitle: string) => {
      await updateChat({ chatId: threadId, title: newTitle });
    },
    [updateChat],
  );

  return (
    <SidebarProvider>
      <ChatCommandMenuProvider threads={sortedThreads} workspaceSlug={slug}>
        <AppSidebar
          workspaces={workspaces}
          workspaceId={workspaceId}
          revisionId={revisionId}
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
          isWorkspaceAdmin={workspaceRole === "workspace_admin"}
          user={user}
          onSignOut={handleSignOut}
          threads={sortedThreads}
          threadsStatus={threadsStatus}
          loadMoreThreads={() => loadMore(20)}
          currentChatId={currentChatId}
          onDeleteThread={handleDeleteThread}
          onRenameThread={handleRenameThread}
          onToggleStar={handleToggleStar}
        />
        <SidebarInset className="max-h-screen overflow-y-auto">
          <WorkspaceRevisionProvider>
            <Outlet />
          </WorkspaceRevisionProvider>
        </SidebarInset>
      </ChatCommandMenuProvider>
    </SidebarProvider>
  );
}
