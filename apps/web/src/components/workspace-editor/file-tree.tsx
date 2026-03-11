import { ChevronRight, File, Folder, FolderOpen } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

export type FileTreeNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  status?: "unchanged" | "modified" | "added" | "deleted";
  children?: FileTreeNode[];
};

interface FileTreeProps {
  nodes: FileTreeNode[];
  selectedPath?: string;
  onSelect: (path: string, type: "file" | "directory") => void;
  className?: string;
}

interface FileTreeItemProps {
  node: FileTreeNode;
  depth: number;
  selectedPath?: string;
  onSelect: (path: string, type: "file" | "directory") => void;
}

function getFileIcon(fileName: string) {
  const ext = fileName.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
      return <span className="text-blue-400">TS</span>;
    case "js":
    case "jsx":
      return <span className="text-yellow-400">JS</span>;
    case "json":
      return <span className="text-green-400">{"{}"}</span>;
    case "md":
      return <span className="text-gray-400">MD</span>;
    default:
      return <File className="size-4 text-muted-foreground" />;
  }
}

function getStatusColor(status?: FileTreeNode["status"]) {
  switch (status) {
    case "added":
      return "text-green-400";
    case "modified":
      return "text-amber-400";
    case "deleted":
      return "text-red-400 line-through";
    default:
      return "";
  }
}

function FileTreeItem({ node, depth, selectedPath, onSelect }: FileTreeItemProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const isSelected = selectedPath === node.path;
  const isDirectory = node.type === "directory";

  const handleClick = () => {
    if (isDirectory) {
      setIsExpanded(!isExpanded);
    }
    onSelect(node.path, node.type);
  };

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        className={cn(
          "flex w-full items-center gap-1 px-2 py-1 text-sm hover:bg-accent/50 rounded-sm transition-colors",
          isSelected && "bg-accent text-accent-foreground",
          getStatusColor(node.status),
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {isDirectory ? (
          <>
            <ChevronRight
              className={cn("size-4 text-muted-foreground transition-transform", isExpanded && "rotate-90")}
            />
            {isExpanded ? (
              <FolderOpen className="size-4 text-amber-400" />
            ) : (
              <Folder className="size-4 text-amber-400" />
            )}
          </>
        ) : (
          <>
            <span className="size-4" /> {/* Spacer for alignment */}
            {getFileIcon(node.name)}
          </>
        )}
        <span className="truncate">{node.name}</span>
        {node.status && node.status !== "unchanged" && (
          <span
            className={cn(
              "ml-auto text-xs",
              node.status === "added" && "text-green-400",
              node.status === "modified" && "text-amber-400",
              node.status === "deleted" && "text-red-400",
            )}
          >
            {node.status === "added" ? "A" : node.status === "modified" ? "M" : "D"}
          </span>
        )}
      </button>
      {isDirectory && isExpanded && node.children && (
        <div>
          {node.children.map((child) => (
            <FileTreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileTree({ nodes, selectedPath, onSelect, className }: FileTreeProps) {
  return (
    <div className={cn("text-sm", className)}>
      {nodes.map((node) => (
        <FileTreeItem key={node.path} node={node} depth={0} selectedPath={selectedPath} onSelect={onSelect} />
      ))}
      {nodes.length === 0 && (
        <div className="px-4 py-8 text-center text-muted-foreground text-sm">No files in workspace</div>
      )}
    </div>
  );
}
