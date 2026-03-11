import type { Doc } from "@tokenspace/backend/convex/_generated/dataModel";
import { ChevronDownIcon, ChevronRightIcon, GitCommitIcon, HistoryIcon } from "lucide-react";
import { useState } from "react";
import { RelativeTime } from "@/components/relative-time";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

interface CommitHistoryProps {
  commits: Doc<"commits">[];
  isLoading?: boolean;
}

export function CommitHistory({ commits, isLoading }: CommitHistoryProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="border-t">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-4 py-2 text-sm font-medium hover:bg-accent"
      >
        {isExpanded ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}
        <HistoryIcon className="size-4" />
        <span>Commit History</span>
        {commits.length > 0 && (
          <span className="ml-auto text-xs text-muted-foreground">
            {commits.length} commit{commits.length !== 1 ? "s" : ""}
          </span>
        )}
      </button>

      {isExpanded && (
        <div className="border-t">
          {isLoading ? (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              Loading commits...
            </div>
          ) : commits.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">No commits yet</div>
          ) : (
            <ScrollArea className="max-h-64">
              <div className="divide-y">
                {commits.map((commit, index) => (
                  <CommitItem key={commit._id} commit={commit} isLatest={index === 0} />
                ))}
              </div>
            </ScrollArea>
          )}
        </div>
      )}
    </div>
  );
}

interface CommitItemProps {
  commit: Doc<"commits">;
  isLatest?: boolean;
}

function CommitItem({ commit, isLatest }: CommitItemProps) {
  return (
    <div className={cn("px-4 py-3", isLatest && "bg-accent/30")}>
      <div className="flex items-start gap-2">
        <GitCommitIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{commit.message}</p>
          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{commit._id.slice(-7)}</span>
            <span>•</span>
            <RelativeTime timestamp={commit.createdAt} />
            {isLatest && (
              <>
                <span>•</span>
                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">HEAD</span>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
