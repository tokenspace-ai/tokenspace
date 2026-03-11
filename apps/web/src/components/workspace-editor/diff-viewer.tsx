import { DiffEditor, type Monaco } from "@monaco-editor/react";
import { Columns2, Rows2 } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

interface DiffViewerProps {
  /** Base version content (left side) */
  original: string;
  /** New version content (right side) */
  modified: string;
  /** File path for language detection */
  filePath: string;
  /** Label for original version (e.g., "HEAD", "commit abc123") */
  originalLabel?: string;
  /** Label for modified version (e.g., "Working Copy") */
  modifiedLabel?: string;
  /** Initial render mode - true for side-by-side, false for inline */
  initialSideBySide?: boolean;
  /** Show the toggle button for switching between inline/side-by-side */
  showModeToggle?: boolean;
  /** Additional class name for the container */
  className?: string;
}

function getLanguageFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
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

export function DiffViewer({
  original,
  modified,
  filePath,
  originalLabel = "Original",
  modifiedLabel = "Modified",
  initialSideBySide = true,
  showModeToggle = true,
  className,
}: DiffViewerProps) {
  const [renderSideBySide, setRenderSideBySide] = useState(initialSideBySide);
  const language = getLanguageFromPath(filePath);
  const { resolvedTheme } = useTheme();

  const handleBeforeMount = useCallback((monaco: Monaco) => {
    monaco.editor.defineTheme("diff-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "diffEditor.insertedTextBackground": "#23d18b20",
        "diffEditor.removedTextBackground": "#f14c4c20",
        "diffEditor.insertedLineBackground": "#23d18b15",
        "diffEditor.removedLineBackground": "#f14c4c15",
      },
    });
    monaco.editor.defineTheme("diff-light", {
      base: "vs",
      inherit: true,
      rules: [],
      colors: {
        "diffEditor.insertedTextBackground": "#23d18b30",
        "diffEditor.removedTextBackground": "#f14c4c30",
        "diffEditor.insertedLineBackground": "#23d18b18",
        "diffEditor.removedLineBackground": "#f14c4c18",
      },
    });
  }, []);

  return (
    <div className={cn("flex flex-col h-full", className)}>
      {/* Header with labels and toggle */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30">
        <div className="flex items-center gap-4 text-sm">
          <span className="text-muted-foreground">
            <span className="font-medium text-red-400">{originalLabel}</span>
            <span className="mx-2">→</span>
            <span className="font-medium text-green-400">{modifiedLabel}</span>
          </span>
          <span className="font-mono text-xs text-muted-foreground">{filePath}</span>
        </div>
        {showModeToggle && (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className={cn("h-7 px-2", renderSideBySide && "bg-accent")}
              onClick={() => setRenderSideBySide(true)}
              title="Side by side"
            >
              <Columns2 className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={cn("h-7 px-2", !renderSideBySide && "bg-accent")}
              onClick={() => setRenderSideBySide(false)}
              title="Inline"
            >
              <Rows2 className="size-4" />
            </Button>
          </div>
        )}
      </div>

      {/* Diff Editor */}
      <div className="flex-1">
        <DiffEditor
          original={original}
          modified={modified}
          language={language}
          theme={resolvedTheme === "dark" ? "diff-dark" : "diff-light"}
          beforeMount={handleBeforeMount}
          options={{
            readOnly: true,
            renderSideBySide,
            originalEditable: false,
            minimap: { enabled: false },
            fontSize: 14,
            fontFamily: "JetBrains Mono, Menlo, Monaco, Consolas, monospace",
            lineNumbers: "on",
            scrollBeyondLastLine: false,
            automaticLayout: true,
            padding: { top: 8, bottom: 8 },
            renderIndicators: true,
            ignoreTrimWhitespace: false,
            renderOverviewRuler: true,
            diffWordWrap: language === "markdown" ? "on" : "off",
          }}
        />
      </div>
    </div>
  );
}
