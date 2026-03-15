import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CircleDotIcon,
  ClockIcon,
  FolderIcon,
  Loader2Icon,
  PlayIcon,
  RefreshCwIcon,
  StopCircleIcon,
  TerminalIcon,
  XCircleIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ApprovalRequestCard } from "@/components/chat/approval-request";
import { CredentialResolutionDialog } from "@/components/credentials/credential-resolution-dialog";
import { SandboxEditor } from "@/components/sandbox-editor";
import { SessionTerminal, SessionTerminalEmpty } from "@/components/session/index";
import { SessionFileExplorer } from "@/components/session/session-file-explorer";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { credentialMissingHint, parseCredentialMissingPayload } from "@/lib/credential-missing";
import {
  executorUnavailableHint,
  executorUnavailableTitle,
  parseExecutorUnavailablePayload,
} from "@/lib/executor-unavailable";
import { cn } from "@/lib/utils";

type PlaygroundSearchParams = {
  code?: string;
  language?: "typescript" | "bash";
  sessionId?: string;
};

export const Route = createFileRoute("/_app/workspace/$slug/_app/playground")({
  component: WorkspacePlaygroundPage,
  validateSearch: (search: Record<string, unknown>): PlaygroundSearchParams => {
    return {
      code: typeof search.code === "string" ? search.code : undefined,
      language: search.language === "typescript" || search.language === "bash" ? search.language : undefined,
      sessionId: typeof search.sessionId === "string" ? search.sessionId : undefined,
    };
  },
});

type Language = "typescript" | "bash";

const DEFAULT_CODE: Record<Language, string> = {
  typescript: `console.log("Hello!");`,
  bash: `echo "Hello!"`,
};

// localStorage keys
const STORAGE_KEY_CODE = (slug: string, lang: Language) => `playground:code:${slug}:${lang}`;
const STORAGE_KEY_RECENT = (slug: string) => `playground:recent:${slug}`;
const MAX_RECENT_SNIPPETS = 10;

type RecentSnippet = {
  code: string;
  language: Language;
  timestamp: number;
  label?: string;
};

// Timeout options in milliseconds
const TIMEOUT_OPTIONS = [
  { value: "30000", label: "30 seconds" },
  { value: "60000", label: "1 minute" },
  { value: "300000", label: "5 minutes" },
  { value: "900000", label: "15 minutes" },
  { value: "1800000", label: "30 minutes" },
  { value: "3600000", label: "60 minutes" },
] as const;

const DEFAULT_TIMEOUT_MS = 300000; // 5 minutes

