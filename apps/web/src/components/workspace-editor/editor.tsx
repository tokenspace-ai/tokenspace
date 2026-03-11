import Editor, { type Monaco, type OnMount } from "@monaco-editor/react";
import { SANDBOX_TYPES } from "@tokenspace/types";
import { useCallback, useEffect, useRef } from "react";
import { useTheme } from "@/lib/theme";

interface WorkspaceEditorProps {
  value: string;
  onChange: (value: string | undefined) => void;
  filePath: string;
  typeDefinitions?: { fileName: string; content: string }[];
  readOnly?: boolean;
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

export function WorkspaceEditor({
  value,
  onChange,
  filePath,
  typeDefinitions = [],
  readOnly = false,
}: WorkspaceEditorProps) {
  const monacoRef = useRef<Monaco | null>(null);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const language = getLanguageFromPath(filePath);
  const isTypeScript = language === "typescript" || language === "javascript";
  const { resolvedTheme } = useTheme();

  const handleBeforeMount = useCallback(
    (monaco: Monaco) => {
      monacoRef.current = monaco;

      if (isTypeScript) {
        // Configure TypeScript compiler options
        monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
          target: monaco.languages.typescript.ScriptTarget.ESNext,
          module: monaco.languages.typescript.ModuleKind.ESNext,
          moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
          moduleDetection: 3, // Force module detection
          allowNonTsExtensions: true,
          strict: true,
          noEmit: true,
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          isolatedModules: true,
          noLib: true,
        });

        monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
          noSemanticValidation: false,
          noSyntaxValidation: false,
        });

        // Add sandbox type definitions
        monaco.languages.typescript.typescriptDefaults.addExtraLib(SANDBOX_TYPES, "file:///sandbox.d.ts");

        // Add workspace type definitions
        for (const { fileName, content } of typeDefinitions) {
          monaco.languages.typescript.typescriptDefaults.addExtraLib(content, `file:///${fileName}`);
        }
      }
    },
    [isTypeScript, typeDefinitions],
  );

  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;

      // Ensure proper language detection
      const model = editor.getModel();
      if (model) {
        monaco.editor.setModelLanguage(model, language);
      }
    },
    [language],
  );

  // Update model when filePath changes
  useEffect(() => {
    if (editorRef.current && monacoRef.current) {
      const model = editorRef.current.getModel();
      if (model) {
        monacoRef.current.editor.setModelLanguage(model, language);
      }
    }
  }, [filePath, language]);

  return (
    <Editor
      height="100%"
      width="100%"
      language={language}
      path={`file:///${filePath}`}
      value={value}
      onChange={onChange}
      theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
      beforeMount={handleBeforeMount}
      onMount={handleMount}
      options={{
        readOnly,
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
  );
}
