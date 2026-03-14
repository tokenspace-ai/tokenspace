import { Link, useParams } from "@tanstack/react-router";
import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import {
  CogIcon,
  HomeIcon,
  MessageSquare,
  MessageSquareIcon,
  PlusIcon,
  ServerIcon,
  TerminalSquareIcon,
} from "lucide-react";
import { useState } from "react";
import {
  ThreadList,
  ThreadListEmptyState,
  ThreadListItem,
  ThreadListItemCompact,
} from "@/components/chat/thread/chat-thread-list";
import { UserMenu } from "@/components/header/user-menu";
import {
  type Branch,
  type RevisionState,
  SidebarWorkspaceSelector,
  type Workspace,
  type WorkspaceWorkingChange,
} from "@/components/sidebar-workspace-selector";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar";
import { deriveWorkspaceExecutorState } from "@/components/workspace-settings/executor-status";
import { cn } from "@/lib/utils";

export type ChatStatus =
  | "streaming"
  | "awaiting_tool_results"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "stopped";

export interface Thread {
  id: Id<"chats">;
  title: string;
  summary?: string | null;
  createdAt?: number;
  messageCount?: number;
  isStarred?: boolean;
  status?: ChatStatus;
}

type AppNavItem = "home" | "chat" | "playground";

function useCurrentAppRoute(): AppNavItem | undefined {
  const pathname = typeof window !== "undefined" ? window.location.pathname : "";

  if (pathname.match(/\/workspace\/[^/]+\/playground/)) return "playground";
  if (pathname.match(/\/workspace\/[^/]+\/chat/)) return "chat";
  if (pathname.match(/\/workspace\/[^/]+$/)) return "home";
  return undefined;
}

interface AppSidebarProps {
  workspaces: Workspace[];
  workspaceId: Id<"workspaces">;
  branches: Branch[];
  currentWorkspaceSlug?: string;
  currentBranchId?: string;
  includeWorkingState: boolean;
  workingStateHash?: string;
  revisionState: RevisionState;
  onBranchChange: (branchId: string, includeWorkingState: boolean) => void;
  onToggleWorkingState: (include: boolean) => void;
  workingChanges: WorkspaceWorkingChange[];
  onCommitChanges: (message: string) => Promise<void>;
  user: {
    id: string;
    email?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    profilePictureUrl?: string | null;
  } | null;
  onSignOut: () => void;
  threads: Thread[];
  threadsStatus: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";
  loadMoreThreads: () => void;
  currentChatId?: Id<"chats">;
  onDeleteThread: (threadId: Id<"chats">, e: React.MouseEvent) => void;
  onRenameThread: (threadId: Id<"chats">, newTitle: string) => void;
  onToggleStar: (threadId: Id<"chats">, isStarred: boolean, e: React.MouseEvent) => void;
}

