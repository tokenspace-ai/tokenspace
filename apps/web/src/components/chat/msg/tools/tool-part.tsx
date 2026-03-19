import { Link } from "@tanstack/react-router";
import { api } from "@tokenspace/backend/convex/_generated/api";
import type { ToolUIPart } from "ai";
import { useQuery } from "convex/react";
import { AlertCircleIcon, BotIcon, FileIcon, FileSearchIcon, TerminalIcon, TvMinimalPlayIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { ResolvedCredentialIcon } from "@/components/credentials/credential-icon";
import { CredentialResolutionDialog } from "@/components/credentials/credential-resolution-dialog";
import { Button } from "@/components/ui/button";
import { credentialMissingHint, parseCredentialMissingPayload } from "@/lib/credential-missing";
import {
  executorUnavailableHint,
  executorUnavailableTitle,
  parseExecutorUnavailablePayload,
} from "@/lib/executor-unavailable";
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
  const executorUnavailable = useMemo(() => parseExecutorUnavailablePayload(job?.error?.data), [job?.error?.data]);
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
      {executorUnavailable ? (
        <div className="ml-6 mt-1 mb-2 rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs">
          <p className="flex items-center gap-1 font-medium text-red-500">
            <AlertCircleIcon className="size-3.5" />
            {executorUnavailableTitle(executorUnavailable)}
          </p>
          <p className="mt-1 text-muted-foreground">
            {executorUnavailableHint(executorUnavailable, {
              workspaceSlug: sidebar?.workspaceSlug,
              retryLabel: "re-run",
            })}
          </p>
          {sidebar?.workspaceSlug ? (
            <Link
              to="/workspace/$slug/admin/executor"
              params={{ slug: sidebar.workspaceSlug }}
              className="mt-2 inline-flex text-xs font-medium text-red-500 underline underline-offset-4"
            >
              Open Executor settings
            </Link>
          ) : null}
        </div>
      ) : null}
      {credentialMissing ? (
        <div className="ml-6 mt-1 mb-2 rounded-md border border-orange-500/20 bg-orange-500/10 px-3 py-2 text-xs">
          <div className="flex items-center gap-2">
            <ResolvedCredentialIcon
              credentialId={credentialMissing.credential.id}
              name={credentialMissing.credential.label ?? credentialMissing.credential.id}
              sessionId={sidebar?.sessionId}
              revisionId={sessionInfo?.revisionId ?? null}
              className="size-6 rounded-md border border-orange-500/20 bg-background/80"
              imageClassName="object-contain p-1"
              fallbackClassName="text-[10px]"
            />
            <p className="font-medium text-orange-500">
              Credential unavailable: {credentialMissing.credential.label ?? credentialMissing.credential.id} (
              {credentialMissing.credential.scope}/{credentialMissing.credential.kind})
            </p>
          </div>
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
