"use client";

import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import { Loader2Icon, TerminalIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ApprovalRequestCard } from "@/components/chat/approval-request";
import { CredentialResolutionDialog } from "@/components/credentials/credential-resolution-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  type CredentialMissingPayload,
  credentialMissingHint,
  parseCredentialMissingPayload,
} from "@/lib/credential-missing";
import { LiteTerminal } from "./lite-terminal";

// CSS styles for the terminal
const terminalStyles = `
.lite-terminal {
  font-family: "Geist Mono", "SF Mono", Menlo, monospace;
  font-size: 13px;
  line-height: 1.4;
  padding: 12px;
  height: 100%;
  overflow-y: auto;
  position: relative;
}

.lite-terminal-output {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.lite-terminal-line {
  min-height: 1.4em;
}

.lite-terminal-cursor {
  display: inline-block;
  width: 8px;
  height: 1.2em;
  vertical-align: text-bottom;
  background-color: var(--foreground);
  margin-left: 1px;
}

.lite-terminal-cursor.blink {
  animation: cursor-blink 1s step-end infinite;
}

@keyframes cursor-blink {
  0%, 50% { opacity: 1; }
  51%, 100% { opacity: 0; }
}

.lite-terminal-input {
  position: absolute;
  left: -9999px;
  top: 0;
  width: 1px;
  height: 1px;
  opacity: 0;
}

.lite-terminal.focused .lite-terminal-cursor {
  opacity: 1;
}

.lite-terminal:not(.focused) .lite-terminal-cursor {
  opacity: 0.4;
  animation: none;
}

/* Text styles */
.lite-terminal .bold { font-weight: bold; }
.lite-terminal .dim { opacity: 0.6; }
.lite-terminal .italic { font-style: italic; }
.lite-terminal .underline { text-decoration: underline; }

/* Colors */
.lite-terminal .black { color: #000; }
.lite-terminal .red { color: #e74c3c; }
.lite-terminal .green { color: #2ecc71; }
.lite-terminal .yellow { color: #f1c40f; }
.lite-terminal .blue { color: #3498db; }
.lite-terminal .magenta { color: #9b59b6; }
.lite-terminal .cyan { color: var(--term-cyan, #0AC5B3); }
.lite-terminal .white { color: #ecf0f1; }
.lite-terminal .brightBlack { color: var(--term-brightBlack, #666); }
.lite-terminal .brightRed { color: #ff6b6b; }
.lite-terminal .brightGreen { color: #69db7c; }
.lite-terminal .brightYellow { color: #ffd43b; }
.lite-terminal .brightBlue { color: #74c0fc; }
.lite-terminal .brightMagenta { color: #da77f2; }
.lite-terminal .brightCyan { color: var(--term-brightCyan, #3DD9C8); }
.lite-terminal .brightWhite { color: #fff; }

/* Links */
.lite-terminal a {
  color: inherit;
  text-decoration: underline;
}
.lite-terminal a:hover {
  opacity: 0.8;
}
`;

interface SessionTerminalProps {
  sessionId: Id<"sessions">;
  revisionId: Id<"revisions">;
  workspaceSlug?: string;
  className?: string;
}

