"use client";

import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { ActivityIcon, TextSearchIcon, XIcon } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

// Sidebar section types (stored in URL)
export type SidebarSection = "debug" | "session";

// Session tab types (stored in URL)
export type SessionTab = "files" | "terminal";

// Debug view types (stored in URL)
export type DebugView = "messages" | "tools" | "subagents" | "approvals" | "usage" | "raw";

// Context type
type ChatSidebarContextValue = {
  // URL-based sidebar section
  sidebarSection: SidebarSection | undefined;
  // Session tab (files or terminal)
  sessionTab: SessionTab;
  setSessionTab: (tab: SessionTab) => void;
  // Debug view navigation
  debugView: DebugView | undefined;
  messageId: string | undefined;
  toolCallId: string | undefined;
  subAgentThreadId: string | undefined;
  // Navigation functions
  openToolDetails: (toolCallId: string) => void;
  openMessageDetails: (messageId: string) => void;
  openSubAgentConversation: (threadId: string) => void;
  openDebugView: (view: DebugView) => void;
  openSession: (tab?: SessionTab) => void;
  openDebug: () => void;
  closeSidebar: () => void;
  navigateToSection: (section: SidebarSection) => void;
  // Session context
  sessionId: Id<"sessions"> | undefined;
  threadId: string | undefined;
  workspaceSlug: string | undefined;
  chatId: Id<"chats"> | undefined;
};

const ChatSidebarContext = createContext<ChatSidebarContextValue | null>(null);

export function useChatSidebar() {
  const context = useContext(ChatSidebarContext);
  if (!context) {
    throw new Error("useChatSidebar must be used within ChatSidebarProvider");
  }
  return context;
}

// Optional hook that doesn't throw if context is missing
export function useChatSidebarOptional() {
  return useContext(ChatSidebarContext);
}

// Provider props
type ChatSidebarProviderProps = {
  children: ReactNode;
  sessionId?: Id<"sessions">;
  threadId?: string;
  workspaceSlug?: string;
  chatId?: Id<"chats">;
  // URL state hooks passed from route
  sidebarSection?: SidebarSection;
  sessionTab?: SessionTab;
  debugView?: DebugView;
  messageId?: string;
  toolCallId?: string;
  subAgentThreadId?: string;
  onSectionChange: (
    section: SidebarSection | undefined,
    options?: {
      tab?: SessionTab;
      debugView?: DebugView;
      messageId?: string;
      toolCallId?: string;
      subAgentThreadId?: string;
    },
  ) => void;
};