export function AppSidebar({
  workspaces,
  workspaceId,
  branches,
  currentWorkspaceSlug,
  currentBranchId,
  includeWorkingState,
  workingStateHash,
  revisionState,
  onBranchChange,
  onToggleWorkingState,
  workingChanges,
  onCommitChanges,
  user,
  onSignOut,
  threads,
  threadsStatus,
  loadMoreThreads,
  currentChatId,
  onDeleteThread,
  onRenameThread,
  onToggleStar,
}: AppSidebarProps) {
  const params = useParams({ strict: false }) as { slug?: string };
  const slug = params.slug;
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const currentRoute = useCurrentAppRoute();
  const [threadsPopoverOpen, setThreadsPopoverOpen] = useState(false);
  const assignedExecutorStatus = useQuery(api.executors.getAssignedExecutorStatus, { workspaceId });
  const executorState =
    assignedExecutorStatus === undefined ? null : deriveWorkspaceExecutorState(assignedExecutorStatus);

  return (
    <Sidebar variant="sidebar" collapsible="icon" className="border-r">
      <SidebarHeader className="border-b p-2">
        <SidebarWorkspaceSelector
          workspaces={workspaces}
          branches={branches}
          currentWorkspaceSlug={currentWorkspaceSlug}
          currentBranchId={currentBranchId}
          includeWorkingState={includeWorkingState}
          workingStateHash={workingStateHash}
          revisionState={revisionState}
          onBranchChange={onBranchChange}
          onToggleWorkingState={onToggleWorkingState}
          workingChanges={workingChanges}
          onCommitChanges={onCommitChanges}
          collapsed={collapsed}
        />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={currentRoute === "home"} tooltip="Home">
                  <Link to="/workspace/$slug" params={{ slug: slug ?? "" }}>
                    <HomeIcon className="size-4" />
                    <span>Home</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <MessageSquareIcon className="size-4" />
              <span>Chats</span>
            </div>
            <Link to="/workspace/$slug/chat" params={{ slug: slug ?? "" }} className="rounded p-0.5 hover:bg-accent">
              <PlusIcon className="size-3.5" />
            </Link>
          </SidebarGroupLabel>
          <SidebarGroupContent>
            {!collapsed && (
              <ThreadList canLoadMore={threadsStatus === "CanLoadMore"} loadMore={loadMoreThreads}>
                {threadsStatus === "LoadingFirstPage" ? null : threads.length === 0 ? (
                  <ThreadListEmptyState />
                ) : (
                  threads.map((thread) => (
                    <ThreadListItem
                      key={thread.id}
                      thread={thread}
                      isSelected={currentChatId === thread.id}
                      onDelete={(e) => onDeleteThread(thread.id, e)}
                      onRename={(newTitle) => onRenameThread(thread.id, newTitle)}
                      onToggleStar={(e) => onToggleStar(thread.id, thread.isStarred ?? false, e)}
                      workspaceSlug={slug ?? ""}
                    />
                  ))
                )}
              </ThreadList>
            )}
            {collapsed && (
              <SidebarMenu>
                <SidebarMenuItem>
                  <Popover open={threadsPopoverOpen} onOpenChange={setThreadsPopoverOpen}>
                    <PopoverTrigger asChild>
                      <SidebarMenuButton isActive={currentRoute === "chat"} tooltip="Chats">
                        <MessageSquare className="size-4" />
                        <span>Chats</span>
                      </SidebarMenuButton>
                    </PopoverTrigger>
                    <PopoverContent side="right" align="start" className="w-72 p-2">
                      <div className="flex items-center justify-between mb-2 px-2">
                        <span className="text-sm font-medium">Chats</span>
                        <Link
                          to="/workspace/$slug/chat"
                          params={{ slug: slug ?? "" }}
                          onClick={() => setThreadsPopoverOpen(false)}
                          className="rounded p-0.5 hover:bg-accent"
                        >
                          <PlusIcon className="size-3.5" />
                        </Link>
                      </div>
                      <ScrollArea className="max-h-80">
                        {threadsStatus === "LoadingFirstPage" ? null : threads.length === 0 ? (
                          <ThreadListEmptyState compact />
                        ) : (
                          <div className="flex flex-col gap-0.5">
                            {threads.map((thread) => (
                              <ThreadListItemCompact
                                key={thread.id}
                                thread={thread}
                                isSelected={currentChatId === thread.id}
                                workspaceSlug={slug ?? ""}
                                onClick={() => setThreadsPopoverOpen(false)}
                              />
                            ))}
                            {threadsStatus === "CanLoadMore" && (
                              <button
                                type="button"
                                onClick={loadMoreThreads}
                                className="mt-1 w-full rounded-lg px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                              >
                                Load more
                              </button>
                            )}
                          </div>
                        )}
                      </ScrollArea>
                    </PopoverContent>
                  </Popover>
                </SidebarMenuItem>
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={currentRoute === "playground"} tooltip="Playground">
              <Link to="/workspace/$slug/playground" params={{ slug: slug ?? "" }}>
                <TerminalSquareIcon className="size-4" />
                <span>Playground</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>

          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip={executorState ? `Executor ${executorState.label}` : "Executor status"}>
              <Link to="/workspace/$slug/admin/executor" params={{ slug: slug ?? "" }}>
                <ServerIcon className={cn("size-4", executorState?.iconClassName)} />
                <span>Executor</span>
              </Link>
            </SidebarMenuButton>
            {executorState ? <SidebarMenuBadge>{executorState.label}</SidebarMenuBadge> : null}
          </SidebarMenuItem>

          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Admin">
              <Link to="/workspace/$slug/admin/settings" params={{ slug: slug ?? "" }}>
                <CogIcon className="size-4" />
                <span>Settings</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <SidebarSeparator />
        {user && <UserMenu user={user} onSignOut={onSignOut} variant="sidebar" collapsed={collapsed} />}
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
