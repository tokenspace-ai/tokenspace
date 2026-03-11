import Editor from "@monaco-editor/react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { useAction, useQuery } from "convex/react";
import { AlertCircle, FolderOpen, Package } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileTree, type FileTreeNode } from "@/components/workspace-editor";
import { useTheme } from "@/lib/theme";
import { parseWorkspaceSlug } from "@/lib/workspace-slug";

type RevisionBuildDetails = {
  revisionId: Id<"revisions">;
  compileMode?: "local" | "server";
  compilerVersion?: string;
  sourceFingerprint?: string;
  artifactFingerprint?: string;
  manifest?: {
    schemaVersion: number;
    compilerVersion: string;
    sourceFingerprint: string;
    mode: "local" | "server";
    createdAt?: string;
    artifactFingerprint?: string;
    artifacts: {
      revisionFs: { path?: string; hash: string; size: number };
      bundle: { path?: string; hash: string; size: number };
      metadata: { path?: string; hash: string; size: number };
      diagnostics: { path?: string; hash: string; size: number };
      deps?: { path?: string; hash: string; size: number };
    };
  };
  diagnostics?: {
    declarationDiagnostics: Array<{ file?: string; message: string; line?: number; column?: number; code: number }>;
    timingsMs: Record<string, number>;
    warnings: string[];
  };
};

function shortHash(value: string | undefined): string {
  if (!value) return "n/a";
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}

export const Route = createFileRoute("/_app/workspace/$slug/admin/revision-files")({
  component: SandboxExplorerPage,
  ssr: false,
  head: async () => {
    return {
      meta: [
        {
          title: "Revision Files",
        },
      ],
    };
  },
});

function getLanguageFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
    case "d.ts":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "json":
      return "json";
    case "md":
      return "markdown";
    case "css":
      return "css";
    case "html":
      return "html";
    case "yaml":
    case "yml":
      return "yaml";
    default:
      return "plaintext";
  }
}

