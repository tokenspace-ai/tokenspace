"use client";

import { api } from "@tokenspace/backend/convex/_generated/api";
import { useQuery } from "convex/react";
import type { LucideIcon } from "lucide-react";
import { CheckCircleIcon, CircleIcon, Copy, FolderIcon, GitBranchIcon, TerminalIcon, XCircleIcon } from "lucide-react";
import { SessionFileExplorer } from "@/components/session/session-file-explorer";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ChatSidebarPanel, useChatSidebar } from "./chat-sidebar";
import { SessionTerminal } from "./session-terminal";

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text);
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, { className: string; icon: LucideIcon; label: string }> = {
    active: { className: "bg-blue-500/10 text-blue-500 border-blue-500/20", icon: CircleIcon, label: "Active" },
    running: { className: "bg-blue-500/10 text-blue-500 border-blue-500/20", icon: CircleIcon, label: "Running" },
    completed: {
      className: "bg-green-500/10 text-green-500 border-green-500/20",
      icon: CheckCircleIcon,
      label: "Completed",
    },
    failed: {
      className: "bg-red-500/10 text-red-500 border-red-500/20",
      icon: XCircleIcon,
      label: "Failed",
    },
    detached: {
      className: "bg-gray-500/10 text-gray-500 border-gray-500/20",
      icon: GitBranchIcon,
      label: "Detached",
    },
  };

  const config = variants[status] ?? variants.active;
  const Icon = config.icon;

  return (
    <Badge variant="outline" className={cn("gap-1 text-[10px]", config.className)}>
      <Icon className="size-2.5 fill-current" />
      {config.label}
    </Badge>
  );
}

function IdBadge({ id }: { id: string }) {
  const shortId = id.length > 16 ? `${id.slice(0, 6)}...${id.slice(-6)}` : id;
  return (
    <button
      type="button"
      onClick={() => copyToClipboard(id)}
      className="inline-flex items-center gap-1 px-1 py-0.5 rounded bg-muted text-[10px] font-mono hover:bg-muted/80 transition-colors"
      title={`Click to copy: ${id}`}
    >
      {shortId}
      <Copy className="size-2 text-muted-foreground" />
    </button>
  );
}

// Session info header component
function SessionInfoHeader({
  session,
}: {
  session: {
    _id: string;
    status: string;
    createdAt: number;
    updatedAt?: number;
  };
}) {
  return (
    <div className="p-3 border-b border-border/40 space-y-2 bg-muted/20">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Session</span>
        <StatusBadge status={session.status} />
      </div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">ID</span>
        <IdBadge id={session._id} />
      </div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Created</span>
        <span className="text-[10px]">{formatRelativeTime(session.createdAt)}</span>
      </div>
    </div>
  );
}

// Tab bar component
export type PlaygroundSessionTab = "files" | "terminal";

export function SessionTabBar({
  activeTab,
  onTabChange,
}: {
  activeTab: PlaygroundSessionTab;
  onTabChange: (tab: PlaygroundSessionTab) => void;
}) {
  return (
    <div className="flex border-b border-border/40">
      <button
        type="button"
        onClick={() => onTabChange("files")}
        className={cn(
          "flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors",
          activeTab === "files"
            ? "text-foreground border-b-2 border-primary bg-muted/30"
            : "text-muted-foreground hover:text-foreground hover:bg-muted/20",
        )}
      >
        <FolderIcon className="size-3.5" />
        Files
      </button>
      <button
        type="button"
        onClick={() => onTabChange("terminal")}
        className={cn(
          "flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors",
          activeTab === "terminal"
            ? "text-foreground border-b-2 border-primary bg-muted/30"
            : "text-muted-foreground hover:text-foreground hover:bg-muted/20",
        )}
      >
        <TerminalIcon className="size-3.5" />
        Terminal
      </button>
    </div>
  );
}

export function SessionPanel() {
  const { sidebarSection, sessionId, sessionTab, setSessionTab, workspaceSlug } = useChatSidebar();

  const isActive = sidebarSection === "session";

  // Fetch session info
  const session = useQuery(api.sessions.getSessionInfo, sessionId && isActive ? { sessionId } : "skip");

  if (!isActive) {
    return null;
  }

  return (
    <ChatSidebarPanel title="Session" flexContent>
      {/* Session info header */}
      {session && (
        <SessionInfoHeader
          session={{
            _id: session._id,
            status: session.status,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
          }}
        />
      )}

      {/* Tab bar */}
      <SessionTabBar activeTab={sessionTab} onTabChange={setSessionTab} />

      {/* Content based on active tab */}
      <div className="flex-1 flex flex-col min-h-0">
        {sessionTab === "files" ? (
          sessionId ? (
            <SessionFileExplorer sessionId={sessionId} className="flex-1 min-h-0" />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center text-muted-foreground">
              <FolderIcon className="size-8 mb-2 opacity-50" />
              <p className="text-sm">No session available</p>
            </div>
          )
        ) : (
          /* Terminal tab */
          <div className="flex-1 min-h-0 relative">
            {session?.revisionId && sessionId ? (
              <SessionTerminal
                sessionId={sessionId}
                revisionId={session.revisionId}
                workspaceSlug={workspaceSlug}
                className="h-full"
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center text-center text-muted-foreground">
                <TerminalIcon className="size-8 mb-2 opacity-50" />
                <p className="text-sm">Loading session...</p>
              </div>
            )}
          </div>
        )}
      </div>
    </ChatSidebarPanel>
  );
}
