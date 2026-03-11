import Editor from "@monaco-editor/react";
import { FileIcon } from "lucide-react";
import { useMemo } from "react";
import { useTheme } from "@/lib/theme";

interface FileViewerProps {
  path: string | null;
  content: string | null;
  isLoading?: boolean;
}

/**
 * Get Monaco language from file extension.
 */
function getLanguageFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();

  const languageMap: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    md: "markdown",
    css: "css",
    scss: "scss",
    html: "html",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    sql: "sql",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    txt: "plaintext",
  };

  return languageMap[ext ?? ""] ?? "plaintext";
}

export function FileViewer({ path, content, isLoading }: FileViewerProps) {
  const language = useMemo(() => (path ? getLanguageFromPath(path) : "plaintext"), [path]);
  const { resolvedTheme } = useTheme();

  if (!path) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <FileIcon className="size-12 opacity-50" />
        <p className="text-sm">Select a file to view its contents</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (content === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <FileIcon className="size-12 opacity-50" />
        <p className="text-sm">File not found</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b bg-muted/30 px-4 py-2">
        <span className="font-mono text-sm text-muted-foreground">{path}</span>
      </div>
      <div className="flex-1">
        <Editor
          height="100%"
          language={language}
          value={content}
          theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
          options={{
            readOnly: true,
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: "on",
            scrollBeyondLastLine: false,
            wordWrap: "on",
            automaticLayout: true,
            padding: { top: 8, bottom: 8 },
            renderLineHighlight: "none",
            selectionHighlight: false,
            occurrencesHighlight: "off",
          }}
        />
      </div>
    </div>
  );
}