export function ChatSidebarProvider({
  children,
  sessionId,
  threadId,
  workspaceSlug,
  chatId,
  sidebarSection,
  sessionTab: urlSessionTab,
  debugView,
  messageId,
  toolCallId,
  subAgentThreadId,
  onSectionChange,
}: ChatSidebarProviderProps) {
  // Default to "files" if no tab specified
  const sessionTab = urlSessionTab ?? "files";

  const openToolDetails = useCallback(
    (toolCallId: string) => {
      onSectionChange("debug", { debugView: "tools", toolCallId });
    },
    [onSectionChange],
  );

  const openMessageDetails = useCallback(
    (messageId: string) => {
      onSectionChange("debug", { debugView: "messages", messageId });
    },
    [onSectionChange],
  );

  const openSubAgentConversation = useCallback(
    (threadId: string) => {
      onSectionChange("debug", { debugView: "subagents", subAgentThreadId: threadId });
    },
    [onSectionChange],
  );

  const openDebugView = useCallback(
    (view: DebugView) => {
      onSectionChange("debug", { debugView: view });
    },
    [onSectionChange],
  );

  const openSession = useCallback(
    (tab?: SessionTab) => {
      onSectionChange("session", { tab });
    },
    [onSectionChange],
  );

  const setSessionTab = useCallback(
    (tab: SessionTab) => {
      onSectionChange("session", { tab });
    },
    [onSectionChange],
  );

  const openDebug = useCallback(() => {
    onSectionChange("debug");
  }, [onSectionChange]);

  const closeSidebar = useCallback(() => {
    onSectionChange(undefined);
  }, [onSectionChange]);

  const navigateToSection = useCallback(
    (section: SidebarSection) => {
      onSectionChange(section);
    },
    [onSectionChange],
  );

  const value = useMemo(
    () => ({
      sidebarSection,
      sessionTab,
      setSessionTab,
      debugView,
      messageId,
      toolCallId,
      subAgentThreadId,
      openToolDetails,
      openMessageDetails,
      openSubAgentConversation,
      openDebugView,
      openSession,
      openDebug,
      closeSidebar,
      navigateToSection,
      sessionId,
      threadId,
      workspaceSlug,
      chatId,
    }),
    [
      sidebarSection,
      sessionTab,
      setSessionTab,
      debugView,
      messageId,
      toolCallId,
      subAgentThreadId,
      openToolDetails,
      openMessageDetails,
      openSubAgentConversation,
      openDebugView,
      openSession,
      openDebug,
      closeSidebar,
      navigateToSection,
      sessionId,
      threadId,
      workspaceSlug,
      chatId,
    ],
  );

  return <ChatSidebarContext.Provider value={value}>{children}</ChatSidebarContext.Provider>;
}

// Sidebar navigation dropdown
type SidebarNavigationProps = {
  currentSection: SidebarSection;
};

export function SidebarNavigation({ currentSection }: SidebarNavigationProps) {
  const { navigateToSection } = useChatSidebar();
  return (
    <div className="w-56">
      <Select value={currentSection} onValueChange={(v) => navigateToSection(v as SidebarSection)}>
        <SelectTrigger className="w-full h-9 text-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="session">
            <div className="flex items-center gap-2">
              <ActivityIcon className="size-4" />
              Session
            </div>
          </SelectItem>
          <SelectItem value="debug">
            <div className="flex items-center gap-2">
              <TextSearchIcon className="size-4" />
              Chat Thread
            </div>
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

// Sidebar panel container
type ChatSidebarPanelProps = {
  children: ReactNode;
  title: string;
  className?: string;
  footer?: ReactNode;
  /** When true, children are rendered in a flex column layout instead of a scrollable container */
  flexContent?: boolean;
  /** Show navigation dropdown in header */
  showNavigation?: boolean;
};

export function ChatSidebarPanel({
  children,
  title,
  className,
  footer,
  flexContent,
  showNavigation = true,
}: ChatSidebarPanelProps) {
  const { closeSidebar, sidebarSection } = useChatSidebar();

  return (
    <div
      className={cn(
        "flex h-full flex-col border-l border-border/40 bg-background max-h-screen overflow-y-auto",
        className,
      )}
    >
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border/40 px-4">
        {showNavigation && sidebarSection ? (
          <div className="flex-1 min-w-0">
            <SidebarNavigation currentSection={sidebarSection} />
          </div>
        ) : (
          <h2 className="text-sm font-medium truncate flex-1 mr-2">{title}</h2>
        )}
        <Button variant="ghost" size="icon-sm" onClick={closeSidebar} className="shrink-0">
          <XIcon className="size-4" />
        </Button>
      </div>
      {flexContent ? (
        <div className="flex-1 flex flex-col min-h-0">{children}</div>
      ) : (
        <div className="flex-1 overflow-auto p-4">
          <div className="min-w-0">{children}</div>
        </div>
      )}
      {footer}
    </div>
  );
}

// Main sidebar component that renders the appropriate panel
export function ChatSidebar() {
  const { sidebarSection } = useChatSidebar();

  if (!sidebarSection) {
    return null;
  }

  // Import panels dynamically to avoid circular dependencies
  // The actual panel components will be rendered by the parent
  return null;
}
