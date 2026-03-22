import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { ConvexProvider, ConvexReactClient, useMutation, useQuery } from "convex/react";
import { Box, render, Static, Text, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ensureStoredAuthDiscovery, getAccessTokenWithRefresh } from "../auth.js";
import { buildChatUrl, openUrl } from "../browser.js";
import type { ChatStatus, ChatThread } from "../client.js";
import {
  type ConversationStepItem,
  type LinkedWorkspaceContext,
  type LinkedWorkspaceRevisionContext,
  loadLinkedWorkspaceContext,
  loadLinkedWorkspaceRevisionContext,
} from "./chat.js";
import {
  addConvexMetadata,
  applyStreamingUpdates,
  isThreadRunningStatus,
  type StreamingUpdates,
  splitConversationSteps,
  type TuiMessage,
} from "./chat-tui-helpers.js";

type LaunchChatTuiOptions = {
  workspace?: string;
  model?: string;
  open?: boolean;
};

type ChatSession = {
  context: LinkedWorkspaceRevisionContext;
  chatId: Id<"chats">;
  threadId: string;
  sessionId: Id<"sessions">;
  url: string;
};

function statusLabel(status: ChatStatus | ChatThread["status"] | undefined): string {
  return status ?? "ready";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function launchChatTui(options: LaunchChatTuiOptions = {}): Promise<void> {
  const accessToken = await getAccessTokenWithRefresh();
  if (!accessToken) {
    throw new Error("Not logged in. Run `tokenspace login` to authenticate.");
  }

  const auth = await ensureStoredAuthDiscovery({
    accessToken,
    requireConvexUrl: true,
  });
  if (!auth?.convexUrl) {
    throw new Error("Convex URL not found. Run `tokenspace login` to refresh your CLI configuration.");
  }

  const client = new ConvexReactClient(auth.convexUrl);
  client.setAuth(async () => await getAccessTokenWithRefresh());

  const ink = render(
    <ConvexProvider client={client}>
      <ChatTuiApp options={options} />
    </ConvexProvider>,
    {
      exitOnCtrlC: true,
    },
  );

  try {
    await ink.waitUntilExit();
  } finally {
    await client.close();
  }
}

function ChatTuiApp({ options }: { options: LaunchChatTuiOptions }) {
  const [composerValue, setComposerValue] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [workspaceContext, setWorkspaceContext] = useState<LinkedWorkspaceContext | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const workspaceLoadedRef = useRef(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const resolved = await loadLinkedWorkspaceContext(options.workspace);
        if (!active) {
          return;
        }
        workspaceLoadedRef.current = true;
        setWorkspaceContext(resolved);
      } catch (error) {
        if (!active) {
          return;
        }
        setWorkspaceError(formatError(error));
      }
    })();
    return () => {
      active = false;
    };
  }, [options.workspace]);

  const {
    messages,
    chat,
    thread,
    currentWorkspace,
    isCreating,
    isSubmitting,
    sendPrompt,
    openFailure,
    sessionUrl: currentSessionUrl,
  } = useInkChat({
    workspace: options.workspace,
    model: options.model,
    open: options.open,
    workspaceContext,
    onError: setErrorMessage,
  });

  const activeWorkspace = currentWorkspace ?? workspaceContext;
  const { staticSteps, liveSteps } = useMemo(
    () => splitConversationSteps(messages, chat?.status ?? thread?.status),
    [messages, chat?.status, thread?.status],
  );

  const isBusy = isCreating || isSubmitting || isThreadRunningStatus(chat?.status ?? thread?.status);
  const title = chat?.title?.trim() ? chat.title : "Untitled Chat";
  const status = statusLabel(chat?.status ?? thread?.status);
  const headerWorkspace = activeWorkspace?.workspace.slug ?? options.workspace ?? "resolving…";
  const url = sessionUrl(chat?.id, activeWorkspace, currentSessionUrl);
  const footerHint = isBusy
    ? "Assistant is still running. Keep typing; Enter will submit when the turn is done."
    : "Enter to send. Ctrl+C to exit.";

  const handleSubmit = useCallback(async () => {
    const prompt = composerValue.trim();
    if (!prompt) {
      return;
    }
    if (workspaceError) {
      setErrorMessage(workspaceError);
      return;
    }
    if (isBusy) {
      setErrorMessage("Wait for the current assistant turn to complete before sending another message.");
      return;
    }

    const submitted = await sendPrompt(prompt);
    if (submitted) {
      setComposerValue("");
    }
  }, [composerValue, isBusy, sendPrompt, workspaceError]);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>Tokenspace Chat</Text>
        <Text dimColor>
          Workspace: {headerWorkspace} Status: {status} Title: {title}
        </Text>
        {url ? <Text dimColor>URL: {url}</Text> : null}
        {openFailure ? <Text color="yellow">Browser open failed: {openFailure}</Text> : null}
        {workspaceLoadedRef.current === false && !workspaceError ? <Text dimColor>Resolving workspace…</Text> : null}
        {workspaceError ? <Text color="red">{workspaceError}</Text> : null}
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {staticSteps.length === 0 && liveSteps.length === 0 ? (
          <Text dimColor>Start a conversation by typing a prompt below.</Text>
        ) : (
          <>
            <Static items={staticSteps}>{(step) => <ConversationLine key={step.id} step={step} />}</Static>
            {liveSteps.map((step) => (
              <ConversationLine key={step.id} step={step} />
            ))}
          </>
        )}
      </Box>

      {errorMessage ? (
        <Box marginBottom={1}>
          <Text color="red">{errorMessage}</Text>
        </Box>
      ) : null}

      <Composer value={composerValue} onChange={setComposerValue} onSubmit={handleSubmit} />
      <Text dimColor>{footerHint}</Text>
    </Box>
  );
}

