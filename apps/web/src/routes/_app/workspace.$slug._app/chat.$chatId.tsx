import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { useAgentChat } from "@tokenspace/convex-durable-agents/react";
import { useAction, useQuery as useConvexQuery, useMutation } from "convex/react";
import {
  MoreVerticalIcon,
  PencilIcon,
  RefreshCcwIcon,
  SquareActivityIcon,
  StarIcon,
  TextSearchIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Context,
  ContextContent,
  ContextContentFooter,
  ContextContentHeader,
  ContextTrigger,
} from "@/components/ai-elements/context";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { ChatConversationView } from "@/components/chat/chat-conversation-view";
import { ChatPromptInput } from "@/components/chat/chat-prompt-input";
import { ChatSidebarProvider, type SessionTab, useChatSidebar } from "@/components/chat/chat-sidebar";
import { DebugPanel } from "@/components/chat/debug-panel";
import { SessionPanel } from "@/components/chat/session-panel";
import { ErrorBoundary } from "@/components/error-boundary";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { useWorkspaceRevision } from "@/components/workspace-revision";
import { useCallbackRef } from "@/hooks/use-callback-ref";
import {
  clearPendingChatBootstrap,
  getPendingChatBootstrap,
  type PendingChatBootstrap,
} from "@/lib/pending-chat-bootstrap";
import { appendUploadedFilesToPrompt, uploadPromptInputFiles } from "@/lib/session-file-uploads";
import { cn } from "@/lib/utils";
import { useWorkspaceContext } from "./route";

// Claude claude-opus-4-20250514 context window size (200k tokens)
const MAX_CONTEXT_TOKENS = 200000;

// Sidebar section types stored in URL
export type SidebarSection = "debug" | "session";

// Debug subview types
export type DebugView = "messages" | "tools" | "subagents" | "approvals" | "usage" | "raw";

export type ChatSearchParams = {
  sidebar?: SidebarSection;
  tab?: "files" | "terminal";
  debugView?: DebugView;
  messageId?: string;
  toolCallId?: string;
  subAgentThreadId?: string;
};

export const Route = createFileRoute("/_app/workspace/$slug/_app/chat/$chatId")({
  component: ChatPage,
  validateSearch: (search: Record<string, unknown>): ChatSearchParams => ({
    sidebar: ["debug", "session"].includes(search.sidebar as string) ? (search.sidebar as SidebarSection) : undefined,
    tab: ["files", "terminal"].includes(search.tab as string) ? (search.tab as SessionTab) : undefined,
    debugView: ["messages", "tools", "subagents", "approvals", "usage", "raw"].includes(search.debugView as string)
      ? (search.debugView as DebugView)
      : undefined,
    messageId: typeof search.messageId === "string" ? search.messageId : undefined,
    toolCallId: typeof search.toolCallId === "string" ? search.toolCallId : undefined,
    subAgentThreadId: typeof search.subAgentThreadId === "string" ? search.subAgentThreadId : undefined,
  }),
});

// Export hook for accessing search params and navigation
export function useChatSearchParams() {
  const searchParams = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const setSearchParams = useCallback(
    (params: Partial<ChatSearchParams>) => {
      navigate({
        search: (prev) => ({
          ...prev,
          ...params,
        }),
      });
    },
    [navigate],
  );

  const clearSidebar = useCallback(() => {
    navigate({
      search: {},
    });
  }, [navigate]);

  return { searchParams, setSearchParams, clearSidebar };
}

function ChatPage() {
  const { chatId: chatIdParam } = Route.useParams();
  const chatId = chatIdParam as Id<"chats">;
  const chat = useConvexQuery(api.ai.chat.getChatDetails, { chatId });
  const pendingBootstrap = getPendingChatBootstrap(chatId);

  if (chat === undefined) {
    if (pendingBootstrap) {
      return (
        <ErrorBoundary key={`${chatId}-pending`} name="ChatPagePending">
          <PendingChatInterface pendingBootstrap={pendingBootstrap} />
        </ErrorBoundary>
      );
    }

    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-xs text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (chat === null) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-xs text-muted-foreground">Chat not found</div>
      </div>
    );
  }

  return (
    <ErrorBoundary key={chatId} name="ChatPage">
      <ChatInterface chatId={chatId} chat={chat} />
    </ErrorBoundary>
  );
}

