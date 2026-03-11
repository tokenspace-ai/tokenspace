import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { useAction, useMutation, useQuery } from "convex/react";
import { Eye, FilePlus, FolderPlus, GitBranch, GitCommitHorizontal, Package, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { Branch, CompileResult, CompileStatus, FileChange, FileTreeNode } from "@/components/workspace-editor";
import {
  BranchSelector,
  CommitPanel,
  CompileSidebar,
  DeleteBranchDialog,
  DiffDialog,
  FileTree,
  MergeDialog,
  WorkspaceEditor,
} from "@/components/workspace-editor";
import { buildWorkspaceSlug, getInvalidBranchNameReason, parseWorkspaceSlug } from "@/lib/workspace-slug";

export const Route = createFileRoute("/_app/workspace/$slug/admin/editor")({
  component: WorkspacePage,
  ssr: false,
  head: async () => {
    return {
      meta: [
        {
          title: "Tokenspace",
        },
      ],
    };
  },
});

function WorkspacePage() {
  const { slug } = Route.useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const userId = user?.id;

  // Parse the slug to get workspace/branch info
  const { workspaceSlug, branchName: urlBranchName } = parseWorkspaceSlug(slug);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [isInitializing, setIsInitializing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Dialog states
  const [isCreateFileDialogOpen, setIsCreateFileDialogOpen] = useState(false);
  const [isCreateFolderDialogOpen, setIsCreateFolderDialogOpen] = useState(false);
  const [newItemPath, setNewItemPath] = useState("");
  const [isSourceControlOpen, setIsSourceControlOpen] = useState(false);

  // Diff dialog state
  const [isDiffDialogOpen, setIsDiffDialogOpen] = useState(false);
  const [diffInitialPath, setDiffInitialPath] = useState<string | undefined>(undefined);
  const [diffBaseCommitId, setDiffBaseCommitId] = useState<Id<"commits"> | undefined>(undefined);
  const [diffHeadCommitId, setDiffHeadCommitId] = useState<Id<"commits"> | undefined>(undefined);

  // Branch operations dialog state
  const [isMergeDialogOpen, setIsMergeDialogOpen] = useState(false);
  const [mergeBranchId, setMergeBranchId] = useState<string | null>(null);
  const [isDeleteBranchDialogOpen, setIsDeleteBranchDialogOpen] = useState(false);
  const [deleteBranchId, setDeleteBranchId] = useState<string | null>(null);

  // Compile sidebar state
  const [isCompileSidebarOpen, setIsCompileSidebarOpen] = useState(false);
  const [compileStatus, setCompileStatus] = useState<CompileStatus>("idle");
  const [compileResult, setCompileResult] = useState<CompileResult | null>(null);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [compileJobId, setCompileJobId] = useState<Id<"compileJobs"> | null>(null);
  const [includeWorkingState, setIncludeWorkingState] = useState(false);

  // Track if we have unsaved local changes (for debounced save)
  const [hasLocalChanges, setHasLocalChanges] = useState(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastHandledCompileJobRef = useRef<string | null>(null);

  // Fetch workspace data using the parsed workspace slug
  const workspace = useQuery(api.workspace.getBySlug, { slug: workspaceSlug });
  const branches = useQuery(api.vcs.listBranches, workspace ? { workspaceId: workspace._id } : "skip");
  const defaultBranch = useQuery(api.vcs.getDefaultBranch, workspace ? { workspaceId: workspace._id } : "skip");

  // Check if workspace needs initialization (no branches exist)
  const needsInitialization = branches !== undefined && branches.length === 0;

  // Find the current branch based on URL parameter or default
  const currentBranch = useMemo(() => {
    if (!branches) return undefined;
    // First try to find by URL branch name
    const branchByName = branches.find((b) => b.name === urlBranchName);
    if (branchByName) return branchByName;
    // Fall back to default branch
    return defaultBranch ?? branches.find((b) => b.isDefault);
  }, [branches, urlBranchName, defaultBranch]);

  const activeBranchId = currentBranch?._id as Id<"branches"> | undefined;

  // Handler to change branch - navigates to new URL
  const handleBranchChange = useCallback(
    (branchId: string | null) => {
      if (!branchId || !branches) return;
      const branch = branches.find((b) => b._id === branchId);
      if (!branch) return;

      // Build new slug with the selected branch
      const newSlug = buildWorkspaceSlug(workspaceSlug, branch.name);
      navigate({
        to: "/workspace/$slug/admin/editor",
        params: { slug: newSlug },
      });
    },
    [branches, workspaceSlug, navigate],
  );
  const currentCommit = useQuery(api.vcs.getCommit, currentBranch ? { commitId: currentBranch.commitId } : "skip");

  // Get file tree from committed state
  const fileTree = useQuery(api.trees.getFileTreeStructure, currentCommit ? { treeId: currentCommit.treeId } : "skip");

  // Get committed file content
  const committedFileData = useQuery(
    api.trees.getFileFromTree,
    currentCommit && selectedPath ? { treeId: currentCommit.treeId, path: selectedPath } : "skip",
  );

  // Get working files from backend
  const workingFiles = useQuery(api.fs.working.getAll, activeBranchId ? { branchId: activeBranchId } : "skip");

  // Get commit history
  const commitHistory = useQuery(api.vcs.listCommits, workspace ? { workspaceId: workspace._id, limit: 10 } : "skip");

  // Mutations
  const initializeWorkspaceMutation = useMutation(api.vcs.initializeWorkspace);
  const createBranchMutation = useMutation(api.vcs.createBranch);
  const mergeBranchMutation = useMutation(api.vcs.mergeBranch);
  const deleteBranchMutation = useMutation(api.vcs.deleteBranch);
  const setDefaultBranchMutation = useMutation(api.vcs.setDefaultBranch);
  const setActiveCommitMutation = useMutation(api.workspace.setActiveCommit);
  const discardWorkingFileMutation = useMutation(api.fs.working.discardChange);
  const discardAllWorkingFilesMutation = useMutation(api.fs.working.discardAll);

  // Actions
  const saveWorkingFileAction = useAction(api.fs.working.save);
  const createCommitAction = useAction(api.vcs.createCommit);
  const compileBranchAction = useAction(api.compile.compileBranch);
  const compileJob = useQuery(
    api.compile.getCompileJob,
    workspace && compileJobId ? { workspaceId: workspace._id, compileJobId } : "skip",
  );

  // Create a map of working files for quick lookup
  const workingFilesMap = useMemo(() => {
    const map = new Map<string, { content: string | undefined; downloadUrl?: string; isDeleted: boolean }>();
    if (workingFiles) {
      for (const file of workingFiles) {
        map.set(file.path, { content: file.content, downloadUrl: file.downloadUrl, isDeleted: file.isDeleted });
      }
    }
    return map;
  }, [workingFiles]);

  // Save file to backend (debounced)
  const saveToBackend = useCallback(
    async (path: string, content: string) => {
      if (!workspace || !activeBranchId || !userId) return;

      setIsSaving(true);
      try {
        await saveWorkingFileAction({
          workspaceId: workspace._id,
          branchId: activeBranchId,
          path,
          content,
        });
        setHasLocalChanges(false);
      } catch (error) {
        console.error("Failed to save file:", error);
        toast.error("Failed to save file");
      } finally {
        setIsSaving(false);
      }
    },
    [workspace, activeBranchId, userId, saveWorkingFileAction],
  );

  const fetchTextFromUrl = useCallback(async (url: string, signal?: AbortSignal) => {
    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new Error(`Failed to download file content (${response.status})`);
    }
    return await response.text();
  }, []);

  const resolveCommittedContent = useCallback(
    async (signal?: AbortSignal) => {
      if (!committedFileData) return "";
      if (committedFileData.content !== undefined) {
        return committedFileData.content;
      }
      if (committedFileData.downloadUrl) {
        return await fetchTextFromUrl(committedFileData.downloadUrl, signal);
      }
      return "";
    },
    [committedFileData, fetchTextFromUrl],
  );

  // Initialize workspace handler
  const handleInitialize = async () => {
    if (!workspace || !userId) {
      toast.error("Unable to initialize tokenspace");
      return;
    }

    setIsInitializing(true);
    try {
      await initializeWorkspaceMutation({
        workspaceId: workspace._id,
      });
      toast.success("Tokenspace initialized successfully");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to initialize tokenspace");
      console.error(error);
    } finally {
      setIsInitializing(false);
    }
  };

  // Load file content when selecting a file
  const handleFileSelect = useCallback(
    (path: string, type: "file" | "directory") => {
      if (type === "file") {
        // If clicking the same file, do nothing
        if (path === selectedPath) {
          return;
        }

        // Save current file before switching (if there are pending changes)
        if (selectedPath && hasLocalChanges) {
          saveToBackend(selectedPath, fileContent);
        }

        setSelectedPath(path);

        // Load content: first check working files, then committed
        const workingFile = workingFilesMap.get(path);
        if (workingFile && !workingFile.isDeleted) {
          if (workingFile.content !== undefined) {
            setFileContent(workingFile.content);
          } else if (workingFile.downloadUrl) {
            setFileContent("");
            fetchTextFromUrl(workingFile.downloadUrl)
              .then((content) => {
                setFileContent(content);
              })
              .catch((error) => {
                console.error("Failed to load working file content:", error);
                setFileContent("");
              });
          } else {
            setFileContent("");
          }
        } else {
          // Will be populated by effect when committedFileData loads
          setFileContent("");
        }
        setHasLocalChanges(false);
      }
    },
    [selectedPath, hasLocalChanges, fileContent, saveToBackend, workingFilesMap, fetchTextFromUrl],
  );

  // Update file content when committed data loads (for files without working changes)
  useEffect(() => {
    if (!selectedPath || workingFilesMap.has(selectedPath)) return;
    if (!committedFileData) {
      setFileContent("");
      return;
    }
    const controller = new AbortController();
    resolveCommittedContent(controller.signal)
      .then((content) => {
        setFileContent(content);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error("Failed to load committed file content:", error);
      });
    return () => controller.abort();
  }, [selectedPath, committedFileData, workingFilesMap, resolveCommittedContent]);

  // Handle editor changes with debounced save
  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      if (!selectedPath || value === undefined) return;

      setFileContent(value);
      setHasLocalChanges(true);

      // Clear existing timeout
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }

      // Debounce save (save after 1 second of no typing)
      saveTimeoutRef.current = setTimeout(() => {
        saveToBackend(selectedPath, value);
      }, 1000);
    },
    [selectedPath, saveToBackend],
  );

  // Save on unmount or before page unload
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  // Build a set of paths that exist in the committed tree
  const committedPaths = useMemo(() => {
    const paths = new Set<string>();
    const collectPaths = (nodes: typeof fileTree, prefix = "") => {
      if (!nodes) return;
      for (const node of nodes) {
        const path = prefix ? `${prefix}/${node.name}` : node.name;
        if (node.type === "file") {
          paths.add(path);
        }
        if (node.children) {
          collectPaths(node.children as typeof fileTree, path);
        }
      }
    };
    collectPaths(fileTree);
    return paths;
  }, [fileTree]);

  // Convert working files to file changes list
  const changes: FileChange[] = useMemo(() => {
    if (!workingFiles) return [];
    return workingFiles.map((file) => ({
      path: file.path,
      status: file.isDeleted ? "deleted" : committedPaths.has(file.path) ? "modified" : "added",
    }));
  }, [workingFiles, committedPaths]);

  // Commit handler
  const handleCommit = async (message: string) => {
    if (!workspace || !activeBranchId || !userId) {
      toast.error("Unable to commit");
      return;
    }

    // Save any pending changes first
    if (selectedPath && hasLocalChanges) {
      await saveToBackend(selectedPath, fileContent);
    }

    try {
      await createCommitAction({
        workspaceId: workspace._id,
        branchId: activeBranchId,
        message,
      });
      toast.success("Changes committed successfully");
      // Clear selected file content since working files are cleared
      if (selectedPath) {
        // Reload from committed content
        const content = await resolveCommittedContent();
        setFileContent(content);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to commit");
      console.error(error);
    }
  };

  // Publish handler
  const handlePublish = async () => {
    if (!workspace || !currentBranch) return;
    try {
      await setActiveCommitMutation({
        workspaceId: workspace._id,
        commitId: currentBranch.commitId,
      });
      toast.success("Commit published as active");
    } catch (error) {
      toast.error("Failed to publish");
      console.error(error);
    }
  };

  // Create branch handler
  const handleCreateBranch = async () => {
    if (!workspace) return;
    const name = prompt("Enter branch name:");
    if (!name) return;
    const invalidBranchReason = getInvalidBranchNameReason(name);
    if (invalidBranchReason) {
      toast.error(invalidBranchReason);
      return;
    }

    try {
      await createBranchMutation({
        workspaceId: workspace._id,
        name,
        fromBranchId: activeBranchId,
      });
      toast.success(`Branch "${name}" created`);
      // Navigate to the new branch
      const newSlug = buildWorkspaceSlug(workspaceSlug, name);
      navigate({
        to: "/workspace/$slug/admin/editor",
        params: { slug: newSlug },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create branch");
      console.error(error);
    }
  };

  // Open merge dialog handler
  const handleOpenMergeDialog = (sourceBranchId: string) => {
    setMergeBranchId(sourceBranchId);
    setIsMergeDialogOpen(true);
  };

  // Merge branch handler
  const handleMergeBranch = async () => {
    if (!mergeBranchId || !activeBranchId || !userId) {
      toast.error("Unable to merge");
      return;
    }

    const result = await mergeBranchMutation({
      sourceBranchId: mergeBranchId as Id<"branches">,
      targetBranchId: activeBranchId,
    });

    const sourceBranch = branches?.find((b) => b._id === mergeBranchId);
    if (result.type === "fast-forward") {
      toast.success(`Fast-forward merged "${sourceBranch?.name ?? "branch"}"`);
    } else {
      toast.success(`Merged "${sourceBranch?.name ?? "branch"}" with a merge commit`);
    }
  };

  // Open delete branch dialog handler
  const handleOpenDeleteDialog = (branchId: string) => {
    setDeleteBranchId(branchId);
    setIsDeleteBranchDialogOpen(true);
  };

  // Delete branch handler
  const handleDeleteBranch = async () => {
    if (!deleteBranchId) {
      toast.error("Unable to delete branch");
      return;
    }

    const branchToDelete = branches?.find((b) => b._id === deleteBranchId);
    await deleteBranchMutation({
      branchId: deleteBranchId as Id<"branches">,
    });
    toast.success(`Branch "${branchToDelete?.name ?? "branch"}" deleted`);

    // If the deleted branch was the current one, navigate to default/main
    if (deleteBranchId === activeBranchId) {
      navigate({
        to: "/workspace/$slug/admin/editor",
        params: { slug: workspaceSlug }, // Just workspace slug = default branch
      });
    }
  };

  // Set default branch handler
  const handleSetDefaultBranch = async (branchId: string) => {
    const branch = branches?.find((b) => b._id === branchId);
    try {
      await setDefaultBranchMutation({
        branchId: branchId as Id<"branches">,
      });
      toast.success(`"${branch?.name ?? "Branch"}" is now the default branch`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to set default branch");
      console.error(error);
    }
  };

  // Discard handlers
  const handleDiscardAll = async () => {
    if (!activeBranchId || !userId) return;

    try {
      await discardAllWorkingFilesMutation({
        branchId: activeBranchId,
      });
      // Reset editor to committed content
      if (selectedPath) {
        const content = await resolveCommittedContent();
        setFileContent(content);
      } else {
        setSelectedPath(null);
        setFileContent("");
      }
      setHasLocalChanges(false);
      toast.success("All changes discarded");
    } catch (error) {
      toast.error("Failed to discard changes");
      console.error(error);
    }
  };

  const handleDiscardFile = async (path: string) => {
    if (!activeBranchId || !userId) return;

    try {
      await discardWorkingFileMutation({
        branchId: activeBranchId,
        path,
      });
      // If this was the selected file, reset its content
      if (path === selectedPath) {
        if (committedFileData) {
          const content = await resolveCommittedContent();
          setFileContent(content);
        } else {
          // File was new, deselect
          setSelectedPath(null);
          setFileContent("");
        }
        setHasLocalChanges(false);
      }
      toast.success(`Changes to "${path}" discarded`);
    } catch (error) {
      toast.error("Failed to discard file");
      console.error(error);
    }
  };

  // Compile handler
  const handleCompile = async () => {
    if (!workspace || !activeBranchId) {
      toast.error("Unable to compile");
      return;
    }

    // Save any pending changes first
    if (selectedPath && hasLocalChanges) {
      await saveToBackend(selectedPath, fileContent);
    }

    setCompileStatus("compiling");
    setCompileError(null);
    setCompileResult(null);
    setCompileJobId(null);

    try {
      const result = await compileBranchAction({
        workspaceId: workspace._id,
        branchId: activeBranchId,
        includeWorkingState: includeWorkingState && changes.length > 0,
      });
      setCompileJobId(result.compileJobId);
      lastHandledCompileJobRef.current = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to compile";
      setCompileError(message);
      setCompileStatus("error");
      toast.error(message);
    }
  };

  useEffect(() => {
    if (!compileJob) {
      return;
    }
    const handledKey = `${compileJob.compileJobId}:${compileJob.status}`;
    if (lastHandledCompileJobRef.current === handledKey) {
      return;
    }
    if (compileJob.status === "pending" || compileJob.status === "running") {
      setCompileStatus("compiling");
      lastHandledCompileJobRef.current = handledKey;
      return;
    }
    if (compileJob.status === "completed") {
      if (!compileJob.revisionId) {
        setCompileError("Compile job completed without revision ID");
        setCompileStatus("error");
        toast.error("Compile job completed without revision ID");
        lastHandledCompileJobRef.current = handledKey;
        return;
      }
      setCompileResult({
        revisionId: compileJob.revisionId,
        revisionFs: {
          declarationCount: compileJob.revisionFs?.declarationCount ?? 0,
          fileCount: compileJob.revisionFs?.fileCount ?? 0,
          systemCount: compileJob.revisionFs?.systemCount ?? 0,
        },
        compilerVersion: compileJob.compilerVersion,
        sourceFingerprint: compileJob.sourceFingerprint,
        artifactFingerprint: compileJob.artifactFingerprint,
      });
      setCompileStatus("success");
      setCompileError(null);
      toast.success("Tokenspace compiled successfully");
      lastHandledCompileJobRef.current = handledKey;
      return;
    }
    if (compileJob.status === "failed" || compileJob.status === "canceled") {
      const message = compileJob.error ?? "Compile job failed";
      setCompileError(message);
      setCompileStatus("error");
      toast.error(message);
      lastHandledCompileJobRef.current = handledKey;
    }
  }, [compileJob]);

  // View diff for a specific file
  const handleViewDiff = (path: string) => {
    if (!currentCommit) return;
    setDiffBaseCommitId(currentCommit._id);
    setDiffHeadCommitId(undefined); // undefined = working directory
    setDiffInitialPath(path);
    setIsDiffDialogOpen(true);
  };

  // View all diffs
  const handleViewAllDiffs = () => {
    if (!currentCommit) return;
    setDiffBaseCommitId(currentCommit._id);
    setDiffHeadCommitId(undefined);
    setDiffInitialPath(undefined);
    setIsDiffDialogOpen(true);
  };

  // View diff for a commit (compared to its parent)
  const handleViewCommitDiff = (commitId: Id<"commits">, parentCommitId?: Id<"commits">) => {
    if (!parentCommitId) {
      toast.error("This is the initial commit - no parent to compare");
      return;
    }
    setDiffBaseCommitId(parentCommitId);
    setDiffHeadCommitId(commitId);
    setDiffInitialPath(undefined);
    setIsDiffDialogOpen(true);
  };

  // Create file handler
  const handleCreateFile = async () => {
    const path = newItemPath.trim();
    if (!path) {
      toast.error("Please enter a file path");
      return;
    }

    if (!workspace || !activeBranchId || !userId) {
      toast.error("Unable to create file");
      return;
    }

    // Normalize path (remove leading/trailing slashes)
    const normalizedPath = path.replace(/^\/+|\/+$/g, "");

    // Check if file already exists in working files
    if (workingFilesMap.has(normalizedPath)) {
      toast.error("A file with this path already exists in pending changes");
      return;
    }

    // Check if file exists in the committed tree
    const existingInTree = fileTree?.some((node) => {
      const checkNode = (n: (typeof fileTree)[0], currentPath: string): boolean => {
        const nodePath = currentPath ? `${currentPath}/${n.name}` : n.name;
        if (nodePath === normalizedPath) return true;
        if (n.children) {
          return n.children.some((child) => checkNode(child as (typeof fileTree)[0], nodePath));
        }
        return false;
      };
      return checkNode(node, "");
    });

    if (existingInTree) {
      toast.error("A file with this path already exists");
      return;
    }

    try {
      // Create empty file in working directory
      await saveWorkingFileAction({
        workspaceId: workspace._id,
        branchId: activeBranchId,
        path: normalizedPath,
        content: "",
      });

      // Select and open the new file
      setSelectedPath(normalizedPath);
      setFileContent("");

      // Close dialog and reset
      setIsCreateFileDialogOpen(false);
      setNewItemPath("");
      toast.success(`File "${normalizedPath}" created`);
    } catch (error) {
      toast.error("Failed to create file");
      console.error(error);
    }
  };

  // Create folder handler (creates a .gitkeep file inside the folder)
  const handleCreateFolder = async () => {
    const path = newItemPath.trim();
    if (!path) {
      toast.error("Please enter a folder path");
      return;
    }

    if (!workspace || !activeBranchId || !userId) {
      toast.error("Unable to create folder");
      return;
    }

    // Normalize path
    const normalizedPath = path.replace(/^\/+|\/+$/g, "");
    const gitkeepPath = `${normalizedPath}/.gitkeep`;

    if (workingFilesMap.has(gitkeepPath)) {
      toast.error("This folder already exists in pending changes");
      return;
    }

    try {
      // Create .gitkeep file in working directory
      await saveWorkingFileAction({
        workspaceId: workspace._id,
        branchId: activeBranchId,
        path: gitkeepPath,
        content: "",
      });

      // Close dialog and reset
      setIsCreateFolderDialogOpen(false);
      setNewItemPath("");
      toast.success(`Folder "${normalizedPath}" created`);
    } catch (error) {
      toast.error("Failed to create folder");
      console.error(error);
    }
  };

  // Convert file tree to FileTreeNode format, including working files
  const displayTree = useMemo((): FileTreeNode[] => {
    // Helper to recursively convert committed tree nodes
    const convertCommittedNode = (node: NonNullable<typeof fileTree>[number]): FileTreeNode => {
      const workingFile = workingFilesMap.get(node.path);
      const status = workingFile ? (workingFile.isDeleted ? "deleted" : "modified") : "unchanged";

      return {
        name: node.name,
        path: node.path,
        type: node.type,
        status,
        children: node.children ? node.children.map((child) => convertCommittedNode(child as typeof node)) : undefined,
      };
    };

    // Start with committed tree
    const result: FileTreeNode[] = (fileTree ?? []).map(convertCommittedNode);

    // Add new files from working directory that aren't in the committed tree
    for (const [filePath, workingFile] of workingFilesMap) {
      if (workingFile.isDeleted) continue;

      // Check if this path exists in committed tree
      if (committedPaths.has(filePath)) continue;

      // Parse path to build tree structure
      const parts = filePath.split("/");
      let currentLevel = result;
      let currentPath = "";

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        const isFile = i === parts.length - 1;

        // Find or create the node at this level
        let existingNode = currentLevel.find((n) => n.name === part);

        if (!existingNode) {
          existingNode = {
            name: part,
            path: currentPath,
            type: isFile ? "file" : "directory",
            status: isFile ? "added" : "unchanged",
            children: isFile ? undefined : [],
          };
          currentLevel.push(existingNode);
        }

        if (!isFile && existingNode.children) {
          currentLevel = existingNode.children;
        }
      }
    }

    // Helper to sort a level and its children recursively
    const sortTree = (nodes: FileTreeNode[]): void => {
      nodes.sort((a, b) => {
        if (a.type === "directory" && b.type === "file") return -1;
        if (a.type === "file" && b.type === "directory") return 1;
        return a.name.localeCompare(b.name);
      });
      for (const node of nodes) {
        if (node.children) {
          sortTree(node.children);
        }
      }
    };

    sortTree(result);
    return result;
  }, [fileTree, workingFilesMap, committedPaths]);

  // Convert branches to Branch format
  const branchList: Branch[] =
    branches?.map((b) => ({
      id: b._id,
      name: b.name,
      isDefault: b.isDefault,
      commitId: b.commitId,
    })) ?? [];

  const isActiveCommit = workspace?.activeCommitId === currentBranch?.commitId;

  if (!workspace) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-muted-foreground">Loading tokenspace...</div>
      </div>
    );
  }

  // Show initialization screen if workspace has no branches
  if (needsInitialization) {
    return (
      <div className="flex flex-col flex-1 bg-background">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-6 max-w-md">
            <div className="mx-auto p-4 rounded-2xl bg-muted/50 border border-border/50 w-fit">
              <GitBranch className="size-12 text-muted-foreground" />
            </div>
            <div className="space-y-2">
              <h2 className="text-xl font-semibold">Initialize Tokenspace</h2>
              <p className="text-muted-foreground">
                This tokenspace hasn't been initialized yet. Initialize it to create the main branch and start adding
                files.
              </p>
            </div>
            <Button onClick={handleInitialize} disabled={isInitializing || !userId} className="gap-2">
              <GitBranch className="size-4" />
              {isInitializing ? "Initializing..." : "Initialize Tokenspace"}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 bg-background">
      {/* Editor toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-card">
        <div className="flex items-center gap-4">
          <BranchSelector
            branches={branchList}
            currentBranchId={activeBranchId}
            onBranchChange={handleBranchChange}
            onCreateBranch={handleCreateBranch}
            onMergeBranch={handleOpenMergeDialog}
            onSetDefaultBranch={handleSetDefaultBranch}
            onDeleteBranch={handleOpenDeleteDialog}
          />
          {(isSaving || hasLocalChanges) && (
            <span className="text-xs text-muted-foreground">{isSaving ? "Saving..." : "Unsaved changes"}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="gap-2" onClick={() => setIsCompileSidebarOpen(true)}>
            <Package className="size-4" />
            Compile
          </Button>
          <Button variant="ghost" size="icon">
            <RefreshCw className="size-4" />
          </Button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* File tree sidebar */}
        <div className="w-64 border-r bg-card flex flex-col">
          <div className="flex items-center justify-between px-4 py-2 border-b">
            <span className="text-sm font-medium">Files</span>
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={() => setIsCreateFileDialogOpen(true)}
                title="New File"
              >
                <FilePlus className="size-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={() => setIsCreateFolderDialogOpen(true)}
                title="New Folder"
              >
                <FolderPlus className="size-3" />
              </Button>
            </div>
          </div>
          <ScrollArea className="flex-1">
            <FileTree nodes={displayTree} selectedPath={selectedPath ?? undefined} onSelect={handleFileSelect} />
          </ScrollArea>
        </div>

        {/* Editor */}
        <div className="flex-1 flex flex-col">
          {/* Changes banner */}
          {changes.length > 0 && (
            <div className="flex items-center justify-between px-4 py-2 bg-amber-500/10 border-b border-amber-500/20">
              <div className="flex items-center gap-2">
                <div className="size-2 rounded-full bg-amber-500 animate-pulse" />
                <span className="text-sm text-amber-600 dark:text-amber-400">
                  {changes.length} uncommitted {changes.length === 1 ? "change" : "changes"}
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-amber-600 dark:text-amber-400 hover:text-amber-700 hover:bg-amber-500/20"
                onClick={() => setIsSourceControlOpen(true)}
              >
                <GitCommitHorizontal className="size-3.5 mr-1.5" />
                Review & Commit
              </Button>
            </div>
          )}

          {selectedPath ? (
            <>
              <div className="px-4 py-2 border-b bg-muted/30">
                <span className="text-sm font-mono text-muted-foreground">{selectedPath}</span>
              </div>
              <div className="flex-1">
                <WorkspaceEditor value={fileContent} onChange={handleEditorChange} filePath={selectedPath} />
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted-foreground">Select a file to edit</div>
          )}
        </div>
      </div>

      {/* Source Control Sheet */}
      <Sheet open={isSourceControlOpen} onOpenChange={setIsSourceControlOpen}>
        <SheetContent className="w-[400px] sm:max-w-[400px] flex flex-col p-0">
          <SheetHeader className="px-4 py-3 border-b">
            <SheetTitle className="flex items-center gap-2">
              <GitCommitHorizontal className="size-4" />
              Source Control
            </SheetTitle>
          </SheetHeader>
          <ScrollArea className="flex-1">
            <CommitPanel
              changes={changes}
              onCommit={handleCommit}
              onDiscardAll={handleDiscardAll}
              onDiscardFile={handleDiscardFile}
              onViewDiff={handleViewDiff}
              onViewAllDiffs={handleViewAllDiffs}
              onPublish={handlePublish}
              isActiveCommit={isActiveCommit}
            />

            {/* Commit History */}
            <div className="px-4 pb-4">
              <div className="flex items-center gap-2 mb-3 pt-2 border-t">
                <h3 className="text-sm font-medium">Recent Commits</h3>
              </div>
              {commitHistory && commitHistory.length > 0 ? (
                <div className="space-y-2">
                  {commitHistory.map((commit, index) => (
                    <div
                      key={commit._id}
                      className="flex items-start gap-3 py-2 px-2 rounded-md hover:bg-muted/50 transition-colors group"
                    >
                      <div className="relative flex flex-col items-center">
                        <div
                          className={`size-2 rounded-full mt-1.5 ${
                            index === 0 ? "bg-primary" : "bg-muted-foreground/40"
                          }`}
                        />
                        {index < commitHistory.length - 1 && <div className="w-px h-full bg-border absolute top-3.5" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm truncate">{commit.message}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <p className="text-xs text-muted-foreground">
                            {new Date(commit.createdAt).toLocaleDateString(undefined, {
                              month: "short",
                              day: "numeric",
                              hour: "numeric",
                              minute: "2-digit",
                            })}
                          </p>
                          {commit.parentId && (
                            <button
                              type="button"
                              onClick={() => handleViewCommitDiff(commit._id, commit.parentId)}
                              className="text-xs text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1"
                            >
                              <Eye className="size-3" />
                              View changes
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No commits yet</p>
              )}
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>

      {/* Create File Dialog */}
      <Dialog open={isCreateFileDialogOpen} onOpenChange={setIsCreateFileDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleCreateFile();
            }}
          >
            <DialogHeader>
              <DialogTitle>Create New File</DialogTitle>
              <DialogDescription>
                Enter the path for the new file. Use forward slashes for nested paths.
              </DialogDescription>
            </DialogHeader>
            <div className="py-4">
              <Label htmlFor="file-path">File Path</Label>
              <Input
                id="file-path"
                placeholder="src/components/Button.tsx"
                value={newItemPath}
                onChange={(e) => setNewItemPath(e.target.value)}
                className="mt-2 font-mono"
                autoFocus
              />
              <p className="text-xs text-muted-foreground mt-2">
                Example: <code className="bg-muted px-1 rounded">lib/utils.ts</code> or{" "}
                <code className="bg-muted px-1 rounded">README.md</code>
              </p>
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" onClick={() => setNewItemPath("")}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={!newItemPath.trim()}>
                Create File
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Create Folder Dialog */}
      <Dialog open={isCreateFolderDialogOpen} onOpenChange={setIsCreateFolderDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleCreateFolder();
            }}
          >
            <DialogHeader>
              <DialogTitle>Create New Folder</DialogTitle>
              <DialogDescription>
                Enter the path for the new folder. A .gitkeep file will be created to track the folder.
              </DialogDescription>
            </DialogHeader>
            <div className="py-4">
              <Label htmlFor="folder-path">Folder Path</Label>
              <Input
                id="folder-path"
                placeholder="src/components"
                value={newItemPath}
                onChange={(e) => setNewItemPath(e.target.value)}
                className="mt-2 font-mono"
                autoFocus
              />
              <p className="text-xs text-muted-foreground mt-2">
                Example: <code className="bg-muted px-1 rounded">lib/hooks</code> or{" "}
                <code className="bg-muted px-1 rounded">docs/api</code>
              </p>
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" onClick={() => setNewItemPath("")}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={!newItemPath.trim()}>
                Create Folder
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Diff Dialog */}
      {workspace && diffBaseCommitId && (
        <DiffDialog
          open={isDiffDialogOpen}
          onOpenChange={setIsDiffDialogOpen}
          baseCommitId={diffBaseCommitId}
          headCommitId={diffHeadCommitId}
          workspaceId={workspace._id}
          branchId={activeBranchId}
          initialPath={diffInitialPath}
        />
      )}

      {/* Merge Branch Dialog */}
      <MergeDialog
        open={isMergeDialogOpen}
        onOpenChange={setIsMergeDialogOpen}
        sourceBranch={branchList.find((b) => b.id === mergeBranchId)}
        targetBranch={branchList.find((b) => b.id === activeBranchId)}
        onConfirm={handleMergeBranch}
      />

      {/* Delete Branch Dialog */}
      <DeleteBranchDialog
        open={isDeleteBranchDialogOpen}
        onOpenChange={setIsDeleteBranchDialogOpen}
        branch={branchList.find((b) => b.id === deleteBranchId)}
        onConfirm={handleDeleteBranch}
      />

      {/* Compile Sidebar */}
      <CompileSidebar
        open={isCompileSidebarOpen}
        onOpenChange={setIsCompileSidebarOpen}
        status={compileStatus}
        result={compileResult}
        error={compileError}
        onCompile={handleCompile}
        includeWorkingState={includeWorkingState}
        onIncludeWorkingStateChange={setIncludeWorkingState}
        hasWorkingChanges={changes.length > 0}
      />
    </div>
  );
}
