import { File, FileMinus, FilePlus, FileX } from "lucide-react";
import { cn } from "@/lib/utils";

export interface DiffFileChange {
  path: string;
  status: "added" | "modified" | "deleted";
}

interface FileDiffListProps {
  changes: DiffFileChange[];
  selectedPath?: string;
  onSelectFile: (path: string) => void;
  className?: string;
}

function getStatusIcon(status: DiffFileChange["status"]) {
  switch (status) {
    case "added":
      return <FilePlus className="size-4 text-green-400" />;
    case "modified":
      return <File className="size-4 text-amber-400" />;
    case "deleted":
      return <FileMinus className="size-4 text-red-400" />;
    default:
      return <FileX className="size-4 text-muted-foreground" />;
  }
}

function getStatusLabel(status: DiffFileChange["status"]) {
  switch (status) {
    case "added":
      return "A";
    case "modified":
      return "M";
    case "deleted":
      return "D";
    default:
      return "?";
  }
}

function getStatusColor(status: DiffFileChange["status"]) {
  switch (status) {
    case "added":
      return "text-green-400";
    case "modified":
      return "text-amber-400";
    case "deleted":
      return "text-red-400";
    default:
      return "text-muted-foreground";
  }
}

export function FileDiffList({ changes, selectedPath, onSelectFile, className }: FileDiffListProps) {
  if (changes.length === 0) {
    return <div className={cn("p-4 text-sm text-muted-foreground text-center", className)}>No changes to display</div>;
  }

  // Group changes by status for summary
  const summary = {
    added: changes.filter((c) => c.status === "added").length,
    modified: changes.filter((c) => c.status === "modified").length,
    deleted: changes.filter((c) => c.status === "deleted").length,
  };

  return (
    <div className={cn("flex flex-col", className)}>
      {/* Summary header */}
      <div className="px-3 py-2 text-xs text-muted-foreground border-b bg-muted/30 flex items-center gap-3">
        <span className="font-medium">{changes.length} changed files</span>
        {summary.added > 0 && <span className="text-green-400">+{summary.added}</span>}
        {summary.modified > 0 && <span className="text-amber-400">~{summary.modified}</span>}
        {summary.deleted > 0 && <span className="text-red-400">-{summary.deleted}</span>}
      </div>

      {/* File list */}
      <div className="divide-y overflow-y-auto">
        {changes.map((change) => (
          <button
            key={change.path}
            type="button"
            onClick={() => onSelectFile(change.path)}
            className={cn(
              "w-full px-3 py-2 flex items-center gap-2 text-left transition-colors",
              "hover:bg-muted/50 focus:bg-muted/50 focus:outline-none",
              selectedPath === change.path && "bg-accent",
            )}
          >
            {getStatusIcon(change.status)}
            <span className="flex-1 font-mono text-sm truncate">{change.path}</span>
            <span className={cn("text-xs font-mono w-4 text-center", getStatusColor(change.status))}>
              {getStatusLabel(change.status)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
