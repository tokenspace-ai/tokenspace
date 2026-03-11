import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { api } from "@tokenspace/backend/convex/_generated/api";
import { useAction, useQuery as useConvexQuery, useMutation } from "convex/react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { ChatConversationView } from "@/components/chat/chat-conversation-view";
import { ChatPromptInput } from "@/components/chat/chat-prompt-input";
import {
  createOptimisticUserMessage,
  createOptimisticUserMessageFromPrompt,
} from "@/components/chat/optimistic-message";
import { useWorkspaceRevision } from "@/components/workspace-revision";
import { useCallbackRef } from "@/hooks/use-callback-ref";
import { setPendingChatBootstrap } from "@/lib/pending-chat-bootstrap";
import { appendUploadedFilesToPrompt, uploadPromptInputFiles } from "@/lib/session-file-uploads";
import { useWorkspaceContext } from "./route";

export const Route = createFileRoute("/_app/workspace/$slug/_app/chat/")({
  component: ChatIndexPage,
});

function ChatIndexPage() {
  const navigate = useNavigate();
  const { slug, workspaceName, branchName } = useWorkspaceContext();
  const createChat = useMutation(api.ai.chat.createChat);
  const sendChatMessage = useMutation(api.ai.chat.sendChatMessage);
  const getUploadMetadata = useAction(api.fs.overlay.getUploadMetadata);
  const writeOverlayFile = useAction(api.fs.overlay.writeFile);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [optimisticMessages, setOptimisticMessages] = useState<ReturnType<typeof createOptimisticUserMessage>[]>([]);

  const revisionId = useWorkspaceRevision();

  // Get workspace default model
  const defaultModelFromWorkspace = useConvexQuery(api.workspace.getDefaultModel, {
    revisionId,
  });
  const currentModelId = useMemo(
    () =>
      selectedModelId ??
      defaultModelFromWorkspace?.id ??
      defaultModelFromWorkspace?.modelId ??
      "anthropic/claude-opus-4.6",
    [selectedModelId, defaultModelFromWorkspace],
  );
  const handleSubmit = useCallbackRef(async (message: PromptInputMessage) => {
    if ((!message.text.trim() && message.files.length === 0) || isSubmitting) return;

    setOptimisticMessages([createOptimisticUserMessage({ text: message.text, files: message.files })]);

    try {
      setIsSubmitting(true);
      const { chatId, sessionId } = await createChat({
        revisionId,
        modelId: currentModelId,
      });

      let prompt = message.text;
      if (message.files.length > 0) {
        const uploaded = await uploadPromptInputFiles({
          sessionId,
          files: message.files,
          getUploadMetadata,
          writeFile: writeOverlayFile,
        });
        prompt = appendUploadedFilesToPrompt(prompt, uploaded);
      }

      await sendChatMessage({ chatId, prompt });
      setPendingChatBootstrap(chatId, {
        modelId: currentModelId,
        messages: [createOptimisticUserMessageFromPrompt(prompt)],
      });

      navigate({
        to: "/workspace/$slug/chat/$chatId",
        params: { slug, chatId },
      });
    } catch (error) {
      console.error(error);
      toast.error(error instanceof Error ? error.message : "Failed to create chat.");
      setOptimisticMessages([]);
    } finally {
      setIsSubmitting(false);
    }
  });

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border/40 px-6">
        <div className="flex items-center gap-3">
          <h1 className="font-semibold tracking-tight">
            <span className="text-muted-foreground/30">New Chat</span>
            <span className="ml-2 text-xs text-muted-foreground/50">
              in {workspaceName}
              {branchName !== "main" && ` (${branchName})`}
            </span>
          </h1>
        </div>
      </header>

      <ChatConversationView
        messages={optimisticMessages}
        isLoading={isSubmitting && optimisticMessages.length === 0}
        isGenerating={isSubmitting}
        emptyStateTitle="Start a conversation"
        emptyStateDescription={`Chat with AI in the ${workspaceName} tokenspace.`}
      />

      <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-6">
        <ChatPromptInput
          onSubmit={handleSubmit}
          currentModelId={currentModelId}
          onModelSelect={setSelectedModelId}
          revisionId={revisionId}
          disabled={isSubmitting}
          status={isSubmitting ? "streaming" : "ready"}
        />
      </div>
    </div>
  );
}
