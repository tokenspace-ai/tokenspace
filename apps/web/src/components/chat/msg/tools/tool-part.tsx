import { api } from "@tokenspace/backend/convex/_generated/api";
import type { ToolUIPart } from "ai";
import { useQuery } from "convex/react";
import { BotIcon, FileIcon, FileSearchIcon, TerminalIcon, TvMinimalPlayIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { CredentialResolutionDialog } from "@/components/credentials/credential-resolution-dialog";
import { Button } from "@/components/ui/button";
import { credentialMissingHint, parseCredentialMissingPayload } from "@/lib/credential-missing";
import { useChatSidebarOptional } from "../../chat-sidebar";
import { ToolCallDisplay } from "./tool-call-display";
import type { AgentTools } from "./types";

export function ToolPart({ part }: { part: ToolUIPart<AgentTools>; isLastMessage: boolean }) {
  const sidebar = useChatSidebarOptional();
  const [credentialDialogOpen, setCredentialDialogOpen] = useState(false);
  const shouldFetchJobError = part.state === "output-error" && Boolean(sidebar?.threadId);
  const job = useQuery(
    api.executor.getJobByToolCallId,
    shouldFetchJobError && sidebar?.threadId ? { threadId: sidebar.threadId, toolCallId: part.toolCallId } : "skip",
  );
  const credentialMissing = useMemo(() => parseCredentialMissingPayload(job?.error?.data), [job?.error?.data]);
  const needsCredentialContext = Boolean(credentialMissing) || credentialDialogOpen;
  const sessionInfo = useQuery(
    api.sessions.getSessionInfo,
    needsCredentialContext && sidebar?.sessionId ? { sessionId: sidebar.sessionId } : "skip",
  );
  const workspaceContext = useQuery(
    api.workspace.resolveWorkspaceContext,
    needsCredentialContext && sidebar?.workspaceSlug ? { slug: sidebar.workspaceSlug } : "skip",
  );

  const getToolLabel = (toolPart: ToolUIPart<AgentTools>) => {
    switch (toolPart.type) {
      case "tool-readFile":
        return `Reading ${toolPart.input?.path ?? "..."}`;
      case "tool-writeFile":
        return `Writing ${toolPart.input?.path ?? "..."}`;
      case "tool-runCode":
        return toolPart.input?.description ?? "Running code...";
      case "tool-bash":
        return toolPart.input?.description ?? ellipsis(toolPart.input?.command, 80) ?? "...";
      case "tool-subAgent":
        return `Spawning agent: ${toolPart.input?.prompt ?? "..."}`;
      default:
        return toolPart.type;
    }
  };

  const getToolIcon = (toolPart: ToolUIPart<AgentTools>) => {
    switch (toolPart.type) {
      case "tool-readFile":
        return FileSearchIcon;
      case "tool-writeFile":
        return FileIcon;
      case "tool-runCode":
        return TvMinimalPlayIcon;
      case "tool-bash":
        return TerminalIcon;
      case "tool-subAgent":
        return BotIcon;
      default:
        return BotIcon;
    }
  };
  return (
    <>
      <ToolCallDisplay icon={getToolIcon(part)!} text={getToolLabel(part)} part={part} />
      {credentialMissing ? (
        <div className="ml-6 mt-1 mb-2 rounded-md border border-orange-500/20 bg-orange-500/10 px-3 py-2 text-xs">
          <p className="font-medium text-orange-500">
            Credential unavailable: {credentialMissing.credential.label ?? credentialMissing.credential.id} (
            {credentialMissing.credential.scope}/{credentialMissing.credential.kind})
          </p>
          <p className="mt-1 text-muted-foreground">{credentialMissingHint(credentialMissing, "re-run")}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2 h-7 text-xs"
            onClick={() => setCredentialDialogOpen(true)}
          >
            Resolve
          </Button>
        </div>
      ) : null}
      <CredentialResolutionDialog
        open={credentialDialogOpen}
        onOpenChange={setCredentialDialogOpen}
        payload={credentialMissing}
        sessionId={sidebar?.sessionId}
        revisionId={sessionInfo?.revisionId ?? null}
        workspaceId={workspaceContext?.workspace?._id ?? null}
        workspaceSlug={sidebar?.workspaceSlug}
      />
    </>
  );
}

function ellipsis(text: string | undefined, maxLength: number) {
  if (!text) return text;
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}
