import { Link } from "@tanstack/react-router";
import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { useAction, useQuery } from "convex/react";
import { Loader2 } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useConvexQuery } from "@/hooks/use-convex-query";
import { useWorkspaceContext } from "@/routes/_app/workspace.$slug";
import { buttonVariants } from "./ui/button";

const WorkspaceRevisionContext = createContext<{ revisionId: Id<"revisions"> }>({ revisionId: null as any });

interface WorkspaceRevisionProviderProps {
  children: React.ReactNode;
  loadingFallback?: () => React.ReactNode;
  buildingFallback?: () => React.ReactNode;
}
export function WorkspaceRevisionProvider({
  children,
  loadingFallback,
  buildingFallback,
}: WorkspaceRevisionProviderProps) {
  const { workspaceId, branchId, workingStateHash, slug, revisionId: explicitRevisionId } = useWorkspaceContext();
  const {
    data: revisionId,
    isPending,
    isError,
    error,
  } = useConvexQuery(api.workspace.getRevision, {
    workspaceId,
    branchId,
    workingStateHash,
  });
  const ensureRevision = useAction(api.workspace.ensureRevision);
  const [compileJobId, setCompileJobId] = useState<Id<"compileJobs"> | null>(null);
  const lastEnsureAttemptKeyRef = useRef<string | null>(null);
  const failedEnsureKeyRef = useRef<string | null>(null);
  const ensureKey = useMemo(() => {
    if (!workspaceId || !branchId) {
      return null;
    }
    return `${workspaceId}:${branchId}:${workingStateHash ?? ""}`;
  }, [workspaceId, branchId, workingStateHash]);
  const compileJob = useQuery(
    api.compile.getCompileJob,
    workspaceId && compileJobId ? { workspaceId, compileJobId } : "skip",
  );

  useEffect(() => {
    if (explicitRevisionId) {
      return;
    }
    if (revisionId !== null) {
      lastEnsureAttemptKeyRef.current = null;
      failedEnsureKeyRef.current = null;
      return;
    }
    if (ensureKey !== lastEnsureAttemptKeyRef.current) {
      failedEnsureKeyRef.current = null;
    }
  }, [explicitRevisionId, revisionId, ensureKey]);

  useEffect(() => {
    if (
      !explicitRevisionId &&
      revisionId === null &&
      !isPending &&
      !isError &&
      workspaceId &&
      branchId &&
      ensureKey &&
      !compileJobId &&
      lastEnsureAttemptKeyRef.current !== ensureKey &&
      failedEnsureKeyRef.current !== ensureKey
    ) {
      lastEnsureAttemptKeyRef.current = ensureKey;
      ensureRevision({ workspaceId, branchId, workingStateHash })
        .then((result) => {
          if (result.compileJobId) {
            setCompileJobId(result.compileJobId);
          }
        })
        .catch((e) => {
          console.error(e);
          failedEnsureKeyRef.current = ensureKey;
          toast.error("Failed to build tokenspace revision");
        });
    }
  }, [
    explicitRevisionId,
    revisionId,
    workspaceId,
    branchId,
    workingStateHash,
    isPending,
    isError,
    compileJobId,
    ensureKey,
  ]);

  useEffect(() => {
    if (!compileJob) {
      return;
    }
    if (compileJob.status === "completed") {
      setCompileJobId(null);
      return;
    }
    if (compileJob.status === "failed" || compileJob.status === "canceled") {
      setCompileJobId(null);
      if (ensureKey) {
        failedEnsureKeyRef.current = ensureKey;
      }
      toast.error(compileJob.error ?? "Failed to build tokenspace revision");
    }
  }, [compileJob, ensureKey]);

  if (explicitRevisionId) {
    return (
      <WorkspaceRevisionContext.Provider value={{ revisionId: explicitRevisionId }}>
        {children}
      </WorkspaceRevisionContext.Provider>
    );
  }

  if (isError) {
    return <div>Failed to load tokenspace revision: {error.message}</div>;
  }

  if (isPending) {
    return (
      loadingFallback?.() ?? (
        <WaitingScreen>
          <p className="text-muted-foreground">Loading tokenspace revision...</p>
        </WaitingScreen>
      )
    );
  }

  if (revisionId === null) {
    return (
      buildingFallback?.() ?? (
        <WaitingScreen>
          <p className="text-muted-foreground">Building tokenspace revision...</p>
          <Link
            className={buttonVariants({ variant: "outline", size: "sm" })}
            to="/workspace/$slug/admin/editor"
            params={{ slug }}
          >
            Go to tokenspace editor
          </Link>
        </WaitingScreen>
      )
    );
  }

  return <WorkspaceRevisionContext.Provider value={{ revisionId }}>{children}</WorkspaceRevisionContext.Provider>;
}

function WaitingScreen({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center justify-center gap-2">
        <Loader2 className="size-4 animate-spin" />
        {children}
      </div>
    </div>
  );
}

export function useWorkspaceRevision(): Id<"revisions"> {
  const { revisionId } = useContext(WorkspaceRevisionContext);
  if (!revisionId) {
    throw new Error("Tokenspace revision not found");
  }
  return revisionId;
}
