import { ChevronDownIcon, ChevronRightIcon, FileIcon, FolderIcon, FolderOpenIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

// File entry from committed tree or working files
export interface FileEntry {
  path: string;
  content?: string;
  isDeleted?: boolean;
  isModified?: boolean;
  isNew?: boolean;
}

interface FileTreeProps {
  files: FileEntry[];
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
}

// Tree node structure for rendering
interface TreeNode {
  name: string;
  path: string;
  type: "file" | "folder";
  children?: TreeNode[];
  isDeleted?: boolean;
  isModified?: boolean;
  isNew?: boolean;
}

/**
 * Build a tree structure from flat file paths.
 */
function buildTree(files: FileEntry[]): TreeNode[] {
  const root: TreeNode[] = [];
  const nodeMap = new Map<string, TreeNode>();

  // Sort files by path for consistent ordering
  const sortedFiles = [...files].sort((a, b) => a.path.localeCompare(b.path));

  for (const file of sortedFiles) {
    const parts = file.path.split("/");
    let currentPath = "";
    let currentLevel = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      let node = nodeMap.get(currentPath);

      if (!node) {
        node = {
          name: part,
          path: currentPath,
          type: isLast ? "file" : "folder",
          children: isLast ? undefined : [],
          isDeleted: isLast ? file.isDeleted : undefined,
          isModified: isLast ? file.isModified : undefined,
          isNew: isLast ? file.isNew : undefined,
        };
        nodeMap.set(currentPath, node);
        currentLevel.push(node);
      }

      if (!isLast && node.children) {
        currentLevel = node.children;
      }
    }
  }

  // Sort each level: folders first, then files, alphabetically
  function sortNodes(nodes: TreeNode[]): TreeNode[] {
    return nodes.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "folder" ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  }

  function sortRecursive(nodes: TreeNode[]): TreeNode[] {
    const sorted = sortNodes(nodes);
    for (const node of sorted) {
      if (node.children) {
        node.children = sortRecursive(node.children);
      }
    }
    return sorted;
  }

  return sortRecursive(root);
}

interface TreeNodeItemProps {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  expandedFolders: Set<string>;
  toggleFolder: (path: string) => void;
}

function TreeNodeItem({ node, depth, selectedPath, onSelectFile, expandedFolders, toggleFolder }: TreeNodeItemProps) {
  const isExpanded = expandedFolders.has(node.path);
  const isSelected = selectedPath === node.path;
  const isFolder = node.type === "folder";

  const handleClick = () => {
    if (isFolder) {
      toggleFolder(node.path);
    } else {
      onSelectFile(node.path);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        className={cn(
          "flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left text-sm hover:bg-accent",
          isSelected && "bg-accent",
          node.isDeleted && "text-muted-foreground line-through opacity-60",
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {isFolder ? (
          <>
            {isExpanded ? (
              <ChevronDownIcon className="size-4 shrink-0" />
            ) : (
              <ChevronRightIcon className="size-4 shrink-0" />
            )}
            {isExpanded ? (
              <FolderOpenIcon className="size-4 shrink-0 text-amber-500" />
            ) : (
              <FolderIcon className="size-4 shrink-0 text-amber-500" />
            )}
          </>
        ) : (
          <>
            <span className="size-4" /> {/* Spacer for alignment */}
            <FileIcon className="size-4 shrink-0 text-muted-foreground" />
          </>
        )}
        <span className="truncate">{node.name}</span>
        {node.isNew && <span className="ml-auto text-xs text-green-500">N</span>}
        {node.isModified && !node.isNew && <span className="ml-auto text-xs text-amber-500">M</span>}
        {node.isDeleted && <span className="ml-auto text-xs text-red-500">D</span>}
      </button>
      {isFolder && isExpanded && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeNodeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelectFile={onSelectFile}
              expandedFolders={expandedFolders}
              toggleFolder={toggleFolder}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileTree({ files, selectedPath, onSelectFile }: FileTreeProps) {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => {
    // Auto-expand folders containing the selected file
    const expanded = new Set<string>();
    if (selectedPath) {
      const parts = selectedPath.split("/");
      let path = "";
      for (let i = 0; i < parts.length - 1; i++) {
        path = path ? `${path}/${parts[i]}` : parts[i];
        expanded.add(path);
      }
    }
    return expanded;
  });

  const tree = useMemo(() => buildTree(files), [files]);

  const toggleFolder = (path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  if (files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
        No files yet
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-2">
        {tree.map((node) => (
          <TreeNodeItem
            key={node.path}
            node={node}
            depth={0}
            selectedPath={selectedPath}
            onSelectFile={onSelectFile}
            expandedFolders={expandedFolders}
            toggleFolder={toggleFolder}
          />
        ))}
      </div>
    </ScrollArea>
  );
}
