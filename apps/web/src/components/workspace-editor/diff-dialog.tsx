import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import { GitCompare } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DiffViewer } from "./diff-viewer";
import { type DiffFileChange, FileDiffList } from "./file-diff-list";

interface DiffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The base commit to compare from */
  baseCommitId: Id<"commits">;
  /** The head commit to compare to. If undefined, compares against working directory. */
  headCommitId?: Id<"commits">;
  /** Workspace ID (for potential future use) */
  workspaceId: Id<"workspaces">;
  /** Branch ID (required for working directory comparison) */
  branchId?: Id<"branches">;
  /** Initial file to show */
  initialPath?: string;
}

export function DiffDialog({
  open,
  onOpenChange,
  baseCommitId,
  headCommitId,
  workspaceId: _workspaceId,
  branchId,
  initialPath,
}: DiffDialogProps) {
  const [selectedPath, setSelectedPath] = useState<string | undefined>(initialPath);
  const [workingContent, setWorkingContent] = useState<string | undefined>(undefined);
  const [baseContent, setBaseContent] = useState<string | undefined>(undefined);
  const [headCommitContent, setHeadCommitContent] = useState<string | undefined>(undefined);

  const fetchTextFromUrl = useCallback(async (url: string, signal?: AbortSignal) => {
    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new Error(`Failed to download file content (${response.status})`);
    }
    return await response.text();
  }, []);

  // Get commit info for labels
  const baseCommit = useQuery(api.vcs.getCommit, { commitId: baseCommitId });
  const headCommit = useQuery(api.vcs.getCommit, headCommitId ? { commitId: headCommitId } : "skip");

  // Get diff between commits
  const commitDiff = useQuery(api.vcs.diffCommits, headCommitId ? { baseCommitId, headCommitId } : "skip");

  // Get working directory changes (if no headCommitId)
  const workingFiles = useQuery(api.fs.working.getAll, !headCommitId && branchId ? { branchId } : "skip");

  // Get committed tree for determining status of working files
  const currentBranch = useQuery(api.vcs.getBranch, branchId ? { branchId } : "skip");
  const currentCommit = useQuery(api.vcs.getCommit, currentBranch ? { commitId: currentBranch.commitId } : "skip");
  const baseTree = useQuery(api.trees.getFlattenedTree, currentCommit ? { treeId: currentCommit.treeId } : "skip");

  // Build change list
  const changes: DiffFileChange[] = useMemo(() => {
    if (headCommitId && commitDiff) {
      // Commit to commit diff
      return commitDiff.map((d) => ({
        path: d.path,
        status: d.type,
      }));
    }

    if (!headCommitId && workingFiles && baseTree) {
      // Working directory diff
      const basePaths = new Set(baseTree.map((f) => f.path));
      return workingFiles.map((f) => ({
        path: f.path,
        status: f.isDeleted ? "deleted" : basePaths.has(f.path) ? "modified" : "added",
      }));
    }

    return [];
  }, [headCommitId, commitDiff, workingFiles, baseTree]);

  // Get file content for the selected file
  const baseFileData = useQuery(
    api.trees.getFileContentForDiff,
    selectedPath ? { commitId: baseCommitId, path: selectedPath } : "skip",
  );

  const headFileData = useQuery(
    api.trees.getFileContentForDiff,
    selectedPath && headCommitId ? { commitId: headCommitId, path: selectedPath } : "skip",
  );

  useEffect(() => {
    if (!selectedPath) {
      setBaseContent(undefined);
      return;
    }
    if (!baseFileData) {
      setBaseContent("");
      return;
    }
    if (baseFileData.content !== undefined) {
      setBaseContent(baseFileData.content);
      return;
    }
    if (baseFileData.downloadUrl) {
      const controller = new AbortController();
      fetchTextFromUrl(baseFileData.downloadUrl, controller.signal)
        .then((content) => {
          setBaseContent(content);
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          console.error("Failed to load base file content:", error);
        });
      return () => controller.abort();
    }
    setBaseContent("");
  }, [selectedPath, baseFileData, fetchTextFromUrl]);

  useEffect(() => {
    if (!headCommitId || !selectedPath) {
      setHeadCommitContent(undefined);
      return;
    }
    if (!headFileData) {
      setHeadCommitContent("");
      return;
    }
    if (headFileData.content !== undefined) {
      setHeadCommitContent(headFileData.content);
      return;
    }
    if (headFileData.downloadUrl) {
      const controller = new AbortController();
      fetchTextFromUrl(headFileData.downloadUrl, controller.signal)
        .then((content) => {
          setHeadCommitContent(content);
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          console.error("Failed to load head file content:", error);
        });
      return () => controller.abort();
    }
    setHeadCommitContent("");
  }, [headCommitId, selectedPath, headFileData, fetchTextFromUrl]);

  useEffect(() => {
    if (headCommitId || !workingFiles || !selectedPath) {
      setWorkingContent(undefined);
      return;
    }
    const file = workingFiles.find((f) => f.path === selectedPath);
    if (!file) {
      setWorkingContent(undefined);
      return;
    }
    if (file.isDeleted) {
      setWorkingContent("");
      return;
    }
    if (file.content !== undefined) {
      setWorkingContent(file.content);
      return;
    }
    if (file.downloadUrl) {
      const controller = new AbortController();
      fetchTextFromUrl(file.downloadUrl, controller.signal)
        .then((content) => {
          setWorkingContent(content);
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          console.error("Failed to load working file content:", error);
        });
      return () => controller.abort();
    }
    setWorkingContent("");
  }, [headCommitId, workingFiles, selectedPath, fetchTextFromUrl]);

  const headContent = headCommitId ? headCommitContent : workingContent;

  // Set initial path when dialog opens
  useEffect(() => {
    if (open && initialPath) {
      setSelectedPath(initialPath);
    } else if (open && changes.length > 0 && !selectedPath) {
      setSelectedPath(changes[0].path);
    }
  }, [open, initialPath, changes, selectedPath]);

  // Reset when dialog closes
  useEffect(() => {
    if (!open) {
      setSelectedPath(undefined);
    }
  }, [open]);

  // Generate labels
  const baseLabel = baseCommit
    ? `${baseCommit.message.slice(0, 20)}${baseCommit.message.length > 20 ? "..." : ""}`
    : "Base";
  const headLabel = headCommitId
    ? headCommit
      ? `${headCommit.message.slice(0, 20)}${headCommit.message.length > 20 ? "..." : ""}`
      : "Head"
    : "Working Copy";

  const selectedChange = changes.find((c) => c.path === selectedPath);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw]! w-[95vw] h-[90vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-4 py-3 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <GitCompare className="size-5" />
            <span>Compare Changes</span>
            <span className="text-sm font-normal text-muted-foreground">
              {baseLabel} → {headLabel}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-1 overflow-hidden">
          {/* File list sidebar */}
          <div className="w-64 border-r shrink-0 overflow-hidden flex flex-col">
            <ScrollArea className="flex-1">
              <FileDiffList changes={changes} selectedPath={selectedPath} onSelectFile={setSelectedPath} />
            </ScrollArea>
          </div>

          {/* Diff viewer */}
          <div className="flex-1 overflow-hidden">
            {selectedPath && selectedChange ? (
              selectedChange.status === "deleted" ? (
                <div className="h-full flex flex-col">
                  <div className="px-4 py-2 border-b bg-muted/30">
                    <span className="text-sm text-red-400">File deleted: {selectedPath}</span>
                  </div>
                  <div className="flex-1">
                    <DiffViewer
                      original={baseContent ?? ""}
                      modified=""
                      filePath={selectedPath}
                      originalLabel={baseLabel}
                      modifiedLabel="(deleted)"
                      showModeToggle={false}
                    />
                  </div>
                </div>
              ) : selectedChange.status === "added" ? (
                <div className="h-full flex flex-col">
                  <div className="px-4 py-2 border-b bg-muted/30">
                    <span className="text-sm text-green-400">New file: {selectedPath}</span>
                  </div>
                  <div className="flex-1">
                    <DiffViewer
                      original=""
                      modified={headContent ?? ""}
                      filePath={selectedPath}
                      originalLabel="(new file)"
                      modifiedLabel={headLabel}
                      showModeToggle={false}
                    />
                  </div>
                </div>
              ) : (
                <DiffViewer
                  original={baseContent ?? ""}
                  modified={headContent ?? ""}
                  filePath={selectedPath}
                  originalLabel={baseLabel}
                  modifiedLabel={headLabel}
                />
              )
            ) : (
              <div className="h-full flex items-center justify-center text-muted-foreground">
                {changes.length === 0 ? "No changes to display" : "Select a file to view diff"}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