function PendingChatInterface({ pendingBootstrap }: { pendingBootstrap: PendingChatBootstrap }) {
  const revisionId = useWorkspaceRevision();

  return (
    <div className="flex h-full flex-col">
      <header className="group flex h-14 shrink-0 items-center justify-between border-b border-border/40 px-6">
        <div className="flex items-center gap-3">
          <h1 className="font-semibold tracking-tight">
            <span className="text-muted-foreground/30">Untitled Chat</span>
          </h1>
        </div>
      </header>

      <ChatConversationView messages={pendingBootstrap.messages} isGenerating />

      <div className={cn("w-full shrink-0 px-4 pb-6", "mx-auto max-w-3xl")}>
        <ChatPromptInput
          onSubmit={() => {}}
          currentModelId={pendingBootstrap.modelId}
          onModelSelect={() => {}}
          revisionId={revisionId}
          disabled
          status="submitted"
        />
      </div>
    </div>
  );
}

function useGenerateChatSummary(chatId: Id<"chats">) {
  const [isGeneratingSummary, setIsGeneratingSummary] = useState(false);
  const generateChatSummaryAction = useAction(api.ai.chat.regenerateChatSummary);
  const generateChatSummary = useCallback(async () => {
    try {
      setIsGeneratingSummary(true);
      await generateChatSummaryAction({ chatId });
    } catch (error) {
      console.error(error);
    } finally {
      setIsGeneratingSummary(false);
    }
  }, [chatId, generateChatSummaryAction]);
  return [generateChatSummary, isGeneratingSummary] as const;
}

function ChatInterface({
  chatId,
  chat,
}: {
  chatId: Id<"chats">;
  chat: {
    threadId: string;
    sessionId: Id<"sessions">;
    title: string;
    summary?: string | null;
    errorMessage?: string;
    usage?: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      reasoningTokens?: number;
      cachedInputTokens?: number;
      cacheWriteInputTokens?: number;
    };
    modelId?: string;
    isStarred: boolean;
  };
}) {
  const { slug } = Route.useParams();
  const { searchParams, setSearchParams, clearSidebar } = useChatSearchParams();
  const { workspaceName } = useWorkspaceContext();
  const sessionId = chat.sessionId;

  const handleSectionChange = useCallback(
    (
      section: SidebarSection | undefined,
      options?: {
        tab?: SessionTab;
        debugView?: DebugView;
        messageId?: string;
        toolCallId?: string;
        subAgentThreadId?: string;
      },
    ) => {
      if (section === undefined) {
        clearSidebar();
      } else {
        setSearchParams({
          sidebar: section,
          tab: options?.tab,
          debugView: options?.debugView,
          messageId: options?.messageId,
          toolCallId: options?.toolCallId,
          subAgentThreadId: options?.subAgentThreadId,
        });
      }
    },
    [setSearchParams, clearSidebar],
  );

  return (
    <ChatSidebarProvider
      sessionId={sessionId}
      threadId={chat.threadId}
      workspaceSlug={slug}
      chatId={chatId}
      sidebarSection={searchParams.sidebar}
      sessionTab={searchParams.tab}
      debugView={searchParams.debugView}
      messageId={searchParams.messageId}
      toolCallId={searchParams.toolCallId}
      subAgentThreadId={searchParams.subAgentThreadId}
      onSectionChange={handleSectionChange}
    >
      <ChatInterfaceContent
        chatId={chatId}
        chat={chat}
        slug={slug}
        workspaceName={workspaceName}
        sessionId={sessionId}
      />
    </ChatSidebarProvider>
  );
}

