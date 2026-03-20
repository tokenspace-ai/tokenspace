import { Link, useMatchRoute, useParams } from "@tanstack/react-router";
import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import {
  AlertTriangleIcon,
  CalendarClockIcon,
  ClipboardListIcon,
  CogIcon,
  HomeIcon,
  KeyRoundIcon,
  Layers3Icon,
  MessageSquare,
  MessageSquareIcon,
  PlusIcon,
  ServerIcon,
  TerminalSquareIcon,
  WebhookIcon,
} from "lucide-react";
import { useState } from "react";
import {
  ThreadList,
  ThreadListEmptyState,
  ThreadListItem,
  ThreadListItemCompact,
} from "@/components/chat/thread/chat-thread-list";
import { ChatCommandMenuTrigger } from "@/components/chat-command-menu/chat-command-menu-trigger";
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

type AppNavItem =
  | "home"
  | "chat"
  | "playground"
  | "schedules"
  | "events"
  | "capabilities"
  | "credentials"
  | "audit-log";

function useCurrentAppRoute(): AppNavItem | undefined {
  const matchRoute = useMatchRoute();

  if (matchRoute({ to: "/workspace/$slug/audit-log" })) return "audit-log";
  if (matchRoute({ to: "/workspace/$slug/credentials" })) return "credentials";
  if (matchRoute({ to: "/workspace/$slug/capabilities" })) return "capabilities";
  if (matchRoute({ to: "/workspace/$slug/events" })) return "events";
  if (matchRoute({ to: "/workspace/$slug/schedules" })) return "schedules";
  if (matchRoute({ to: "/workspace/$slug/playground", fuzzy: true })) return "playground";
  if (matchRoute({ to: "/workspace/$slug/chat", fuzzy: true }) || matchRoute({ to: "/workspace/$slug/chat/$chatId" })) {
    return "chat";
  }
  if (matchRoute({ to: "/workspace/$slug" })) return "home";
  return undefined;
}

interface AppSidebarProps {
  workspaces: Workspace[];
  workspaceId: Id<"workspaces">;
  revisionId?: Id<"revisions">;
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
  isWorkspaceAdmin: boolean;
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
  revisionId,
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
  isWorkspaceAdmin,
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
  const resolvedRevisionId = useQuery(
    api.workspace.getRevision,
    revisionId || !currentBranchId
      ? "skip"
      : {
          workspaceId,
          branchId: currentBranchId as Id<"branches">,
          workingStateHash,
        },
  );
  const effectiveRevisionId = revisionId ?? resolvedRevisionId ?? undefined;
  const credentialSummary = useQuery(
    api.credentials.getCredentialNavigationSummary,
    effectiveRevisionId ? { revisionId: effectiveRevisionId } : "skip",
  );
  const executorState =
    assignedExecutorStatus === undefined ? null : deriveWorkspaceExecutorState(assignedExecutorStatus);
  const executorLabel = assignedExecutorStatus?.executor.name ?? "Unassigned";
  const showCredentials = isWorkspaceAdmin || Boolean(credentialSummary?.hasUserScopedRequirements);
  const credentialsDisabled = Boolean(
    isWorkspaceAdmin && credentialSummary !== undefined && !credentialSummary.hasAnyRequirements,
  );
  const credentialsNeedAction = Boolean(
    showCredentials && credentialSummary && credentialSummary.missingConfigurableCount > 0,
  );

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
          <SidebarGroupLabel>Work</SidebarGroupLabel>
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

        <ChatCommandMenuTrigger />

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
        <SidebarGroup className="p-0">
          <SidebarGroupLabel>Automation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={currentRoute === "schedules"} tooltip="Schedules">
                  <Link to="/workspace/$slug/schedules" params={{ slug: slug ?? "" }}>
                    <CalendarClockIcon className="size-4" />
                    <span>Schedules</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>

              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={currentRoute === "events"} tooltip="Events">
                  <Link to="/workspace/$slug/events" params={{ slug: slug ?? "" }}>
                    <WebhookIcon className="size-4" />
                    <span>Events</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="p-0">
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {showCredentials ? (
                <SidebarMenuItem>
                  {credentialsDisabled ? (
                    <SidebarMenuButton disabled tooltip="No credentials defined in this workspace">
                      <KeyRoundIcon className="size-4" />
                      <span>Credentials</span>
                    </SidebarMenuButton>
                  ) : (
                    <SidebarMenuButton
                      asChild
                      isActive={currentRoute === "credentials"}
                      tooltip={credentialsNeedAction ? "Credentials (action needed)" : "Credentials"}
                    >
                      <Link to="/workspace/$slug/credentials" params={{ slug: slug ?? "" }}>
                        {credentialsNeedAction ? (
                          <AlertTriangleIcon className="size-4 text-destructive" />
                        ) : (
                          <KeyRoundIcon className="size-4" />
                        )}
                        <span>Credentials</span>
                      </Link>
                    </SidebarMenuButton>
                  )}
                  {!credentialsDisabled && credentialsNeedAction ? (
                    <SidebarMenuBadge className="text-[10px] text-destructive uppercase">Action</SidebarMenuBadge>
                  ) : null}
                </SidebarMenuItem>
              ) : null}

              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={currentRoute === "capabilities"} tooltip="Capabilities">
                  <Link to="/workspace/$slug/capabilities" params={{ slug: slug ?? "" }}>
                    <Layers3Icon className="size-4" />
                    <span>Capabilities</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>

              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={currentRoute === "audit-log"} tooltip="Audit Log">
                  <Link to="/workspace/$slug/audit-log" params={{ slug: slug ?? "" }}>
                    <ClipboardListIcon className="size-4" />
                    <span>Audit Log</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>

              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={currentRoute === "playground"} tooltip="Playground">
                  <Link to="/workspace/$slug/playground" params={{ slug: slug ?? "" }}>
                    <TerminalSquareIcon className="size-4" />
                    <span>Playground</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>

              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="Settings">
                  <Link to="/workspace/$slug/admin/settings" params={{ slug: slug ?? "" }}>
                    <CogIcon className="size-4" />
                    <span>Settings</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator />

        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              tooltip={executorState ? `${executorLabel} (${executorState.label})` : "Executor status"}
            >
              <Link to="/workspace/$slug/admin/executor" params={{ slug: slug ?? "" }}>
                {executorState?.key === "unassigned" ? (
                  <AlertTriangleIcon className="size-4 text-destructive" />
                ) : (
                  <ServerIcon className={cn("size-4", executorState?.iconClassName)} />
                )}
                <span>{executorLabel}</span>
              </Link>
            </SidebarMenuButton>
            {executorState ? <SidebarMenuBadge>{executorState.label}</SidebarMenuBadge> : null}
          </SidebarMenuItem>
        </SidebarMenu>

        <SidebarSeparator />
        {user && <UserMenu user={user} onSignOut={onSignOut} variant="sidebar" collapsed={collapsed} />}
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
