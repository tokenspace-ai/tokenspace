import { Link } from "@tanstack/react-router";
import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import { Loader2 } from "lucide-react";
import { createContext, useContext } from "react";
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
  const { slug, revisionId } = useWorkspaceContext();
  const workspaceContext = useQuery(api.workspace.resolveWorkspaceContext, { slug });

  if (!workspaceContext) {
    return (
      loadingFallback?.() ?? (
        <WaitingScreen>
          <p className="text-muted-foreground">Loading tokenspace revision...</p>
        </WaitingScreen>
      )
    );
  }

  if (!revisionId) {
    return (
      buildingFallback?.() ?? (
        <WaitingScreen>
          <p className="text-muted-foreground">No published revision is available yet.</p>
          <Link
            className={buttonVariants({ variant: "outline", size: "sm" })}
            to="/workspace/$slug/admin/editor"
            params={{ slug: workspaceContext.workspace.slug }}
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