export function SessionTerminal({ sessionId, revisionId, workspaceSlug, className }: SessionTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<LiteTerminal | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const [currentJobId, setCurrentJobId] = useState<Id<"jobs"> | null>(null);
  const inputBufferRef = useRef<string>("");
  const cwdRef = useRef<string>(""); // Current working directory relative to /sandbox (empty = /sandbox root)

  const runPlaygroundCode = useAction(api.playground.runPlaygroundCode);
  const createPlaygroundApprovalRequest = useMutation(api.playground.createPlaygroundApprovalRequest);
  const job = useQuery(api.playground.getJob, currentJobId ? { jobId: currentJobId } : "skip");
  const workspaceContext = useQuery(
    api.workspace.resolveWorkspaceContext,
    workspaceSlug ? { slug: workspaceSlug } : "skip",
  );

  const [approvalRequestId, setApprovalRequestId] = useState<Id<"approvalRequests"> | null>(null);
  const [approvalDialogOpen, setApprovalDialogOpen] = useState(false);
  const [isCreatingApprovalRequest, setIsCreatingApprovalRequest] = useState(false);
  const [credentialDialogOpen, setCredentialDialogOpen] = useState(false);
  const [credentialMissingPayload, setCredentialMissingPayload] = useState<CredentialMissingPayload | null>(null);
  const lastApprovalJobIdRef = useRef<string | null>(null);

  const approvalRequest = useQuery(
    api.approvals.getApprovalRequest,
    approvalRequestId ? { requestId: approvalRequestId } : "skip",
  );

  // Close the dialog once resolved (approved/denied) and let the user re-run.
  useEffect(() => {
    if (!approvalRequest || approvalRequest.status === "pending") return;
    setApprovalDialogOpen(false);
    if (approvalRequest.status === "approved") {
      toast.success("Approved. Re-run the command to continue.");
    }
    if (approvalRequest.status === "denied") {
      toast.error("Approval denied.");
    }
  }, [approvalRequest]);

  // Helper to get the display path for the prompt
  const getPromptPath = useCallback(() => {
    if (!cwdRef.current) return "/sandbox";
    return `/sandbox/${cwdRef.current}`;
  }, []);

  // Helper to write the prompt with current directory
  const writePrompt = useCallback((terminal: LiteTerminal) => {
    // Show abbreviated path in prompt (just the last component or ~ for root)
    const displayPath = cwdRef.current ? cwdRef.current.split("/").pop() : "~";
    terminal.write(`\x1b[36m${displayPath}\x1b[0m $ `);
  }, []);

  // Resolve a path relative to current working directory
  // Handles: absolute paths (/sandbox/...), relative paths, ".", "..", "~"
  const resolvePath = useCallback((inputPath: string): string => {
    const path = inputPath.trim();

    // Handle empty path or ~ -> go to root
    if (!path || path === "~" || path === "/sandbox") {
      return "";
    }

    // Handle absolute paths starting with /sandbox
    if (path.startsWith("/sandbox/")) {
      return path.slice("/sandbox/".length);
    }
    if (path.startsWith("/sandbox")) {
      return path.slice("/sandbox".length);
    }

    // Handle absolute paths starting with / (treat as /sandbox)
    if (path.startsWith("/")) {
      return path.slice(1);
    }

    // Handle relative paths
    const currentParts = cwdRef.current ? cwdRef.current.split("/").filter(Boolean) : [];
    const pathParts = path.split("/").filter(Boolean);

    for (const part of pathParts) {
      if (part === ".") {
        // Current directory - no change
        continue;
      }
      if (part === "..") {
        // Parent directory
        currentParts.pop();
      } else if (part === "~") {
        // Home directory - clear all
        currentParts.length = 0;
      } else {
        currentParts.push(part);
      }
    }

    return currentParts.join("/");
  }, []);

  // Initialize terminal
  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new LiteTerminal({
      cursorBlink: true,
      fontSize: 13,
      theme: {
        background: "transparent",
        foreground: "var(--foreground)",
        cursor: "var(--foreground)",
      },
    });

    terminal.open(containerRef.current);
    terminalRef.current = terminal;

    // Show welcome message and prompt
    terminal.writeln("\x1b[2m# Session Terminal - Run bash commands\x1b[0m");
    terminal.writeln("\x1b[2m# Working directory: /sandbox\x1b[0m");
    terminal.write("\n");
    writePrompt(terminal);

    // Handle input
    terminal.onData((data) => {
      if (isExecuting) {
        // Handle Ctrl+C during execution
        if (data === "\x03") {
          terminal.writeln("^C");
          setIsExecuting(false);
          setCurrentJobId(null);
          writePrompt(terminal);
        }
        return;
      }

      handleInput(data, terminal);
    });

    // Auto-focus the terminal
    terminal.focus();

    return () => {
      terminal.dispose();
      terminalRef.current = null;
    };
  }, []);

  // Handle input characters
  const handleInput = useCallback(
    (data: string, terminal: LiteTerminal) => {
      for (const char of data) {
        if (char === "\r") {
          // Enter pressed - execute command
          const command = inputBufferRef.current.trim();
          terminal.write("\n");

          if (command) {
            executeCommand(command, terminal);
          } else {
            writePrompt(terminal);
          }

          inputBufferRef.current = "";
        } else if (char === "\x7f" || char === "\x08") {
          // Backspace
          if (inputBufferRef.current.length > 0) {
            inputBufferRef.current = inputBufferRef.current.slice(0, -1);
            terminal.write("\b \b");
          }
        } else if (char === "\x03") {
          // Ctrl+C
          inputBufferRef.current = "";
          terminal.writeln("^C");
          writePrompt(terminal);
        } else if (char === "\x15") {
          // Ctrl+U - clear line
          const len = inputBufferRef.current.length;
          const displayPath = cwdRef.current ? cwdRef.current.split("/").pop() : "~";
          inputBufferRef.current = "";
          terminal.write(`\r\x1b[36m${displayPath}\x1b[0m $ ${" ".repeat(len)}\r\x1b[36m${displayPath}\x1b[0m $ `);
        } else if (char >= " " || char === "\t") {
          // Printable character
          inputBufferRef.current += char;
          terminal.write(char);
        }
      }
    },
    [isExecuting, writePrompt],
  );

  // Execute a command
  const executeCommand = useCallback(
    async (command: string, terminal: LiteTerminal) => {
      // Handle built-in commands
      if (command === "clear") {
        terminal.clear();
        writePrompt(terminal);
        return;
      }

      if (command === "help") {
        terminal.writeln("\x1b[1mAvailable commands:\x1b[0m");
        terminal.writeln("  clear    - Clear the terminal");
        terminal.writeln("  help     - Show this help message");
        terminal.writeln("  cd <dir> - Change directory");
        terminal.writeln("  pwd      - Print working directory");
        terminal.writeln("  <cmd>    - Run any bash command");
        terminal.writeln("");
        terminal.writeln("\x1b[2mFiles are stored in /sandbox\x1b[0m");
        terminal.write("\n");
        writePrompt(terminal);
        return;
      }

      // Handle cd command - validate directory exists then update local state
      const cdMatch = command.match(/^cd\s*(.*)$/);
      if (cdMatch) {
        const targetPath = cdMatch[1]?.trim() || "";
        const resolvedPath = resolvePath(targetPath);

        // If going to root, just update state
        if (!resolvedPath) {
          cwdRef.current = "";
          writePrompt(terminal);
          return;
        }

        // Validate the directory exists by running a test command
        // Note: resolvedPath is already absolute relative to /sandbox, so we run from root (no cwd)
        setIsExecuting(true);
        try {
          const result = await runPlaygroundCode({
            code: `test -d "${resolvedPath}" && echo "OK" || echo "NOTDIR"`,
            language: "bash",
            revisionId,
            sessionId,
            // Don't pass cwd - resolvedPath is already absolute relative to /sandbox
          });

          if (!result.success) {
            terminal.writeln(`\x1b[31mcd: ${result.error}\x1b[0m`);
            writePrompt(terminal);
            setIsExecuting(false);
            return;
          }

          if (result.jobId) {
            // Store the target path to update after job completes
            setCurrentJobId(result.jobId as Id<"jobs">);
            // Store pending cd target in a ref so we can update cwd when job completes
            (terminal as any)._pendingCdTarget = resolvedPath;
          }
        } catch (error) {
          terminal.writeln(`\x1b[31mcd: ${error instanceof Error ? error.message : "Unknown error"}\x1b[0m`);
          writePrompt(terminal);
          setIsExecuting(false);
        }
        return;
      }

      // Handle pwd command - show current directory
      if (command === "pwd") {
        terminal.writeln(getPromptPath());
        writePrompt(terminal);
        return;
      }

      setIsExecuting(true);

      try {
        const result = await runPlaygroundCode({
          code: command,
          language: "bash",
          revisionId,
          sessionId,
          cwd: cwdRef.current || undefined,
        });

        if (!result.success) {
          terminal.writeln(`\x1b[31mError: ${result.error}\x1b[0m`);
          writePrompt(terminal);
          setIsExecuting(false);
          return;
        }

        if (result.jobId) {
          setCurrentJobId(result.jobId as Id<"jobs">);
        }
      } catch (error) {
        terminal.writeln(`\x1b[31mError: ${error instanceof Error ? error.message : "Unknown error"}\x1b[0m`);
        writePrompt(terminal);
        setIsExecuting(false);
      }
    },
    [runPlaygroundCode, revisionId, sessionId, writePrompt, resolvePath, getPromptPath],
  );

  // Handle job completion
  useEffect(() => {
    if (!job || !terminalRef.current || !currentJobId) return;

    const terminal = terminalRef.current;

    if (job.job?.status === "completed") {
      // Check if this was a cd command validation
      const pendingCdTarget = (terminal as any)._pendingCdTarget;
      if (pendingCdTarget !== undefined) {
        delete (terminal as any)._pendingCdTarget;
        const output = job.job.output?.trim();
        if (output === "OK") {
          // Directory exists, update cwd
          cwdRef.current = pendingCdTarget;
        } else {
          // Directory doesn't exist
          terminal.writeln(`\x1b[31mcd: no such directory: ${pendingCdTarget}\x1b[0m`);
        }
        writePrompt(terminal);
        setIsExecuting(false);
        setCurrentJobId(null);
        return;
      }

      // Regular command output
      if (job.job.output) {
        terminal.write(job.job.output);
        if (!job.job.output.endsWith("\n")) {
          terminal.write("\n");
        }
      }
      writePrompt(terminal);
      setIsExecuting(false);
      setCurrentJobId(null);
    } else if (job.job?.status === "failed") {
      // Check if this was a cd command validation
      const pendingCdTarget = (terminal as any)._pendingCdTarget;
      if (pendingCdTarget !== undefined) {
        delete (terminal as any)._pendingCdTarget;
        terminal.writeln(`\x1b[31mcd: ${job.job.error?.message || "failed to change directory"}\x1b[0m`);
        writePrompt(terminal);
        setIsExecuting(false);
        setCurrentJobId(null);
        return;
      }

      const errorData = job.job.error?.data as Record<string, unknown> | undefined;
      const isApprovalRequired = errorData && (errorData as any).errorType === "APPROVAL_REQUIRED";
      const approval = isApprovalRequired ? (errorData as any).approval : null;
      const req = Array.isArray(approval) ? approval[0] : approval;
      const action = req && typeof req === "object" ? (req as any).action : null;
      const credentialMissing = parseCredentialMissingPayload(errorData);

      if (isApprovalRequired && typeof action === "string" && action) {
        terminal.writeln(`\x1b[33mApproval required: ${action}\x1b[0m`);
        terminal.writeln("\x1b[2mApprove in the dialog, then re-run the command.\x1b[0m");

        const jobId = job.job._id;
        if (lastApprovalJobIdRef.current !== jobId) {
          lastApprovalJobIdRef.current = jobId;
          setIsCreatingApprovalRequest(true);
          void createPlaygroundApprovalRequest({
            sessionId,
            jobId: jobId as Id<"jobs">,
            action,
            data: (req as any)?.data,
            info: (req as any)?.info,
            description: (req as any)?.description,
          })
            .then((requestId) => {
              setApprovalRequestId(requestId);
              setApprovalDialogOpen(true);
            })
            .catch((err) => {
              toast.error(err instanceof Error ? err.message : "Failed to create approval request");
            })
            .finally(() => {
              setIsCreatingApprovalRequest(false);
            });
        } else {
          setApprovalDialogOpen(true);
        }
      } else if (credentialMissing) {
        terminal.writeln(
          `\x1b[31mCredential unavailable: ${credentialMissing.credential.label ?? credentialMissing.credential.id} (${credentialMissing.credential.scope}/${credentialMissing.credential.kind})\x1b[0m`,
        );
        terminal.writeln(`\x1b[2mReason: ${credentialMissing.credential.reason}\x1b[0m`);
        terminal.writeln(`\x1b[2m${credentialMissingHint(credentialMissing, "re-run")}\x1b[0m`);
        if (job.job.error?.details) {
          terminal.writeln(`\x1b[2mDetails: ${job.job.error.details}\x1b[0m`);
        }
        setCredentialMissingPayload(credentialMissing);
        setCredentialDialogOpen(true);
      } else if (job.job.error?.message) {
        terminal.writeln(`\x1b[31m${job.job.error.message}\x1b[0m`);
      }
      writePrompt(terminal);
      setIsExecuting(false);
      setCurrentJobId(null);
    }
  }, [createPlaygroundApprovalRequest, job, currentJobId, sessionId, writePrompt]);

  return (
    <>
      <style>{terminalStyles}</style>
      <div className={`relative ${className ?? ""}`}>
        <div ref={containerRef} className="h-full w-full" />
        {isExecuting && (
          <div className="absolute bottom-2 right-2 flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2Icon className="size-3 animate-spin" />
            <span>Running...</span>
          </div>
        )}
        {approvalRequest?.status === "pending" && (
          <div className="absolute bottom-2 left-2">
            <button
              type="button"
              onClick={() => setApprovalDialogOpen(true)}
              className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-500 hover:bg-amber-500/15"
            >
              Approval required
            </button>
          </div>
        )}
      </div>

      <Dialog open={approvalDialogOpen} onOpenChange={setApprovalDialogOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Approval required</DialogTitle>
            <DialogDescription>
              Approve to attach this permission to the current session. Then re-run the command to continue.
            </DialogDescription>
          </DialogHeader>
          {approvalRequestId ? (
            approvalRequest ? (
              <ApprovalRequestCard request={approvalRequest} />
            ) : (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2Icon className="size-4 animate-spin" />
                Loading approval request...
              </div>
            )
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2Icon className="size-4 animate-spin" />
              {isCreatingApprovalRequest ? "Creating approval request..." : "Waiting for approval details..."}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <CredentialResolutionDialog
        open={credentialDialogOpen}
        onOpenChange={setCredentialDialogOpen}
        payload={credentialMissingPayload}
        sessionId={sessionId}
        revisionId={revisionId}
        workspaceId={workspaceContext?.workspace?._id ?? null}
        workspaceSlug={workspaceSlug}
      />
    </>
  );
}

// Empty state when no session is available
export function SessionTerminalEmpty() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center text-muted-foreground">
      <TerminalIcon className="size-8 mb-2 opacity-50" />
      <p className="text-sm">No active session</p>
      <p className="text-xs mt-1">Start a chat to create a session</p>
    </div>
  );
}