function SandboxExplorerPage() {
  const { slug } = Route.useParams();
  const { workspaceSlug, branchName: urlBranchName } = parseWorkspaceSlug(slug);
  const { resolvedTheme } = useTheme();

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [resolvedContent, setResolvedContent] = useState<string>("");

  // Fetch workspace data
  const workspace = useQuery(api.workspace.getBySlug, { slug: workspaceSlug });
  const branches = useQuery(api.vcs.listBranches, workspace ? { workspaceId: workspace._id } : "skip");
  const defaultBranch = useQuery(api.vcs.getDefaultBranch, workspace ? { workspaceId: workspace._id } : "skip");

  // Find the current branch
  const currentBranch = useMemo(() => {
    if (!branches) return undefined;
    const branchByName = branches.find((b) => b.name === urlBranchName);
    if (branchByName) return branchByName;
    return defaultBranch ?? branches.find((b) => b.isDefault);
  }, [branches, urlBranchName, defaultBranch]);

  // Get revision for the current branch
  const revision = useQuery(
    api.fs.revision.getRevisionByBranchCommit,
    currentBranch ? { branchId: currentBranch._id, commitId: currentBranch.commitId } : "skip",
  );

  const ensureRevisionFilesMaterialized = useAction(api.fs.operations.ensureMaterialized);
  const getRevisionBuildDetails = useAction(api.compile.getRevisionBuildDetails);
  const [buildDetails, setBuildDetails] = useState<RevisionBuildDetails | null>(null);
  const [buildDetailsLoading, setBuildDetailsLoading] = useState(false);
  const [buildDetailsError, setBuildDetailsError] = useState<string | null>(null);

  useEffect(() => {
    if (revision?._id) {
      ensureRevisionFilesMaterialized({ revisionId: revision._id as Id<"revisions"> }).then(
        () => {
          console.log("Revision filesystem materialized");
        },
        (e) => {
          console.error("Error materializing revision filesystem", e);
        },
      );
    }
  }, [revision?._id]);

  useEffect(() => {
    if (!workspace?._id || !revision?._id) {
      setBuildDetails(null);
      setBuildDetailsError(null);
      setBuildDetailsLoading(false);
      return;
    }

    setBuildDetailsLoading(true);
    setBuildDetailsError(null);
    getRevisionBuildDetails({
      workspaceId: workspace._id,
      revisionId: revision._id as Id<"revisions">,
    })
      .then((result) => {
        setBuildDetails(result as RevisionBuildDetails);
      })
      .catch((error) => {
        setBuildDetailsError(error instanceof Error ? error.message : "Failed to load build details");
      })
      .finally(() => {
        setBuildDetailsLoading(false);
      });
  }, [workspace?._id, revision?._id, getRevisionBuildDetails]);

  // Get revision filesystem tree
  const revisionTree = useQuery(
    api.fs.revision.getTree,
    revision ? { revisionId: revision._id as Id<"revisions"> } : "skip",
  );

  // Get selected file content
  const fileContent = useQuery(
    api.fs.revision.getContent,
    revision && selectedPath ? { revisionId: revision._id as Id<"revisions">, path: selectedPath } : "skip",
  );

  useEffect(() => {
    if (!fileContent) {
      setResolvedContent("");
      return;
    }
    if (fileContent.content !== undefined) {
      setResolvedContent(fileContent.content);
      return;
    }
    if (fileContent.downloadUrl) {
      const controller = new AbortController();
      fetch(fileContent.downloadUrl, { signal: controller.signal })
        .then((response) => {
          if (!response.ok) {
            throw new Error(`Failed to download file content (${response.status})`);
          }
          return response.text();
        })
        .then((content) => {
          setResolvedContent(content);
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          console.error("Failed to load revision file content:", error);
        });
      return () => controller.abort();
    }
    setResolvedContent("");
  }, [fileContent]);

  // Convert revision tree to FileTreeNode format
  const displayTree = useMemo((): FileTreeNode[] => {
    if (!revisionTree) return [];

    const convertNode = (node: (typeof revisionTree)[number]): FileTreeNode => ({
      name: node.name,
      path: node.path,
      type: node.type,
      status: "unchanged",
      children: node.children?.map((child) => convertNode(child as (typeof revisionTree)[number])),
    });

    return revisionTree.map(convertNode);
  }, [revisionTree]);

  const handleFileSelect = (path: string, type: "file" | "directory") => {
    if (type === "file") {
      setSelectedPath(path);
    }
  };

  if (!workspace) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-muted-foreground">Loading tokenspace...</div>
      </div>
    );
  }

  // Show message if no revision exists
  if (branches && branches.length > 0 && !revision) {
    return (
      <div className="flex flex-col flex-1 bg-background">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-6 max-w-md">
            <div className="mx-auto p-4 rounded-2xl bg-amber-500/10 border border-amber-500/20 w-fit">
              <AlertCircle className="size-12 text-amber-500" />
            </div>
            <div className="space-y-2">
              <h2 className="text-xl font-semibold">No Compiled Revision Filesystem</h2>
              <p className="text-muted-foreground">
                This tokenspace hasn't been compiled yet. Compile it from the editor to see the revision files.
              </p>
            </div>
            <Link to="/workspace/$slug/admin/editor" params={{ slug }}>
              <Button className="gap-2">
                <Package className="size-4" />
                Go to Editor
              </Button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // Show message if tokenspace has no branches
  if (branches && branches.length === 0) {
    return (
      <div className="flex flex-col flex-1 bg-background">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-6 max-w-md">
            <div className="mx-auto p-4 rounded-2xl bg-muted/50 border border-border/50 w-fit">
              <FolderOpen className="size-12 text-muted-foreground" />
            </div>
            <div className="space-y-2">
              <h2 className="text-xl font-semibold">Tokenspace Not Initialized</h2>
              <p className="text-muted-foreground">
                This tokenspace hasn't been initialized yet. Initialize it from the editor to get started.
              </p>
            </div>
            <Link to="/workspace/$slug/admin/editor" params={{ slug }}>
              <Button className="gap-2">
                <Package className="size-4" />
                Go to Editor
              </Button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const language = selectedPath ? getLanguageFromPath(selectedPath) : "plaintext";

  return (
    <div className="flex flex-col flex-1 bg-background">
      {/* Info banner */}
      <div className="px-4 py-2 bg-muted/30 border-b text-sm text-muted-foreground">
        <span>
          This view shows the compiled revision filesystem that the AI agent sees and can access. These files are
          read-only.
        </span>
      </div>

      <div className="border-b bg-muted/10 px-4 py-3">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Revision Build</div>
        {buildDetailsLoading ? (
          <div className="text-sm text-muted-foreground">Loading build details...</div>
        ) : buildDetailsError ? (
          <div className="text-sm text-destructive">{buildDetailsError}</div>
        ) : buildDetails ? (
          <div className="space-y-3">
            <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded border bg-card px-2 py-1.5">
                <span className="font-medium">Mode:</span> {buildDetails.compileMode ?? "unknown"}
              </div>
              <div className="rounded border bg-card px-2 py-1.5">
                <span className="font-medium">Compiler:</span> {buildDetails.compilerVersion ?? "unknown"}
              </div>
              <div className="rounded border bg-card px-2 py-1.5">
                <span className="font-medium">Source:</span> {shortHash(buildDetails.sourceFingerprint)}
              </div>
              <div className="rounded border bg-card px-2 py-1.5">
                <span className="font-medium">Artifact:</span> {shortHash(buildDetails.artifactFingerprint)}
              </div>
            </div>

            <div className="grid gap-2 text-xs sm:grid-cols-2">
              <div className="rounded border bg-card px-2 py-1.5">
                <span className="font-medium">Diagnostics:</span>{" "}
                {buildDetails.diagnostics?.declarationDiagnostics.length ?? 0} errors,{" "}
                {buildDetails.diagnostics?.warnings.length ?? 0} warnings
              </div>
              <div className="rounded border bg-card px-2 py-1.5">
                <span className="font-medium">Manifest schema:</span> {buildDetails.manifest?.schemaVersion ?? "n/a"}
              </div>
            </div>

            {buildDetails.diagnostics && Object.keys(buildDetails.diagnostics.timingsMs).length > 0 && (
              <div className="rounded border bg-card p-2 text-xs">
                <div className="mb-1 font-medium">Timings (ms)</div>
                <div className="grid gap-x-3 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
                  {Object.entries(buildDetails.diagnostics.timingsMs)
                    .sort((a, b) => b[1] - a[1])
                    .map(([phase, value]) => (
                      <div key={phase} className="flex items-center justify-between gap-2">
                        <span className="text-muted-foreground">{phase}</span>
                        <span className="font-mono">{value}</span>
                      </div>
                    ))}
                </div>
              </div>
            )}

            {buildDetails.diagnostics && buildDetails.diagnostics.declarationDiagnostics.length > 0 && (
              <div className="rounded border bg-card p-2 text-xs">
                <div className="mb-1 font-medium">Declaration diagnostics</div>
                <div className="space-y-1">
                  {buildDetails.diagnostics.declarationDiagnostics.slice(0, 8).map((diagnostic, index) => (
                    <div key={`${diagnostic.code}-${index}`} className="rounded border bg-muted/30 px-2 py-1">
                      <span className="font-mono text-[10px] text-muted-foreground">
                        TS{diagnostic.code}
                        {diagnostic.file ? ` ${diagnostic.file}` : ""}
                        {diagnostic.line !== undefined || diagnostic.column !== undefined
                          ? ` (${diagnostic.line ?? "?"}:${diagnostic.column ?? "?"})`
                          : ""}
                      </span>{" "}
                      {diagnostic.message}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">No build metadata available for this revision.</div>
        )}
      </div>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* File tree sidebar */}
        <div className="w-64 border-r bg-card flex flex-col">
          <div className="flex items-center justify-between px-4 py-2 border-b">
            <span className="text-sm font-medium">Revision Files</span>
            <span className="text-xs text-muted-foreground">{displayTree.length > 0 ? "Read-only" : ""}</span>
          </div>
          <ScrollArea className="flex-1">
            {displayTree.length > 0 ? (
              <FileTree nodes={displayTree} selectedPath={selectedPath ?? undefined} onSelect={handleFileSelect} />
            ) : (
              <div className="px-4 py-8 text-center text-muted-foreground text-sm">
                {revisionTree === undefined ? "Loading..." : "No revision files"}
              </div>
            )}
          </ScrollArea>
        </div>

        {/* Editor */}
        <div className="flex-1 flex flex-col">
          {selectedPath ? (
            <>
              <div className="px-4 py-2 border-b bg-muted/30 flex items-center justify-between">
                <span className="text-sm font-mono text-muted-foreground">{selectedPath}</span>
                <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">Read-only</span>
              </div>
              <div className="flex-1">
                {fileContent === undefined ? (
                  <div className="flex items-center justify-center h-full text-muted-foreground">Loading file...</div>
                ) : fileContent === null ? (
                  <div className="flex items-center justify-center h-full text-muted-foreground">File not found</div>
                ) : (
                  <Editor
                    height="100%"
                    width="100%"
                    language={language}
                    path={`file:///${selectedPath}`}
                    value={resolvedContent}
                    theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
                    options={{
                      readOnly: true,
                      minimap: { enabled: false },
                      fontSize: 14,
                      fontFamily: "JetBrains Mono, Menlo, Monaco, Consolas, monospace",
                      lineNumbers: "on",
                      scrollBeyondLastLine: false,
                      automaticLayout: true,
                      tabSize: 2,
                      padding: { top: 16, bottom: 16 },
                      renderLineHighlight: "line",
                      cursorBlinking: "smooth",
                      smoothScrolling: true,
                      wordWrap: language === "markdown" ? "on" : "off",
                    }}
                  />
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
              <Package className="size-16 mb-4 opacity-20" />
              <p>Select a file to view its contents</p>
              <p className="text-sm mt-2 text-muted-foreground/60">These are the files the AI agent can read and use</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
