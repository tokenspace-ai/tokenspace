import { Link } from "@tanstack/react-router";
import {
  LoaderCircleIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PencilIcon,
  ShieldAlertIcon,
  SquareIcon,
  StarIcon,
  Trash2Icon,
  XCircleIcon,
} from "lucide-react";
import { useState } from "react";
import type { ChatStatus } from "@/components/app-sidebar";
import { CompactTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SidebarMenu, SidebarMenuAction, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

export function ThreadList({
  children,
  canLoadMore,
  loadMore,
}: {
  children: React.ReactNode;
  canLoadMore?: boolean;
  loadMore: () => void;
}) {
  return (
    <ScrollArea className="flex-1 max-h-[calc(100vh-70px)]">
      <SidebarMenu>
        {children}
        {canLoadMore && (
          <button
            type="button"
            onClick={loadMore}
            className="mt-2 w-full rounded-lg px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Load more
          </button>
        )}
      </SidebarMenu>
    </ScrollArea>
  );
}

export function ThreadListEmptyState({ compact }: { compact?: boolean }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 text-center", compact ? "py-6" : "py-12")}>
      <MessageSquareIcon className="size-8 text-muted-foreground/50" />
      <div className="space-y-1 px-4">
        <p className="text-sm text-muted-foreground">No conversations yet</p>
        {!compact && <p className="text-xs text-muted-foreground/70">Click the + button to start a new chat</p>}
      </div>
    </div>
  );
}

type Thread = {
  id: string;
  title: string;
  summary?: string | null;
  createdAt?: number;
  messageCount?: number;
  preview?: string | null;
  isStarred?: boolean;
  status?: ChatStatus;
};

function ChatStatusIcon({ status }: { status: ChatStatus | undefined }) {
  switch (status) {
    case "streaming":
      return <LoaderCircleIcon className="size-3.5 animate-spin text-blue-500" />;
    case "awaiting_tool_results":
      return <LoaderCircleIcon className="size-3.5 animate-spin text-muted-foreground" />;
    case "waiting_for_approval":
      return <ShieldAlertIcon className="size-3.5 text-amber-500" />;
    case "failed":
      return <XCircleIcon className="size-3.5 text-destructive" />;
    case "stopped":
      return <SquareIcon className="size-3.5 text-muted-foreground" />;
    default:
      return null;
  }
}

export function ThreadListItem({
  thread,
  isSelected,
  onDelete,
  onRename,
  onToggleStar,
  workspaceSlug,
}: {
  thread: Thread;
  isSelected: boolean;
  onDelete: (e: React.MouseEvent) => void;
  onRename?: (newTitle: string) => void;
  onToggleStar?: (e: React.MouseEvent) => void;
  workspaceSlug: string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [newTitle, setNewTitle] = useState(thread.title || "");

  const handleRename = () => {
    if (newTitle.trim() && onRename) {
      onRename(newTitle.trim());
    }
    setRenameDialogOpen(false);
  };

  const hasActiveStatus = thread.status && thread.status !== "completed";
  const isWaitingForApproval = thread.status === "waiting_for_approval";

  return (
    <SidebarMenuItem className={cn("group/item", isWaitingForApproval && "rounded-md bg-amber-500/10")}>
      <SidebarMenuButton asChild isActive={isSelected} tooltip={thread.title || "Untitled"}>
        <Link to="/workspace/$slug/chat/$chatId" params={{ slug: workspaceSlug, chatId: thread.id }}>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onToggleStar?.(e);
            }}
            className={cn(
              "shrink-0 rounded p-0.5 transition-colors",
              thread.isStarred
                ? "text-amber-500 [&>.star-icon]:block [&>.status-icon]:hidden group-hover/item:[&>.star-icon]:block group-hover/item:[&>.status-icon]:hidden"
                : hasActiveStatus
                  ? "[&>.star-icon]:hidden [&>.status-icon]:block group-hover/item:[&>.star-icon]:block group-hover/item:[&>.status-icon]:hidden group-hover/item:text-muted-foreground/50 hover:text-amber-500!"
                  : "text-muted-foreground/50 opacity-0 group-hover/item:opacity-100",
            )}
          >
            <StarIcon className={cn("star-icon size-3.5", thread.isStarred && "fill-current")} />
            {hasActiveStatus && !thread.isStarred && (
              <span className="status-icon">
                <ChatStatusIcon status={thread.status} />
              </span>
            )}
          </button>
          <span className="text-sm truncate w-[220px]">
            {thread.title || <span className="text-muted-foreground/50">Untitled</span>}
          </span>
        </Link>
      </SidebarMenuButton>
      {/* Time indicator - visible by default, hidden on hover or when menu is open */}
      {thread.createdAt && !menuOpen && (
        <span className="absolute right-1 top-[9px] text-[10px] text-muted-foreground/50 group-hover/item:opacity-0 transition-opacity pointer-events-none">
          <CompactTime timestamp={thread.createdAt} />
        </span>
      )}
      {/* Menu - hidden by default, visible on hover, not s hown when active */}
      {
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <SidebarMenuAction
              showOnHover
              className={cn("bg-sidebar-accent opacity-0 group-hover/item:opacity-100", menuOpen && "opacity-100")}
            >
              <MoreHorizontalIcon className="size-4" />
            </SidebarMenuAction>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="right">
            <DropdownMenuItem
              onClick={() => {
                setNewTitle(thread.title || "");
                setRenameDialogOpen(true);
              }}
            >
              <PencilIcon className="size-4 mr-2" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onDelete}
              className="text-destructive focus:text-destructive focus:bg-destructive/10"
            >
              <Trash2Icon className="size-4 mr-2" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }

      {/* Rename Dialog */}
      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename chat</DialogTitle>
            <DialogDescription>Enter a new name for this chat.</DialogDescription>
          </DialogHeader>
          <Input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Chat title"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handleRename();
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleRename}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SidebarMenuItem>
  );
}

export function ThreadListItemCompact({
  thread,
  isSelected,
  workspaceSlug,
  onClick,
}: {
  thread: Thread;
  isSelected: boolean;
  workspaceSlug: string;
  onClick?: () => void;
}) {
  const hasActiveStatus = thread.status && thread.status !== "completed";
  const isWaitingForApproval = thread.status === "waiting_for_approval";
  const showIcon = thread.isStarred || hasActiveStatus;

  return (
    <Link
      to="/workspace/$slug/chat/$chatId"
      params={{ slug: workspaceSlug, chatId: thread.id }}
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent",
        isSelected && "bg-accent font-medium",
        isWaitingForApproval && "bg-amber-500/10",
      )}
    >
      {thread.isStarred ? (
        <StarIcon className="size-3.5 shrink-0 fill-amber-500 text-amber-500" />
      ) : hasActiveStatus ? (
        <ChatStatusIcon status={thread.status} />
      ) : null}
      <span className={cn("truncate flex-1 max-w-[235px]", showIcon && "max-w-[213px]")}>
        {thread.title || <span className="text-muted-foreground/50">Untitled</span>}
      </span>
      {thread.createdAt && (
        <span className="text-[10px] text-muted-foreground/50 shrink-0">
          <CompactTime timestamp={thread.createdAt} />
        </span>
      )}
    </Link>
  );
}