function ConversationLine({ step }: { step: ConversationStepItem }) {
  if (step.kind === "user") {
    return <Text color="blue">{step.text}</Text>;
  }
  if (step.kind === "reasoning") {
    return <Text dimColor> {step.text}</Text>;
  }
  if (step.kind === "tool") {
    return <Text dimColor> • {step.text}</Text>;
  }
  return <Text>{step.text}</Text>;
}

function Composer({
  value,
  onChange,
  onSubmit,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void | Promise<void>;
}) {
  useInput((input, key) => {
    if (key.return) {
      void onSubmit();
      return;
    }
    if (key.backspace || key.delete) {
      onChange(value.slice(0, -1));
      return;
    }
    if (key.ctrl && input === "u") {
      onChange("");
      return;
    }
    if (
      key.ctrl ||
      key.meta ||
      key.tab ||
      key.escape ||
      key.upArrow ||
      key.downArrow ||
      key.leftArrow ||
      key.rightArrow
    ) {
      return;
    }
    if (input.length > 0) {
      onChange(`${value}${input}`);
    }
  });

  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} marginBottom={1}>
      <Text color="blue">&gt; </Text>
      {value.length > 0 ? <Text>{value}</Text> : <Text dimColor>Send a message…</Text>}
      <Text inverse> </Text>
    </Box>
  );
}

function useInkChat({
  workspace,
  model,
  open,
  workspaceContext,
  onError,
}: {
  workspace?: string;
  model?: string;
  open?: boolean;
  workspaceContext: LinkedWorkspaceContext | null;
  onError: (message: string | null) => void;
}) {
  const [session, setSession] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<TuiMessage[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [openFailure, setOpenFailure] = useState<string | null>(null);
  const [fromSeq, setFromSeq] = useState<number | null>(null);
  const didOpenRef = useRef(false);

  const createChatMutation = useMutation(api.ai.chat.createChat);
  const sendChatMessageMutation = useMutation(api.ai.chat.sendChatMessage);

  const chat = useQuery(api.ai.chat.getChatDetails, session ? { chatId: session.chatId } : "skip");
  const thread = useQuery(api.ai.chat.getThread, session ? { threadId: session.threadId } : "skip");
  const persistedMessages = useQuery(api.ai.chat.listMessages, session ? { threadId: session.threadId } : "skip");
  const streamingUpdates = useQuery(
    api.ai.chat.streamUpdates,
    session && fromSeq !== null ? { threadId: session.threadId, fromSeq } : "skip",
  );

  const normalizedMessages = useMemo(() => (persistedMessages ?? []).map(addConvexMetadata), [persistedMessages]);

  useEffect(() => {
    if (normalizedMessages.length === 0) {
      setFromSeq(0);
      return;
    }
    const maxCommitted = Math.max(...normalizedMessages.map((message) => message.metadata?.committedSeq ?? -1));
    setFromSeq(Number.isFinite(maxCommitted) ? maxCommitted + 1 : 0);
  }, [normalizedMessages]);

  useEffect(() => {
    let active = true;
    if (!streamingUpdates || (streamingUpdates as StreamingUpdates).messages.length === 0) {
      setMessages(normalizedMessages);
      return;
    }
    void applyStreamingUpdates(normalizedMessages, streamingUpdates as StreamingUpdates).then(
      (nextMessages) => {
        if (active) {
          setMessages(nextMessages);
        }
      },
      (error) => {
        if (active) {
          onError(formatError(error));
          setMessages(normalizedMessages);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [normalizedMessages, onError, streamingUpdates]);

  const sendPrompt = useCallback(
    async (prompt: string): Promise<boolean> => {
      onError(null);
      try {
        let currentSession = session;
        if (!currentSession) {
          setIsCreating(true);
          const revisionContext = await loadLinkedWorkspaceRevisionContext(workspace);
          const created = await createChatMutation({
            revisionId: revisionContext.revisionId,
            modelId: model,
          });
          currentSession = {
            context: revisionContext,
            chatId: created.chatId,
            threadId: created.threadId,
            sessionId: created.sessionId,
            url: buildChatUrl(revisionContext.workspace.slug, created.chatId),
          };
          setSession(currentSession);
          if (open && !didOpenRef.current) {
            didOpenRef.current = true;
            void openUrl(currentSession.url).catch((error) => {
              setOpenFailure(formatError(error));
            });
          }
        }

        setIsSubmitting(true);
        await sendChatMessageMutation({
          chatId: currentSession.chatId,
          prompt,
        });
        return true;
      } catch (error) {
        onError(formatError(error));
        return false;
      } finally {
        setIsCreating(false);
        setIsSubmitting(false);
      }
    },
    [createChatMutation, model, onError, open, sendChatMessageMutation, session, workspace],
  );

  return {
    messages,
    chat,
    thread,
    currentWorkspace: session?.context ?? workspaceContext,
    isCreating,
    isSubmitting,
    sendPrompt,
    openFailure,
    sessionUrl: session?.url ?? null,
  };
}

function sessionUrl(
  chatId: Id<"chats"> | undefined,
  workspaceContext: LinkedWorkspaceContext | LinkedWorkspaceRevisionContext | null,
  fallbackUrl: string | null | undefined,
): string | null {
  if (chatId && workspaceContext) {
    return buildChatUrl(workspaceContext.workspace.slug, chatId);
  }
  return fallbackUrl ?? null;
}
