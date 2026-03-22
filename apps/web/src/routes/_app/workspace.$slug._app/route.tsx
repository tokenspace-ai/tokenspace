import { createFileRoute, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { ChatCommandMenuProvider } from "@/components/chat-command-menu/chat-command-menu-provider";
import type { RevisionState, Workspace } from "@/components/sidebar-workspace-selector";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { WorkspaceRevisionProvider } from "@/components/workspace-revision";
import { normalizeMemberWorkspaceSlug, replaceWorkspaceSlugInPath } from "@/lib/workspace-slug";

export const Route = createFileRoute("/_app/workspace/$slug/_app")({
  component: WorkspaceAppLayout,
});

export function useWorkspaceContext() {
  const params = useParams({ strict: false }) as { slug?: string };
  const slug = params.slug ?? "";
  const normalizedSlug = normalizeMemberWorkspaceSlug(slug);
  const workspaceContext = useQuery(api.workspace.resolveWorkspaceContext, { slug: normalizedSlug });

  if (!workspaceContext) {
    throw new Error("Workspace context not loaded yet");
  }

  return {
    workspaceId: workspaceContext.workspace._id,
    workspaceSlug: workspaceContext.workspace.slug,
    workspaceName: workspaceContext.workspace.name,
    workspaceRole: workspaceContext.workspace.role,
    branchStateId: workspaceContext.branchState?._id,
    branchStateName: workspaceContext.branchState?.name ?? workspaceContext.branch?.name ?? "main",
    isMainBranchState: workspaceContext.branchState?.isMain ?? true,
    branchId: workspaceContext.branch?._id,
    branchName: workspaceContext.branchState?.name ?? workspaceContext.branch?.name ?? "main",
    workingStateHash: workspaceContext.workingStateHash,
    revisionId: (workspaceContext.revisionId as Id<"revisions"> | undefined) ?? undefined,
    slug: normalizedSlug,
  };
}

function WorkspaceAppLayout() {
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { slug?: string; chatId?: string };
  const slug = params.slug ?? "";
  const normalizedSlug = normalizeMemberWorkspaceSlug(slug);
  const currentChatId = params.chatId as Id<"chats"> | undefined;
  const { user, signOut } = useAuth();

  const { workspaceId, workspaceSlug: currentWorkspaceSlug, workspaceRole, revisionId } = useWorkspaceContext();

  // Fetch workspaces
  const workspacesData = useQuery(api.workspace.list);
  const workspaceContext = useQuery(api.workspace.resolveWorkspaceContext, { slug: normalizedSlug });

  const workspaces: Workspace[] = (workspacesData ?? []).map((w) => ({
    id: w._id,
    name: w.name,
    slug: w.slug,
    iconUrl: w.iconUrl,
  }));

  const revisionState: RevisionState = revisionId ? "ready" : "pending";

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

  useEffect(() => {
    if (!workspaceContext?.workspace || slug.includes("@") || slug === currentWorkspaceSlug) {
      return;
    }
    navigateToSlug(currentWorkspaceSlug, { replace: true });
  }, [workspaceContext?.workspace?._id, slug, currentWorkspaceSlug, navigateToSlug]);

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
      <ChatCommandMenuProvider threads={sortedThreads} workspaceSlug={currentWorkspaceSlug}>
        <AppSidebar
          workspaces={workspaces}
          workspaceId={workspaceId}
          revisionId={revisionId}
          branches={[]}
          currentWorkspaceSlug={currentWorkspaceSlug}
          currentBranchId={undefined}
          includeWorkingState={false}
          workingStateHash={undefined}
          revisionState={revisionState}
          onBranchChange={() => {}}
          onToggleWorkingState={() => {}}
          workingChanges={[]}
          onCommitChanges={async () => {}}
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
          showBranchControls={false}
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
