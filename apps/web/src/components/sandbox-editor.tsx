import Editor, { type Monaco, type OnMount } from "@monaco-editor/react";
import { SANDBOX_TYPES } from "@tokenspace/types";
import { useCallback, useEffect, useRef } from "react";
import { useTheme } from "@/lib/theme";

type Language = "typescript" | "bash";

interface SandboxEditorProps {
  value: string;
  onChange: (value: string | undefined) => void;
  height?: string;
  width?: string;
  language?: Language;
  typeDefinitions?: { fileName: string; content: string }[];
  onRunShortcut?: () => void;
}

export function SandboxEditor({
  value,
  onChange,
  height = "100%",
  width = "100%",
  language = "typescript",
  typeDefinitions = [],
  onRunShortcut,
}: SandboxEditorProps) {
  const monacoRef = useRef<Monaco | null>(null);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const onRunShortcutRef = useRef(onRunShortcut);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    onRunShortcutRef.current = onRunShortcut;
  }, [onRunShortcut]);

  const handleBeforeMount = useCallback((monaco: Monaco) => {
    monacoRef.current = monaco;

    // Configure TypeScript compiler options for top-level await support
    monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ESNext,
      module: monaco.languages.typescript.ModuleKind.ESNext,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      // Force all files to be treated as modules (enables top-level await without needing imports/exports)
      // moduleDetection: 3 = "force" in TypeScript's ModuleDetectionKind enum
      moduleDetection: 3,
      allowNonTsExtensions: true,
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      isolatedModules: true,
      // Disable default libs (DOM, etc.) - we provide our own minimal lib via SANDBOX_TYPES
      noLib: true,
    });

    // Disable the default lib (we provide our own minimal lib)
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: false,
    });

    // Add the sandbox type definitions as an extra lib
    // The filename must end with .d.ts for it to be recognized as a declaration file
    monaco.languages.typescript.typescriptDefaults.addExtraLib(SANDBOX_TYPES, "file:///sandbox.d.ts");

    for (const { fileName, content } of typeDefinitions) {
      console.log("Adding type definition:", fileName);
      monaco.languages.typescript.typescriptDefaults.addExtraLib(content, `file:///${fileName}`);
    }
  }, []);

  const handleMount: OnMount = useCallback(
    (_editor, monaco) => {
      editorRef.current = _editor;
      // Ensure the model is treated as a module by setting the filename
      // This is needed for top-level await to work properly
      const model = _editor.getModel();
      if (model) {
        // The file:// URI scheme helps Monaco understand this is a file
        monaco.editor.setModelLanguage(model, language === "bash" ? "shell" : "typescript");
      }

      // Execute from editor focus with Cmd/Ctrl+Enter.
      _editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
        onRunShortcutRef.current?.();
      });
    },
    [language],
  );

  // Update language when it changes
  useEffect(() => {
    if (editorRef.current && monacoRef.current) {
      const model = editorRef.current.getModel();
      if (model) {
        monacoRef.current.editor.setModelLanguage(model, language === "bash" ? "shell" : "typescript");
      }
    }
  }, [language]);

  const monacoLanguage = language === "bash" ? "shell" : "typescript";
  const defaultPath = language === "bash" ? "file:///script.sh" : "file:///main.ts";

  return (
    <Editor
      height={height}
      width={width}
      language={monacoLanguage}
      path={defaultPath}
      value={value}
      onChange={onChange}
      theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
      beforeMount={handleBeforeMount}
      onMount={handleMount}
      options={{
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
      }}
    />
  );
}
