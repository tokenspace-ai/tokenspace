import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { api } from "@tokenspace/backend/convex/_generated/api";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { useAction, useQuery as useConvexQuery, useMutation } from "convex/react";
import { SparklesIcon } from "lucide-react";
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

export const Route = createFileRoute("/_app/workspace/$slug/_app/")({
  component: WorkspaceHomePage,
});

function WorkspaceHomePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { slug, workspaceName } = useWorkspaceContext();
  const revisionId = useWorkspaceRevision();
  const createChat = useMutation(api.ai.chat.createChat);
  const sendChatMessage = useMutation(api.ai.chat.sendChatMessage);
  const getUploadMetadata = useAction(api.fs.overlay.getUploadMetadata);
  const writeOverlayFile = useAction(api.fs.overlay.writeFile);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [optimisticMessages, setOptimisticMessages] = useState<ReturnType<typeof createOptimisticUserMessage>[]>([]);

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

  const firstName = user?.firstName ?? "there";

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

  const isShowingOptimisticConversation = optimisticMessages.length > 0;

  return (
    <div className="flex h-full flex-col bg-background">
      {isShowingOptimisticConversation ? (
        <>
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
        </>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center px-4">
          <div className="w-full max-w-2xl space-y-8">
            <div className="text-center space-y-2">
              <h1 className="text-4xl font-bold tracking-tight">Welcome, {firstName}</h1>
              <p className="text-lg text-muted-foreground">
                What would you like to do in <span className="font-medium text-foreground">{workspaceName}</span>?
              </p>
            </div>

            <ChatPromptInput
              onSubmit={handleSubmit}
              currentModelId={currentModelId}
              onModelSelect={setSelectedModelId}
              revisionId={revisionId}
              disabled={isSubmitting}
              status={isSubmitting ? "streaming" : "ready"}
              placeholder="Ask a question or describe what you want to do..."
              textareaClassName="min-h-[80px] resize-none border-0 bg-transparent px-4 py-4 text-base focus-visible:ring-0"
            />

            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <SparklesIcon className="size-4" />
              <span>Start a conversation to automate tasks, run queries, or get help</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