function ChatInterfaceContent({
  chatId,
  chat,
  slug,
  sessionId,
}: {
  chatId: Id<"chats">;
  chat: {
    threadId: string;
    sessionId: Id<"sessions">;
    title: string;
    summary?: string | null;
    errorMessage?: string;
    usage?: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      reasoningTokens?: number;
      cachedInputTokens?: number;
      cacheWriteInputTokens?: number;
    };
    modelId?: string;
    isStarred: boolean;
  };
  slug: string;
  workspaceName: string;
  sessionId: Id<"sessions">;
}) {
  const { sidebarSection, openSession, openDebug } = useChatSidebar();

  const navigate = useNavigate();
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(chat?.title || "");
  const editInputRef = useRef<HTMLInputElement>(null);

  const updateChat = useMutation(api.ai.chat.updateChat);
  const deleteChatMutation = useMutation(api.ai.chat.deleteChat);
  const starChatMutation = useMutation(api.ai.chat.starChat);
  const unstarChatMutation = useMutation(api.ai.chat.unstarChat);

  const handleToggleStar = useCallback(async () => {
    if (chat.isStarred) {
      await unstarChatMutation({ chatId });
    } else {
      await starChatMutation({ chatId });
    }
  }, [chat.isStarred, chatId, starChatMutation, unstarChatMutation]);

  const startEditing = useCallback(() => {
    setEditTitle(chat?.title || "");
    setIsEditing(true);
  }, [chat?.title]);

  const commitRename = useCallback(async () => {
    const trimmed = editTitle.trim();
    setIsEditing(false);
    if (trimmed && trimmed !== chat?.title) {
      await updateChat({ chatId, title: trimmed });
    }
  }, [editTitle, chat?.title, updateChat, chatId]);

  const cancelEditing = useCallback(() => {
    setIsEditing(false);
    setEditTitle(chat?.title || "");
  }, [chat?.title]);

  const handleDelete = useCallback(async () => {
    await deleteChatMutation({ chatId });
    navigate({ to: "/workspace/$slug/chat", params: { slug } });
  }, [deleteChatMutation, chatId, navigate, slug]);

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditing && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [isEditing]);

  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const updateChatModel = useMutation(api.ai.chat.updateChatModel);
  const revisionId = useWorkspaceRevision();
  const defaultModelFromWorkspace = useConvexQuery(api.workspace.getDefaultModel, {
    revisionId,
  });
  // Use selected model, then thread's stored model, then workspace default, then fallback
  const currentModelId =
    selectedModelId ??
    chat?.modelId ??
    defaultModelFromWorkspace?.id ??
    defaultModelFromWorkspace?.modelId ??
    "anthropic/claude-opus-4.6";

  // Handle model selection change
  const handleModelSelect = useCallback(
    (modelId: string) => {
      setSelectedModelId(modelId);
      // Persist to backend
      updateChatModel({
        chatId,
        modelId: modelId,
      });
    },
    [chatId, updateChatModel],
  );

  const {
    messages: loadedMessages,
    sendMessage,
    stop,
    isLoading: isLoadingMessages,
    isFailed,
    isRunning,
    // isComplete,
    // isStopped,
    // resume,
  } = useAgentChat({
    threadId: chat.threadId,
    getThread: api.ai.chat.getThread,
    listMessages: api.ai.chat.listMessages,
    streamUpdates: api.ai.chat.streamUpdates,
    sendMessage: api.ai.chat.sendMessage,
    stopThread: api.ai.chat.stopThread,
    resumeThread: api.ai.chat.resumeThread,
  });

  const pendingBootstrap = getPendingChatBootstrap(chatId);
  const messages = !loadedMessages?.length ? (pendingBootstrap?.messages ?? loadedMessages) : loadedMessages;

  useEffect(() => {
    if (pendingBootstrap != null && loadedMessages?.length) {
      clearPendingChatBootstrap(chatId);
    }
  }, [loadedMessages, pendingBootstrap, chatId]);

  const [generateChatSummary, isGeneratingSummary] = useGenerateChatSummary(chatId);
  // const [retryChat, isRetrying] = useRetryChat(chatId);

  const isGenerating = isRunning;
  const isError = isFailed;
  const [isStopping, setIsStopping] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const getUploadMetadata = useAction(api.fs.overlay.getUploadMetadata);
  const writeOverlayFile = useAction(api.fs.overlay.writeFile);

  const handleStop = useCallbackRef(async () => {
    if (!isRunning) return;
    try {
      setIsStopping(true);
      await stop();
    } catch (error) {
      console.error(error);
      toast.error(error instanceof Error ? error.message : "Failed to stop chat.");
    } finally {
      setIsStopping(false);
    }
  });

  const handleSubmit = useCallbackRef(async (message: PromptInputMessage) => {
    if (isRunning || isUploading) return;
    if (!message.text.trim() && message.files.length === 0) return;
    const hasFiles = message.files.length > 0;
    try {
      if (hasFiles) {
        setIsUploading(true);
      }
      let prompt = message.text;
      if (hasFiles) {
        const uploaded = await uploadPromptInputFiles({
          sessionId,
          files: message.files,
          getUploadMetadata,
          writeFile: writeOverlayFile,
        });
        prompt = appendUploadedFilesToPrompt(prompt, uploaded);
      }
      await sendMessage(prompt);
    } catch (error) {
      console.error(error);
      toast.error(error instanceof Error ? error.message : "Failed to upload attachments.");
      throw error;
    } finally {
      if (hasFiles) {
        setIsUploading(false);
      }
    }
  });

  const hasSidebar = !!sidebarSection;

  return (
    <ResizablePanelGroup className="flex-1 min-h-0 max-h-screen overflow-hidden bg-background">
      <ResizablePanel defaultSize={hasSidebar ? 50 : 100} minSize={40} className="min-w-0">
        <div className="flex h-full flex-col">
          <header className="group flex h-14 shrink-0 items-center justify-between border-b border-border/40 px-6">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleToggleStar}
                className={cn(
                  "flex size-8 items-center justify-center rounded-lg transition-colors",
                  chat.isStarred
                    ? "text-amber-500 hover:text-amber-600"
                    : "text-muted-foreground/40 hover:text-amber-500",
                )}
                title={chat.isStarred ? "Unstar chat" : "Star chat"}
              >
                <StarIcon className={cn("size-4", chat.isStarred && "fill-current")} />
              </button>
              <div className="flex items-center gap-2">
                {isEditing ? (
                  <input
                    ref={editInputRef}
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        commitRename();
                      } else if (e.key === "Escape") {
                        cancelEditing();
                      }
                    }}
                    onBlur={commitRename}
                    className="h-7 rounded-md border border-border bg-background px-2 font-semibold tracking-tight text-sm outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/15"
                  />
                ) : (
                  <h1
                    className="cursor-pointer font-semibold tracking-tight rounded-md px-1 -mx-1 hover:bg-muted/50 transition-colors"
                    onClick={startEditing}
                    title="Click to rename"
                  >
                    {chat?.title ? (
                      <span>{chat.title}</span>
                    ) : (
                      <span className="text-muted-foreground/30">Untitled Chat</span>
                    )}
                  </h1>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn("opacity-0 group-hover:opacity-100", isGeneratingSummary && "opacity-100")}
                onClick={generateChatSummary}
                disabled={isGeneratingSummary}
              >
                <RefreshCcwIcon className={cn("size-4", isGeneratingSummary ? "animate-spin" : "")} />
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm">
                    <MoreVerticalIcon className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={startEditing}>
                    <PencilIcon className="size-4" />
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => openSession()}>
                    <SquareActivityIcon className="size-4" />
                    Inspect Session
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={openDebug}>
                    <TextSearchIcon className="size-4" />
                    Inspect Chat Thread
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={handleDelete}
                    className="text-destructive focus:text-destructive focus:bg-destructive/10"
                  >
                    <Trash2Icon className="size-4" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>

          <ChatConversationView
            messages={messages}
            sessionId={sessionId}
            isLoading={isLoadingMessages}
            isGenerating={isGenerating}
            isError={isError}
            errorMessage={chat?.errorMessage}
          />

          <div className={cn("w-full shrink-0 px-4 pb-6", "mx-auto max-w-3xl")}>
            <ChatPromptInput
              onSubmit={handleSubmit}
              onStop={handleStop}
              currentModelId={currentModelId}
              onModelSelect={handleModelSelect}
              revisionId={revisionId}
              disabled={isUploading || isStopping}
              status={isRunning ? "streaming" : isUploading ? "submitted" : "ready"}
              extraTools={
                chat?.usage && (
                  <Context
                    usedTokens={chat.usage.inputTokens}
                    maxTokens={MAX_CONTEXT_TOKENS}
                    usage={{
                      inputTokens: chat.usage.inputTokens,
                      outputTokens: undefined,
                      totalTokens: undefined,
                      reasoningTokens: undefined,
                      cachedInputTokens: undefined,
                      inputTokenDetails: {
                        noCacheTokens: undefined,
                        cacheReadTokens: undefined,
                        cacheWriteTokens: undefined,
                      },
                      outputTokenDetails: {
                        reasoningTokens: undefined,
                        textTokens: undefined,
                      },
                    }}
                    modelId={currentModelId}
                  >
                    <ContextTrigger className="h-8 px-2 text-xs" />
                    <ContextContent>
                      <ContextContentHeader />
                      <ContextContentFooter />
                    </ContextContent>
                  </Context>
                )
              }
            />
          </div>
        </div>
      </ResizablePanel>

      {/* Sidebar */}
      {hasSidebar && (
        <>
          <ResizableHandle />
          <ResizablePanel defaultSize={50} minSize={25} className="min-w-0">
            {sidebarSection === "debug" && <DebugPanel />}
            {sidebarSection === "session" && <SessionPanel />}
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}
