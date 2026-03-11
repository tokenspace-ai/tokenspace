"use client";

import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import { FileIcon, FolderIcon, Loader2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { FileTree, FileTreeFile, FileTreeFolder, FileTreeIcon, FileTreeName } from "@/components/ai-elements/file-tree";
import { FilePreview } from "@/components/chat/file-preview";
import { cn } from "@/lib/utils";

// Build a tree structure from flat file paths
type TreeNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  children: Map<string, TreeNode>;
};

function buildFileTree(paths: string[]): TreeNode {
  const root: TreeNode = {
    name: "",
    path: "",
    type: "directory",
    children: new Map(),
  };

  for (const path of paths) {
    const parts = path.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const currentPath = parts.slice(0, i + 1).join("/");

      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          path: currentPath,
          type: isLast ? "file" : "directory",
          children: new Map(),
        });
      }

      current = current.children.get(part)!;
    }
  }

  return root;
}

function sortTreeNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.sort((a, b) => {
    // Directories first
    if (a.type !== b.type) {
      return a.type === "directory" ? -1 : 1;
    }
    // Then alphabetically
    return a.name.localeCompare(b.name);
  });
}

type FileTreeNodeComponentProps = {
  node: TreeNode;
  filePaths: Set<string>;
};

function FileTreeNodeComponent({ node, filePaths }: FileTreeNodeComponentProps) {
  const sortedChildren = useMemo(() => sortTreeNodes(Array.from(node.children.values())), [node.children]);

  // Check if this is actually a file (exists in the file paths set)
  const isFile = node.type === "file" || filePaths.has(node.path);

  if (isFile) {
    return (
      <FileTreeFile path={node.path} name={node.name}>
        <span className="size-4" />
        <FileTreeIcon>
          <FileIcon className="size-4 text-muted-foreground" />
        </FileTreeIcon>
        <FileTreeName>{node.name}</FileTreeName>
      </FileTreeFile>
    );
  }

  return (
    <FileTreeFolder path={node.path} name={node.name}>
      {sortedChildren.map((child) => (
        <FileTreeNodeComponent key={child.path} node={child} filePaths={filePaths} />
      ))}
    </FileTreeFolder>
  );
}

export interface SessionFileExplorerProps {
  sessionId: Id<"sessions">;
  className?: string;
  /** Whether to show the file preview panel */
  showPreview?: boolean;
}

export function SessionFileExplorer({ sessionId, className, showPreview = true }: SessionFileExplorerProps) {
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);

  // Fetch files
  const files = useQuery(api.fs.overlay.listAllFiles, { sessionId });

  const filePaths = useMemo(() => new Set(files ?? []), [files]);

  const tree = useMemo(() => {
    if (!files) return null;
    return buildFileTree(files);
  }, [files]);

  const sortedRootChildren = useMemo(() => {
    if (!tree) return [];
    return sortTreeNodes(Array.from(tree.children.values()));
  }, [tree]);

  // Handle file selection - only select files, not directories
  const handleSelect = (path: string) => {
    if (filePaths.has(path)) {
      setSelectedFilePath(path);
    }
  };

  const fileTreeContent =
    files === undefined ? (
      <div className="flex items-center justify-center py-8">
        <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
      </div>
    ) : files.length === 0 ? (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <FolderIcon className="size-8 text-muted-foreground/50" />
        <p className="mt-2 text-sm text-muted-foreground">No files in session</p>
      </div>
    ) : (
      <FileTree
        className="border-0 bg-transparent"
        selectedPath={selectedFilePath ?? undefined}
        onSelect={handleSelect}
      >
        {sortedRootChildren.map((node) => (
          <FileTreeNodeComponent key={node.path} node={node} filePaths={filePaths} />
        ))}
      </FileTree>
    );

  if (!showPreview) {
    return <div className={cn("overflow-auto p-3", className)}>{fileTreeContent}</div>;
  }

  return (
    <div className={cn("flex flex-col", className)}>
      {/* File tree - fixed max height with scroll */}
      <div className="shrink-0 max-h-[40%] overflow-auto p-3">{fileTreeContent}</div>

      {/* Preview - takes remaining space */}
      {selectedFilePath ? (
        <FilePreview
          sessionId={sessionId}
          path={selectedFilePath}
          onClose={() => setSelectedFilePath(null)}
          className="flex-1 min-h-0"
        />
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center text-center border-t border-border/40 text-muted-foreground">
          <FileIcon className="size-8 mb-2 opacity-50" />
          <p className="text-sm">Select a file to preview</p>
        </div>
      )}
    </div>
  );
}