function WorkspacePlaygroundPage() {
  const { slug } = Route.useParams();
  const searchParams = Route.useSearch();
  const navigate = useNavigate();

  // Resolve workspace context from backend
  const workspaceContext = useQuery(api.workspace.resolveWorkspaceContext, { slug });
  const explicitRevisionId = (workspaceContext?.revisionId as Id<"revisions"> | undefined) ?? null;

  // Get or create revision for current branch
  const ensureRevision = useAction(api.playground.ensureRevision);
  const [revisionId, setRevisionId] = useState<Id<"revisions"> | null>(null);
  const [compileJobId, setCompileJobId] = useState<Id<"compileJobs"> | null>(null);
  const [revisionLoading, setRevisionLoading] = useState(false);
  const [revisionError, setRevisionError] = useState<string | null>(null);
  const compileJob = useQuery(
    api.compile.getCompileJob,
    workspaceContext?.workspace && compileJobId
      ? { workspaceId: workspaceContext.workspace._id, compileJobId }
      : "skip",
  );

  // Language selection - prefer URL param, then localStorage
  const [language, setLanguage] = useState<Language>(() => {
    if (searchParams.language) return searchParams.language;
    if (typeof window === "undefined") return "typescript";
    const savedTs = localStorage.getItem(STORAGE_KEY_CODE(slug, "typescript"));
    const savedBash = localStorage.getItem(STORAGE_KEY_CODE(slug, "bash"));
    // Default to typescript, but if only bash code exists, use that
    if (!savedTs && savedBash) return "bash";
    return "typescript";
  });

  // Session management - initialize from URL if provided
  // Track if sessionId was initialized from URL param (to prevent branch change from resetting it)
  const sessionFromUrlRef = useRef(!!searchParams.sessionId);
  const lastBranchIdRef = useRef<Id<"branches"> | null>(null);
  const previousExplicitRevisionIdRef = useRef<Id<"revisions"> | null | undefined>(undefined);
  const ensureRevisionRequestRef = useRef(0);
  const [sessionId, setSessionId] = useState<Id<"sessions"> | null>(
    searchParams.sessionId ? (searchParams.sessionId as Id<"sessions">) : null,
  );
  const createSession = useMutation(api.playground.createPlaygroundSession);
  const resetSession = useMutation(api.playground.resetPlaygroundSession);
  const requestStopJob = useMutation(api.executor.requestStopJob);

  // Job timeout configuration
  const [timeoutMs, setTimeoutMs] = useState<number>(DEFAULT_TIMEOUT_MS);

  // Sync sessionId to URL when it changes
  useEffect(() => {
    if (sessionId && sessionId !== searchParams.sessionId) {
      navigate({
        to: ".",
        search: (prev) => ({ ...prev, sessionId }),
        replace: true,
      });
    }
  }, [sessionId, searchParams.sessionId, navigate]);

  // Track if code was initialized from URL param (to prevent localStorage from overwriting it)
  const codeFromUrlRef = useRef(!!searchParams.code);

  // Code execution state - prefer URL param, then localStorage
  const [code, setCode] = useState(() => {
    // URL param takes precedence
    if (searchParams.code) return searchParams.code;
    if (typeof window === "undefined") return DEFAULT_CODE.typescript;
    const saved = localStorage.getItem(STORAGE_KEY_CODE(slug, language));
    return saved ?? DEFAULT_CODE[language];
  });
  const [jobId, setJobId] = useState<Id<"jobs"> | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [compilationError, setCompilationError] = useState<string | null>(null);

  // Type definitions state (loaded via action since large files are stored in blobs)
  const [typeDefinitions, setTypeDefinitions] = useState<{ fileName: string; content: string }[] | null>(null);
  const [typeDefinitionsLoading, setTypeDefinitionsLoading] = useState(false);
  const typeDefinitionsRequestRef = useRef(0);
  const lastRevisionIdForTypeDefsRef = useRef<Id<"revisions"> | null>(null);
  const getTypeDefinitions = useAction(api.playground.getTypeDefinitionsForRevision);

  // Recent snippets
  const [recentSnippets, setRecentSnippets] = useState<RecentSnippet[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const saved = localStorage.getItem(STORAGE_KEY_RECENT(slug));
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  // Session panel tab state
  type SessionPanelTab = "files" | "terminal";
  const [sessionPanelTab, setSessionPanelTab] = useState<SessionPanelTab>("files");

  // Fetch session info for terminal (needs revisionId)
  const sessionInfo = useQuery(api.sessions.getSessionInfo, sessionId ? { sessionId } : "skip");

  const runPlaygroundCode = useAction(api.playground.runPlaygroundCode);
  const job = useQuery(api.playground.getJob, jobId ? { jobId } : "skip");

  // Fetch examples from workspace CAPABILITY.md files
  const workspaceExamples = useQuery(api.playground.getExamplesForRevision, revisionId ? { revisionId } : "skip");

  // List revisions for the current branch
  const revisions = useQuery(
    api.playground.listRevisions,
    workspaceContext?.branch ? { branchId: workspaceContext.branch._id, limit: 20 } : "skip",
  );

  useEffect(() => {
    const previousExplicitRevisionId = previousExplicitRevisionIdRef.current;
    previousExplicitRevisionIdRef.current = explicitRevisionId;

    if (previousExplicitRevisionId !== undefined && previousExplicitRevisionId !== explicitRevisionId) {
      sessionFromUrlRef.current = false;
      setSessionId(null);
    }

    if (!explicitRevisionId) {
      if (!previousExplicitRevisionId) {
        return;
      }
      ensureRevisionRequestRef.current += 1;
      setRevisionId(null);
      setCompileJobId(null);
      setRevisionLoading(false);
      setRevisionError(null);
      return;
    }
    setRevisionId(explicitRevisionId);
    setCompileJobId(null);
    setRevisionLoading(false);
    setRevisionError(null);
  }, [explicitRevisionId]);

  // Load type definitions when revision changes (only for TypeScript)
  useEffect(() => {
    if (!revisionId || language !== "typescript" || typeDefinitions || typeDefinitionsLoading) {
      return;
    }

    const requestId = ++typeDefinitionsRequestRef.current;
    setTypeDefinitionsLoading(true);

    const timeoutId = setTimeout(() => {
      if (typeDefinitionsRequestRef.current !== requestId) {
        return;
      }
      setTypeDefinitions([]);
      setTypeDefinitionsLoading(false);
      toast.error("Loading type definitions timed out. Continuing without workspace types.");
    }, 15000);

    getTypeDefinitions({ revisionId })
      .then((result) => {
        if (typeDefinitionsRequestRef.current !== requestId) {
          return;
        }
        setTypeDefinitions(result);
      })
      .catch((err) => {
        if (typeDefinitionsRequestRef.current !== requestId) {
          return;
        }
        console.error("Failed to load type definitions:", err);
        setTypeDefinitions([]);
      })
      .finally(() => {
        if (typeDefinitionsRequestRef.current !== requestId) {
          return;
        }
        clearTimeout(timeoutId);
        setTypeDefinitionsLoading(false);
      });

    return () => {
      clearTimeout(timeoutId);
    };
  }, [revisionId, language, typeDefinitions, typeDefinitionsLoading, getTypeDefinitions]);

  // Reset type definitions when revision changes
  useEffect(() => {
    const previousRevisionId = lastRevisionIdForTypeDefsRef.current;
    if (previousRevisionId === revisionId) {
      return;
    }

    // Important: do not invalidate on initial null -> revision transition.
    // That transition is exactly when we start the first type-definition request.
    if (previousRevisionId && revisionId === null) {
      typeDefinitionsRequestRef.current += 1;
      setTypeDefinitions(null);
      setTypeDefinitionsLoading(false);
    } else if (previousRevisionId && revisionId && previousRevisionId !== revisionId) {
      typeDefinitionsRequestRef.current += 1;
      setTypeDefinitions(null);
      setTypeDefinitionsLoading(false);
    }

    lastRevisionIdForTypeDefsRef.current = revisionId;
  }, [revisionId]);

  // Clear code URL param after loading (so it doesn't persist on refresh), but preserve sessionId
  useEffect(() => {
    if (searchParams.code) {
      // Use replace to avoid adding to history
      navigate({
        to: ".",
        search: (prev) => ({ sessionId: prev.sessionId }),
        replace: true,
      });
    }
  }, []); // Only run once on mount

  // Save code to localStorage when it changes (debounced)
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (typeof window !== "undefined" && code.trim()) {
        localStorage.setItem(STORAGE_KEY_CODE(slug, language), code);
      }
    }, 500);
    return () => clearTimeout(timeoutId);
  }, [code, slug, language]);

  // Load code when language changes (but not if code was initialized from URL param)
  useEffect(() => {
    // Skip if code was initialized from URL param (only on first render)
    if (codeFromUrlRef.current) {
      codeFromUrlRef.current = false;
      return;
    }
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem(STORAGE_KEY_CODE(slug, language));
      if (saved) {
        setCode(saved);
      } else {
        setCode(DEFAULT_CODE[language]);
      }
    }
  }, [language, slug]);

  // Save recent snippet after successful run
  const saveRecentSnippet = useCallback(
    (snippetCode: string, snippetLanguage: Language) => {
      if (typeof window === "undefined") return;

      const newSnippet: RecentSnippet = {
        code: snippetCode,
        language: snippetLanguage,
        timestamp: Date.now(),
        label: snippetCode.split("\n")[0].slice(0, 50), // First line as label
      };

      setRecentSnippets((prev) => {
        // Remove duplicates and add new snippet at the beginning
        const filtered = prev.filter((s) => s.code !== snippetCode);
        const updated = [newSnippet, ...filtered].slice(0, MAX_RECENT_SNIPPETS);
        localStorage.setItem(STORAGE_KEY_RECENT(slug), JSON.stringify(updated));
        return updated;
      });
    },
    [slug],
  );

  // Ensure we have a revision when branch changes
  useEffect(() => {
    if (
      workspaceContext?.workspace &&
      workspaceContext?.branch &&
      !explicitRevisionId &&
      !revisionId &&
      !revisionLoading &&
      !revisionError &&
      !compileJobId
    ) {
      const requestId = ++ensureRevisionRequestRef.current;
      setRevisionLoading(true);
      setRevisionError(null);
      ensureRevision({
        workspaceId: workspaceContext.workspace._id,
        branchId: workspaceContext.branch._id,
      })
        .then((result) => {
          if (ensureRevisionRequestRef.current !== requestId) {
            return;
          }
          if (result.existingRevisionId) {
            setRevisionId(result.existingRevisionId);
            setRevisionLoading(false);
            return;
          }
          if (result.compileJobId) {
            setCompileJobId(result.compileJobId);
            return;
          }
          throw new Error("Compile job was not created");
        })
        .catch((err) => {
          if (ensureRevisionRequestRef.current !== requestId) {
            return;
          }
          setRevisionError(err instanceof Error ? err.message : "Failed to load revision");
          setRevisionLoading(false);
        });
      return;
    }
  }, [
    explicitRevisionId,
    workspaceContext?.workspace?._id,
    workspaceContext?.branch?._id,
    revisionId,
    revisionLoading,
    revisionError,
    compileJobId,
    ensureRevision,
  ]);

  useEffect(() => {
    if (!compileJob) {
      return;
    }
    if (compileJob.status === "pending" || compileJob.status === "running") {
      setRevisionLoading(true);
      return;
    }
    if (compileJob.status === "completed") {
      if (!compileJob.revisionId) {
        setRevisionError("Compile job completed without revision");
      } else {
        setRevisionId(compileJob.revisionId);
      }
      setRevisionLoading(false);
      setCompileJobId(null);
      return;
    }
    if (compileJob.status === "failed" || compileJob.status === "canceled") {
      setRevisionError(compileJob.error ?? "Failed to load revision");
      setRevisionLoading(false);
      setCompileJobId(null);
    }
  }, [compileJob]);

  // Reset revision and session when branch actually changes (skip initial branch hydration)
  useEffect(() => {
    if (explicitRevisionId) {
      return;
    }
    const currentBranchId = workspaceContext?.branch?._id ?? null;
    if (!currentBranchId) {
      return;
    }
    if (!lastBranchIdRef.current) {
      lastBranchIdRef.current = currentBranchId;
      return;
    }
    if (lastBranchIdRef.current === currentBranchId) {
      return;
    }
    lastBranchIdRef.current = currentBranchId;
    ensureRevisionRequestRef.current += 1;
    // Skip resetting sessionId if it was initialized from URL param (only on first render)
    if (sessionFromUrlRef.current) {
      sessionFromUrlRef.current = false;
      // Still reset revision-related state
      setRevisionId(null);
      setCompileJobId(null);
      setRevisionLoading(false);
      setRevisionError(null);
      return;
    }
    setRevisionId(null);
    setCompileJobId(null);
    setRevisionLoading(false);
    setRevisionError(null);
    setSessionId(null);
  }, [explicitRevisionId, workspaceContext?.branch?._id]);

  const handleRun = useCallback(async () => {
    setIsRunning(true);
    setCompilationError(null);
    setJobId(null);

    try {
      if (!revisionId) {
        throw new Error("revisionId not set");
      }

      // Create session on first run if not exists (only for TypeScript)
      let currentSessionId = sessionId;
      if (!currentSessionId) {
        currentSessionId = await createSession({ revisionId });
        setSessionId(currentSessionId);
      }

      if (!currentSessionId) {
        toast.error("No session found");
        return;
      }

      const result = await runPlaygroundCode({
        code,
        language,
        revisionId,
        sessionId: currentSessionId ?? undefined,
        timeoutMs,
      });
      if (result.success && result.jobId) {
        setJobId(result.jobId as Id<"jobs">);
        // Save to recent snippets on successful submission
        saveRecentSnippet(code, language);
      } else {
        setCompilationError(result.error ?? "Unknown error occurred");
      }
    } catch (error) {
      setCompilationError(error instanceof Error ? error.message : "Unknown error occurred");
    } finally {
      setIsRunning(false);
    }
  }, [code, language, runPlaygroundCode, revisionId, sessionId, createSession, saveRecentSnippet, timeoutMs]);

  const handleResetSession = useCallback(async () => {
    if (sessionId) {
      await resetSession({ sessionId });
    }
  }, [sessionId, resetSession]);

  // Stop a running job
  const handleStopJob = useCallback(async () => {
    if (jobId) {
      try {
        await requestStopJob({ jobId, reason: "Stopped by user" });
        toast.success("Stop requested");
      } catch {
        toast.error("Failed to stop job");
      }
    }
  }, [jobId, requestStopJob]);

  // Load a recent snippet
  const handleLoadRecent = useCallback((snippet: RecentSnippet) => {
    setLanguage(snippet.language);
    setCode(snippet.code);
  }, []);

  // Load a workspace example
  const handleLoadExample = useCallback((example: { code: string }) => {
    setLanguage("typescript"); // Examples are always TypeScript
    setCode(example.code);
  }, []);

  // Can run check - TypeScript needs type definitions, Bash just needs revision
  const canRun = language === "bash" ? !!revisionId : !!typeDefinitions;

  const runFromShortcut = useCallback(() => {
    if (!isRunning && code.trim() && canRun) {
      void handleRun();
    }
  }, [isRunning, code, canRun, handleRun]);

  // Keyboard shortcut: Cmd+Enter to run code
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        const target = e.target as HTMLElement | null;
        if (target?.closest(".monaco-editor")) {
          // Monaco-specific shortcut handles this while editor is focused.
          return;
        }
        e.preventDefault();
        runFromShortcut();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [runFromShortcut]);

  const handleEditorChange = useCallback((value: string | undefined) => {
    if (value !== undefined) {
      setCode(value);
    }
  }, []);

  // Loading states
  if (!workspaceContext) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2Icon className="size-5 animate-spin" />
          <span>Loading tokenspace...</span>
        </div>
      </div>
    );
  }

  const selectedRevision = revisions?.find((r) => r._id === revisionId);

  // Check if job can be stopped (pending or running)
  const canStopJob = jobId && job?.job && (job.job.status === "pending" || job.job.status === "running");

  return (
    <div className="flex flex-1 flex-col bg-background">
      {/* Playground toolbar */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/40 px-4">
        <div className="flex items-center gap-4">
          {/* Language selector */}
          <div className="flex items-center gap-1 rounded-lg border border-border/60 bg-secondary/30 p-0.5">
            <button
              type="button"
              onClick={() => setLanguage("typescript")}
              className={cn(
                "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                language === "typescript"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              TypeScript
            </button>
            <button
              type="button"
              onClick={() => setLanguage("bash")}
              className={cn(
                "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                language === "bash"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Bash
            </button>
          </div>

          {/* Recent snippets dropdown */}
          {recentSnippets.length > 0 && (
            <div className="relative group">
              <button
                type="button"
                className="flex items-center gap-1.5 rounded-md border border-border/60 bg-secondary/30 px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                Recent ({recentSnippets.length})
              </button>
              <div className="absolute left-0 top-full z-50 mt-1 hidden w-64 rounded-lg border border-border/60 bg-background p-1 shadow-lg group-hover:block">
                {recentSnippets.map((snippet, index) => (
                  <button
                    key={`${snippet.timestamp}-${index}`}
                    type="button"
                    onClick={() => handleLoadRecent(snippet)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-secondary"
                  >
                    <span
                      className={cn(
                        "shrink-0 rounded px-1 py-0.5 text-[10px] font-medium",
                        snippet.language === "typescript"
                          ? "bg-blue-500/20 text-blue-400"
                          : "bg-green-500/20 text-green-400",
                      )}
                    >
                      {snippet.language === "typescript" ? "TS" : "SH"}
                    </span>
                    <span className="truncate text-muted-foreground">{snippet.label || "Untitled"}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Workspace examples dropdown */}
          {workspaceExamples && workspaceExamples.length > 0 && (
            <div className="relative group">
              <button
                type="button"
                className="flex items-center gap-1.5 rounded-md border border-border/60 bg-secondary/30 px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                Examples ({workspaceExamples.length})
              </button>
              <div className="absolute left-0 top-full z-50 mt-1 hidden max-h-80 w-72 overflow-y-auto rounded-lg border border-border/60 bg-background p-1 shadow-lg group-hover:block">
                {workspaceExamples.map((example, index) => (
                  <button
                    key={`${example.capabilityName}-${index}`}
                    type="button"
                    onClick={() => handleLoadExample(example)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-secondary"
                  >
                    <span className="shrink-0 rounded bg-purple-500/20 px-1 py-0.5 text-[10px] font-medium text-purple-400">
                      {example.capabilityName}
                    </span>
                    <span className="truncate text-muted-foreground">{example.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Revision indicator */}
          {revisionLoading ? (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2Icon className="size-3 animate-spin" />
              <span>{compileJobId ? "Building revision..." : "Loading revision..."}</span>
            </div>
          ) : revisionError ? (
            <div className="flex items-center gap-1.5 text-xs text-destructive">
              <AlertCircleIcon className="size-3" />
              <span>{revisionError}</span>
            </div>
          ) : selectedRevision ? (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CheckCircle2Icon className="size-3 text-emerald-500" />
              <span className="font-mono">rev:{selectedRevision._id.slice(-6)}</span>
            </div>
          ) : null}

          {/* Session indicator (TypeScript only) */}
          {language === "typescript" && sessionId && (
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <CircleDotIcon className="size-3 text-cyan-500" />
                <span className="font-mono">session:{sessionId.slice(-6)}</span>
              </div>
              <button
                type="button"
                onClick={handleResetSession}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
                title="Reset session (clear filesystem changes)"
              >
                <RefreshCwIcon className="size-3" />
                Reset
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Timeout selector */}
          <Select value={timeoutMs.toString()} onValueChange={(value) => setTimeoutMs(Number(value))}>
            <SelectTrigger size="sm" className="w-[130px] text-xs">
              <ClockIcon className="size-3 mr-1" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIMEOUT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Stop button */}
          {canStopJob && (
            <Button
              onClick={handleStopJob}
              variant="outline"
              size="sm"
              className="gap-1.5 text-orange-500 border-orange-500/30 hover:bg-orange-500/10 hover:text-orange-400"
            >
              <StopCircleIcon className="size-4" />
              Stop
            </Button>
          )}

          {/* Run button */}
          <Button
            onClick={handleRun}
            disabled={isRunning || !code.trim() || !canRun}
            className="gap-2 rounded-xl bg-linear-to-r from-emerald-500 to-cyan-500 text-white transition-all hover:from-emerald-600 hover:to-cyan-600 disabled:opacity-50"
          >
            {isRunning ? <Loader2Icon className="size-4 animate-spin" /> : <PlayIcon className="size-4" />}
            Run
          </Button>
        </div>
      </div>

      {/* Main content area - resizable panels */}
      <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0">
        {/* Editor Panel */}
        <ResizablePanel defaultSize={50} minSize={25} className="min-w-0">
          <div className="flex h-full flex-col">
            <div className="flex h-10 shrink-0 items-center border-b border-border/40 bg-secondary/30 px-4">
              <span className="text-sm font-medium text-muted-foreground">
                {language === "bash" ? "script.sh" : "main.ts"}
              </span>
            </div>
            <div className="flex-1 overflow-hidden">
              {language === "typescript" && !typeDefinitions ? (
                <div className="flex h-full items-center justify-center text-muted-foreground">
                  {typeDefinitionsLoading ? (
                    <>
                      <Loader2Icon className="size-5 animate-spin mr-2" />
                      Loading type definitions...
                    </>
                  ) : (
                    <>
                      <ClockIcon className="size-5 mr-2" />
                      Preparing type definitions...
                    </>
                  )}
                </div>
              ) : (
                <SandboxEditor
                  height="100%"
                  width="100%"
                  value={code}
                  onChange={handleEditorChange}
                  language={language}
                  typeDefinitions={typeDefinitions ?? []}
                  onRunShortcut={runFromShortcut}
                />
              )}
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandle />

        {/* Right Panel - Output + Session */}
        <ResizablePanel defaultSize={50} minSize={25} className="min-w-0">
          <ResizablePanelGroup orientation="vertical" className="h-full">
            {/* Output Panel */}
            <ResizablePanel defaultSize={50} minSize={20} className="min-h-0">
              <div className="flex h-full flex-col">
                <div className="flex h-10 shrink-0 items-center border-b border-border/40 bg-secondary/30 px-4">
                  <span className="text-sm font-medium text-muted-foreground">Output</span>
                </div>
                <div className="flex-1 overflow-auto p-4">
                  <OutputPanel
                    job={job}
                    isRunning={isRunning}
                    compilationError={compilationError}
                    sessionId={sessionId}
                    workspaceId={workspaceContext?.workspace?._id ?? null}
                    workspaceSlug={slug}
                    revisionId={revisionId}
                  />
                </div>
              </div>
            </ResizablePanel>

            <ResizableHandle />

            {/* Session Panel - Files/Terminal */}
            <ResizablePanel defaultSize={50} minSize={20} className="min-h-0">
              <div className="flex h-full flex-col">
                {/* Session Tab Bar */}
                <div className="flex shrink-0 border-b border-border/40">
                  <button
                    type="button"
                    onClick={() => setSessionPanelTab("files")}
                    className={cn(
                      "flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors",
                      sessionPanelTab === "files"
                        ? "text-foreground border-b-2 border-primary bg-muted/30"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted/20",
                    )}
                  >
                    <FolderIcon className="size-3.5" />
                    Files
                  </button>
                  <button
                    type="button"
                    onClick={() => setSessionPanelTab("terminal")}
                    className={cn(
                      "flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors",
                      sessionPanelTab === "terminal"
                        ? "text-foreground border-b-2 border-primary bg-muted/30"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted/20",
                    )}
                  >
                    <TerminalIcon className="size-3.5" />
                    Terminal
                  </button>
                </div>

                {/* Session Content */}
                <div className="flex-1 min-h-0 overflow-hidden">
                  {sessionPanelTab === "files" ? (
                    sessionId ? (
                      <SessionFileExplorer sessionId={sessionId} className="h-full" />
                    ) : (
                      <div className="flex h-full flex-col items-center justify-center text-center text-muted-foreground">
                        <FolderIcon className="size-8 mb-2 opacity-50" />
                        <p className="text-sm">Run code to create a session</p>
                      </div>
                    )
                  ) : sessionId && sessionInfo?.revisionId ? (
                    <SessionTerminal
                      sessionId={sessionId}
                      revisionId={sessionInfo.revisionId}
                      workspaceSlug={slug}
                      className="h-full"
                    />
                  ) : (
                    <SessionTerminalEmpty />
                  )}
                </div>
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

type JobResult = {
  success: boolean;
  error?: string;
  job?: {
    _id: string;
    code: string;
    language: string;
    threadId?: string;
    toolCallId?: string;
    status: string;
    output?: string;
    error?: {
      message: string;
      stack?: string;
      details?: string;
      data?: Record<string, unknown>;
    };
    // Timing details
    startedAt?: number;
    completedAt?: number;
    timeoutMs?: number;
    // Stop/cancel details
    stopRequestedAt?: number;
    stopReason?: string;
    // Worker details
    workerId?: string;
  };
};

function OutputPanel({
  job,
  isRunning,
  compilationError,
  sessionId,
  workspaceId,
  workspaceSlug,
  revisionId,
}: {
  job: JobResult | undefined;
  isRunning: boolean;
  compilationError: string | null;
  sessionId: Id<"sessions"> | null;
  workspaceId: Id<"workspaces"> | null;
  workspaceSlug: string;
  revisionId: Id<"revisions"> | null;
}) {
  const jobDoc = job?.job;
  const jobId = jobDoc?._id;
  const error = jobDoc?.error;

  const approvalRequirement = useMemo(() => {
    if (!error?.data || (error.data as any).errorType !== "APPROVAL_REQUIRED") return null;
    const approval = (error.data as any).approval;
    const req = Array.isArray(approval) ? approval[0] : approval;
    if (!req || typeof req !== "object") return null;
    const action = (req as any).action;
    if (typeof action !== "string" || !action) return null;
    return {
      action,
      data: (req as any).data as Record<string, unknown> | undefined,
      info: (req as any).info as Record<string, unknown> | undefined,
      description: (req as any).description as string | undefined,
    };
  }, [error?.data]);
  const credentialMissing = useMemo(() => parseCredentialMissingPayload(error?.data), [error?.data]);
  const executorUnavailable = useMemo(() => parseExecutorUnavailablePayload(error?.data), [error?.data]);

  const isApprovalRequired = Boolean(jobDoc?.status === "failed" && approvalRequirement);
  const isCredentialMissing = Boolean(jobDoc?.status === "failed" && credentialMissing);
  const isExecutorUnavailable = Boolean(jobDoc?.status === "failed" && executorUnavailable);
  const [credentialDialogOpen, setCredentialDialogOpen] = useState(false);

  const createPlaygroundApprovalRequest = useMutation(api.playground.createPlaygroundApprovalRequest);
  const [approvalRequestId, setApprovalRequestId] = useState<Id<"approvalRequests"> | null>(null);
  const [approvalDialogOpen, setApprovalDialogOpen] = useState(false);
  const [isCreatingApprovalRequest, setIsCreatingApprovalRequest] = useState(false);
  const lastApprovalJobIdRef = useRef<string | null>(null);

  const approvalRequest = useQuery(
    api.approvals.getApprovalRequest,
    approvalRequestId ? { requestId: approvalRequestId } : "skip",
  );

  useEffect(() => {
    if (!isApprovalRequired || !approvalRequirement || !sessionId || !jobId) return;
    if (lastApprovalJobIdRef.current === jobId) {
      setApprovalDialogOpen(true);
      return;
    }
    lastApprovalJobIdRef.current = jobId;
    setIsCreatingApprovalRequest(true);
    void createPlaygroundApprovalRequest({
      sessionId,
      jobId: jobId as Id<"jobs">,
      action: approvalRequirement.action,
      data: approvalRequirement.data,
      info: approvalRequirement.info,
      description: approvalRequirement.description,
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
  }, [approvalRequirement, createPlaygroundApprovalRequest, isApprovalRequired, jobId, sessionId]);

  const lastApprovalStatusRef = useRef<"pending" | "approved" | "denied" | null>(null);
  useEffect(() => {
    if (!approvalRequest) return;
    if (approvalRequest.status === lastApprovalStatusRef.current) return;
    lastApprovalStatusRef.current = approvalRequest.status;

    if (approvalRequest.status === "approved") {
      toast.success("Approved. Click Run again to continue.");
      setApprovalDialogOpen(false);
    }
    if (approvalRequest.status === "denied") {
      toast.error("Approval denied.");
      setApprovalDialogOpen(false);
    }
  }, [approvalRequest]);

  // Initial state
  if (!job && !isRunning && !compilationError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <TerminalIcon className="size-8 opacity-50" />
        <p className="text-sm">Run your code to see output here</p>
      </div>
    );
  }

  // Compilation error
  if (compilationError) {
    return (
      <div className="space-y-3">
        <StatusBadge status="error" label="Compilation Error" />
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-4">
          <pre className="whitespace-pre-wrap font-mono text-sm text-red-400">{compilationError}</pre>
        </div>
      </div>
    );
  }

  // Running state
  if (isRunning || !job?.job) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Loader2Icon className="size-8 animate-spin text-emerald-500" />
        <p className="text-sm">Compiling...</p>
      </div>
    );
  }

  const { status, output } = job.job;
  const badgeStatus = isApprovalRequired
    ? "approval"
    : (status as "pending" | "running" | "completed" | "failed" | "canceled");
  const badgeLabel = isApprovalRequired
    ? "Approval Required"
    : isCredentialMissing
      ? "Credential Missing"
      : isExecutorUnavailable
        ? "Executor Unavailable"
        : status.charAt(0).toUpperCase() + status.slice(1);

  return (
    <div className="space-y-3">
      <StatusBadge status={badgeStatus} label={badgeLabel} />

      {/* Pending/Running state */}
      {(status === "pending" || status === "running") && (
        <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-secondary/30 p-4">
          <Loader2Icon className="size-4 animate-spin text-cyan-500" />
          <span className="text-sm text-muted-foreground">
            {status === "pending" ? "Waiting for execution..." : "Executing..."}
          </span>
        </div>
      )}

      {/* Success output */}
      {status === "completed" && output && (
        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4">
          <pre className="whitespace-pre-wrap font-mono text-sm text-foreground">{output}</pre>
        </div>
      )}

      {/* No output */}
      {status === "completed" && !output && (
        <div className="rounded-lg border border-border/60 bg-secondary/30 p-4">
          <span className="text-sm text-muted-foreground italic">No output</span>
        </div>
      )}

      {/* Canceled state */}
      {status === "canceled" && (
        <div className="space-y-2">
          <div className="rounded-lg border border-orange-500/20 bg-orange-500/10 p-4">
            <div className="flex items-center gap-2">
              <XCircleIcon className="size-4 text-orange-400" />
              <span className="text-sm text-orange-400">{job.job.stopReason || "Job was canceled"}</span>
            </div>
          </div>
          {output && (
            <div className="rounded-lg border border-border/60 bg-secondary/30 p-4">
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Partial Output</p>
              <pre className="whitespace-pre-wrap font-mono text-sm text-foreground">{output}</pre>
            </div>
          )}
        </div>
      )}

      {/* Approval required */}
      {status === "failed" && approvalRequirement && (
        <div className="space-y-2">
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-amber-500">This run requires approval</p>
                <p className="mt-1 text-xs font-mono text-muted-foreground">{approvalRequirement.action}</p>
                {approvalRequirement.description && (
                  <p className="mt-2 text-sm text-foreground/80 italic">{approvalRequirement.description}</p>
                )}
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setApprovalDialogOpen(true)}
                disabled={isCreatingApprovalRequest || approvalRequestId == null}
              >
                {isCreatingApprovalRequest ? <Loader2Icon className="size-4 animate-spin" /> : "Review"}
              </Button>
            </div>

            {(approvalRequirement.data || approvalRequirement.info) && (
              <details className="mt-3 group">
                <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                  Show details
                </summary>
                <div className="mt-2 rounded-md border border-border/60 bg-secondary/30 p-3">
                  <pre className="whitespace-pre-wrap font-mono text-xs text-foreground">
                    {JSON.stringify({ data: approvalRequirement.data, info: approvalRequirement.info }, null, 2)}
                  </pre>
                </div>
              </details>
            )}

            <p className="mt-3 text-xs text-muted-foreground">
              Approving attaches permission to this session. Click Run again after approving.
            </p>
          </div>
        </div>
      )}

      {/* Credential missing */}
      {status === "failed" && credentialMissing && !approvalRequirement && (
        <div className="space-y-2">
          <div className="rounded-lg border border-orange-500/20 bg-orange-500/10 p-4">
            <div className="flex items-center gap-2">
              <AlertCircleIcon className="size-4 text-orange-400" />
              <p className="text-sm font-medium text-orange-400">Credential unavailable</p>
            </div>
            <p className="mt-2 text-sm text-foreground">
              {credentialMissing.credential.label ?? credentialMissing.credential.id} (
              {credentialMissing.credential.scope}/{credentialMissing.credential.kind})
            </p>
            <p className="mt-1 text-xs text-muted-foreground">Reason: {credentialMissing.credential.reason}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              {credentialMissingHint(credentialMissing, "click Run again")}
            </p>
            {error?.details && <p className="mt-2 text-xs text-muted-foreground">Details: {error.details}</p>}
            <Button size="sm" variant="outline" className="mt-3" onClick={() => setCredentialDialogOpen(true)}>
              Resolve
            </Button>
          </div>
        </div>
      )}

      {status === "failed" && executorUnavailable && !approvalRequirement && !credentialMissing && (
        <div className="space-y-2">
          <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-4">
            <div className="flex items-center gap-2">
              <AlertCircleIcon className="size-4 text-red-400" />
              <p className="text-sm font-medium text-red-400">{executorUnavailableTitle(executorUnavailable)}</p>
            </div>
            <p className="mt-2 text-sm text-foreground">{error?.message}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              {executorUnavailableHint(executorUnavailable, {
                workspaceSlug,
                retryLabel: "click Run again",
              })}
            </p>
            <Link
              to="/workspace/$slug/admin/executor"
              params={{ slug: workspaceSlug }}
              className="mt-3 inline-flex text-xs font-medium text-red-400 underline underline-offset-4"
            >
              Open Executor settings
            </Link>
          </div>
        </div>
      )}

      {/* Error output */}
      {status === "failed" && error && !approvalRequirement && !credentialMissing && !executorUnavailable && (
        <div className="space-y-2">
          <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-4">
            <pre className="whitespace-pre-wrap font-mono text-sm text-red-400">{error.message}</pre>
          </div>
          {error.details && (
            <div className="rounded-lg border border-orange-500/20 bg-orange-500/5 p-4">
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-orange-400">Details</p>
              <pre className="whitespace-pre-wrap font-mono text-sm text-foreground">{error.details}</pre>
            </div>
          )}
          {error.data && Object.keys(error.data).length > 0 && (
            <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-4">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-blue-400">Data</p>
              <pre className="whitespace-pre-wrap font-mono text-sm text-foreground">
                {JSON.stringify(error.data, null, 2)}
              </pre>
            </div>
          )}
          {error.stack && (
            <details className="group">
              <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
                Show stack trace
              </summary>
              <div className="mt-2 rounded-lg border border-border/60 bg-secondary/30 p-4">
                <pre className="whitespace-pre-wrap font-mono text-xs text-muted-foreground">{error.stack}</pre>
              </div>
            </details>
          )}
        </div>
      )}

      <Dialog open={approvalDialogOpen} onOpenChange={setApprovalDialogOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Approval required</DialogTitle>
            <DialogDescription>
              Approve to attach this permission to the current session. Then click Run again to continue.
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
              Creating approval request...
            </div>
          )}
        </DialogContent>
      </Dialog>

      <CredentialResolutionDialog
        open={credentialDialogOpen}
        onOpenChange={setCredentialDialogOpen}
        payload={credentialMissing}
        sessionId={sessionId}
        revisionId={revisionId}
        workspaceId={workspaceId}
        workspaceSlug={workspaceSlug}
      />

      {/* Job Details */}
      <JobDetails job={job.job} />
    </div>
  );
}

function StatusBadge({
  status,
  label,
}: {
  status: "pending" | "running" | "completed" | "failed" | "canceled" | "error" | "approval";
  label: string;
}) {
  const config = {
    pending: {
      icon: CircleDotIcon,
      className: "text-yellow-500 bg-yellow-500/10 border-yellow-500/20",
    },
    running: {
      icon: Loader2Icon,
      className: "text-cyan-500 bg-cyan-500/10 border-cyan-500/20",
      spin: true,
    },
    completed: {
      icon: CheckCircle2Icon,
      className: "text-emerald-500 bg-emerald-500/10 border-emerald-500/20",
    },
    failed: {
      icon: AlertCircleIcon,
      className: "text-red-500 bg-red-500/10 border-red-500/20",
    },
    canceled: {
      icon: XCircleIcon,
      className: "text-orange-500 bg-orange-500/10 border-orange-500/20",
    },
    error: {
      icon: AlertCircleIcon,
      className: "text-red-500 bg-red-500/10 border-red-500/20",
    },
    approval: {
      icon: AlertCircleIcon,
      className: "text-amber-500 bg-amber-500/10 border-amber-500/20",
    },
  };

  const { icon: Icon, className } = config[status] || config.pending;

  return (
    <div className={cn("inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm font-medium", className)}>
      <Icon className={cn("size-4")} />
      {label}
    </div>
  );
}

// Helper to format duration
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

// Helper to format timestamp
function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

// Helper to format timeout
function formatTimeout(ms: number): string {
  if (ms < 60000) return `${ms / 1000}s`;
  return `${ms / 60000}min`;
}

function JobDetails({ job }: { job: NonNullable<JobResult["job"]> }) {
  const duration =
    job.startedAt && job.completedAt
      ? job.completedAt - job.startedAt
      : job.startedAt
        ? Date.now() - job.startedAt
        : null;

  return (
    <details className="group">
      <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">Job Details</summary>
      <div className="mt-2 rounded-lg border border-border/60 bg-secondary/30 p-3">
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          {/* Job ID */}
          <div className="text-muted-foreground">Job ID</div>
          <div className="font-mono text-foreground">{job._id.slice(-8)}</div>

          {/* Language */}
          <div className="text-muted-foreground">Language</div>
          <div className="text-foreground capitalize">{job.language}</div>

          {/* Status */}
          <div className="text-muted-foreground">Status</div>
          <div className="text-foreground capitalize">{job.status}</div>

          {/* Timeout */}
          {job.timeoutMs && (
            <>
              <div className="text-muted-foreground">Timeout</div>
              <div className="text-foreground">{formatTimeout(job.timeoutMs)}</div>
            </>
          )}

          {/* Started At */}
          {job.startedAt && (
            <>
              <div className="text-muted-foreground">Started</div>
              <div className="text-foreground">{formatTimestamp(job.startedAt)}</div>
            </>
          )}

          {/* Completed At */}
          {job.completedAt && (
            <>
              <div className="text-muted-foreground">Completed</div>
              <div className="text-foreground">{formatTimestamp(job.completedAt)}</div>
            </>
          )}

          {/* Duration */}
          {duration !== null && (
            <>
              <div className="text-muted-foreground">Duration</div>
              <div className="text-foreground">{formatDuration(duration)}</div>
            </>
          )}

          {/* Worker ID */}
          {job.workerId && (
            <>
              <div className="text-muted-foreground">Worker</div>
              <div className="font-mono text-foreground">{job.workerId.slice(-8)}</div>
            </>
          )}

          {/* Stop Requested */}
          {job.stopRequestedAt && (
            <>
              <div className="text-muted-foreground">Stop Requested</div>
              <div className="text-orange-400">{formatTimestamp(job.stopRequestedAt)}</div>
            </>
          )}

          {/* Stop Reason */}
          {job.stopReason && (
            <>
              <div className="text-muted-foreground">Stop Reason</div>
              <div className="text-orange-400">{job.stopReason}</div>
            </>
          )}
        </div>
      </div>
    </details>
  );
}
