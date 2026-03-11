import { Check, Eye, GitCommit, RotateCcw, Upload } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type FileChange = {
  path: string;
  status: "added" | "modified" | "deleted";
};

interface CommitPanelProps {
  changes: FileChange[];
  onCommit: (message: string) => Promise<void>;
  onDiscardAll: () => void;
  onDiscardFile: (path: string) => void;
  onViewDiff?: (path: string) => void;
  onViewAllDiffs?: () => void;
  onPublish?: () => Promise<void>;
  isActiveCommit: boolean;
  className?: string;
}

export function CommitPanel({
  changes,
  onCommit,
  onDiscardAll,
  onDiscardFile,
  onViewDiff,
  onViewAllDiffs,
  onPublish,
  isActiveCommit,
  className,
}: CommitPanelProps) {
  const [commitMessage, setCommitMessage] = useState("");
  const [isCommitting, setIsCommitting] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);

  const handleCommit = async () => {
    if (!commitMessage.trim() || changes.length === 0) return;

    setIsCommitting(true);
    try {
      await onCommit(commitMessage);
      setCommitMessage("");
    } finally {
      setIsCommitting(false);
    }
  };

  const handlePublish = async () => {
    if (!onPublish) return;

    setIsPublishing(true);
    try {
      await onPublish();
    } finally {
      setIsPublishing(false);
    }
  };

  return (
    <div className={cn("flex flex-col gap-4 p-4", className)}>
      {/* Changes list */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Changes ({changes.length})</h3>
          <div className="flex items-center gap-1">
            {changes.length > 0 && onViewAllDiffs && (
              <Button variant="ghost" size="sm" onClick={onViewAllDiffs} className="h-7 text-xs">
                <Eye className="size-3 mr-1" />
                View all
              </Button>
            )}
            {changes.length > 0 && (
              <Button variant="ghost" size="sm" onClick={onDiscardAll} className="h-7 text-xs">
                <RotateCcw className="size-3 mr-1" />
                Discard all
              </Button>
            )}
          </div>
        </div>

        {changes.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">No changes to commit</p>
        ) : (
          <div className="max-h-48 overflow-y-auto border rounded-md">
            {changes.map((change) => (
              <div key={change.path} className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent/50 group">
                <span
                  className={cn(
                    "text-xs font-mono w-4",
                    change.status === "added" && "text-green-400",
                    change.status === "modified" && "text-amber-400",
                    change.status === "deleted" && "text-red-400",
                  )}
                >
                  {change.status === "added" ? "A" : change.status === "modified" ? "M" : "D"}
                </span>
                <span className="flex-1 truncate font-mono text-xs">{change.path}</span>
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
                  {onViewDiff && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-5"
                      onClick={() => onViewDiff(change.path)}
                      title="View diff"
                    >
                      <Eye className="size-3" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-5"
                    onClick={() => onDiscardFile(change.path)}
                    title="Discard changes"
                  >
                    <RotateCcw className="size-3" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Commit form */}
      <div className="flex flex-col gap-2">
        <Input
          placeholder="Commit message"
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleCommit();
            }
          }}
          disabled={changes.length === 0 || isCommitting}
        />
        <Button
          onClick={handleCommit}
          disabled={!commitMessage.trim() || changes.length === 0 || isCommitting}
          className="w-full"
        >
          <GitCommit className="size-4 mr-2" />
          {isCommitting ? "Committing..." : "Commit"}
        </Button>
      </div>

      {/* Publish button */}
      {onPublish && (
        <div className="flex flex-col gap-2 pt-2 border-t">
          <div className="flex items-center gap-2 text-sm">
            {isActiveCommit ? (
              <>
                <Check className="size-4 text-green-500" />
                <span className="text-muted-foreground">This is the active version</span>
              </>
            ) : (
              <>
                <Upload className="size-4 text-muted-foreground" />
                <span className="text-muted-foreground">Publish to make this the active version</span>
              </>
            )}
          </div>
          {!isActiveCommit && (
            <Button variant="outline" onClick={handlePublish} disabled={isPublishing || changes.length > 0}>
              <Upload className="size-4 mr-2" />
              {isPublishing ? "Publishing..." : "Publish"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
