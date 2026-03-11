"use client";

import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import { CopyIcon, DownloadIcon, FileIcon, FileTextIcon, ImageIcon, Loader2Icon, XIcon } from "lucide-react";
import { useMemo } from "react";
import type { BundledLanguage } from "shiki";
import { CodeBlock, CodeBlockCopyButton } from "@/components/ai-elements/code-block";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

// File extension to Shiki language mapping
const EXTENSION_TO_LANGUAGE: Record<string, BundledLanguage> = {
  // JavaScript/TypeScript
  js: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  mjs: "javascript",
  cjs: "javascript",
  mts: "typescript",
  cts: "typescript",

  // Web
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  vue: "vue",
  svelte: "svelte",

  // Data formats
  json: "json",
  jsonc: "jsonc",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  csv: "csv",

  // Config files
  env: "dotenv",
  ini: "ini",

  // Shell
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  ps1: "powershell",
  bat: "batch",
  cmd: "batch",

  // Programming languages
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  cs: "csharp",
  fs: "fsharp",
  swift: "swift",
  m: "objective-c",
  mm: "objective-cpp",
  php: "php",
  pl: "perl",
  lua: "lua",
  r: "r",
  jl: "julia",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hrl: "erlang",
  clj: "clojure",
  cljs: "clojure",
  hs: "haskell",
  ml: "ocaml",
  mli: "ocaml",
  nim: "nim",
  zig: "zig",
  v: "v",
  d: "d",
  dart: "dart",
  groovy: "groovy",
  gradle: "groovy",

  // Markup/Documentation
  md: "markdown",
  mdx: "mdx",
  rst: "rst",
  tex: "latex",
  latex: "latex",

  // Database
  sql: "sql",
  prisma: "prisma",
  graphql: "graphql",
  gql: "graphql",

  // DevOps/Config
  dockerfile: "dockerfile",
  tf: "terraform",
  hcl: "hcl",
  nginx: "nginx",

  // Other
  makefile: "makefile",
  cmake: "cmake",
  diff: "diff",
  patch: "diff",
  log: "log",
  asm: "asm",
  wasm: "wasm",
  proto: "protobuf",
  glsl: "glsl",
  hlsl: "hlsl",
  wgsl: "wgsl",
  astro: "astro",
};

// Image extensions
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif"]);

// Binary file extensions (non-viewable)
const BINARY_EXTENSIONS = new Set([
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "zip",
  "tar",
  "gz",
  "rar",
  "7z",
  "exe",
  "dll",
  "so",
  "dylib",
  "bin",
  "dat",
  "db",
  "sqlite",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "mp3",
  "mp4",
  "wav",
  "ogg",
  "webm",
  "avi",
  "mov",
  "mkv",
]);

function getFileExtension(path: string): string {
  const filename = path.split("/").pop() ?? "";

  // Handle special filenames without extensions
  const lowerFilename = filename.toLowerCase();
  if (lowerFilename === "dockerfile") return "dockerfile";
  if (lowerFilename === "makefile") return "makefile";
  if (lowerFilename === ".gitignore") return "gitignore";
  if (lowerFilename === ".dockerignore") return "dockerignore";
  if (lowerFilename === ".env" || lowerFilename.startsWith(".env.")) return "env";

  const parts = filename.split(".");
  if (parts.length < 2) return "";
  return parts.pop()?.toLowerCase() ?? "";
}

function getLanguageFromPath(path: string): BundledLanguage | null {
  const ext = getFileExtension(path);
  return EXTENSION_TO_LANGUAGE[ext] ?? null;
}

function isImageFile(path: string): boolean {
  const ext = getFileExtension(path);
  return IMAGE_EXTENSIONS.has(ext);
}

function isBinaryFile(path: string): boolean {
  const ext = getFileExtension(path);
  return BINARY_EXTENSIONS.has(ext);
}

type FilePreviewProps = {
  sessionId: Id<"sessions">;
  path: string;
  onClose: () => void;
  className?: string;
};

export function FilePreview({ sessionId, path, onClose, className }: FilePreviewProps) {
  const file = useQuery(api.fs.overlay.readFile, { sessionId, path });
  const filename = path.split("/").pop() ?? path;

  const fileType = useMemo(() => {
    if (isImageFile(path)) return "image";
    if (isBinaryFile(path)) return "binary";
    return "text";
  }, [path]);

  const language = useMemo(() => getLanguageFromPath(path), [path]);
  const canDownload = Boolean(file && (file.downloadUrl || file.content !== undefined));

  const handleDownload = () => {
    if (!file) return;

    if (file.downloadUrl) {
      const link = document.createElement("a");
      link.href = file.downloadUrl;
      link.download = filename;
      link.rel = "noopener";
      link.target = "_blank";
      link.click();
      return;
    }

    if (file.content !== undefined) {
      const blob = new Blob([file.content], { type: "text/plain;charset=utf-8" });
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = filename;
      link.rel = "noopener";
      link.click();
      URL.revokeObjectURL(blobUrl);
    }
  };

  return (
    <div className={cn("flex flex-col border-t border-border/40", className)}>
      {/* Header */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/40 bg-muted/30 px-3">
        <div className="flex items-center gap-2 min-w-0">
          {fileType === "image" ? (
            <ImageIcon className="size-4 shrink-0 text-muted-foreground" />
          ) : fileType === "binary" ? (
            <FileIcon className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="text-xs font-medium truncate" title={path}>
            {filename}
          </span>
          {language && (
            <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0">
              {language}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="icon-sm" onClick={handleDownload} disabled={!canDownload} title="Download">
            <DownloadIcon className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onClose} className="shrink-0">
            <XIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {file === undefined ? (
          <div className="flex items-center justify-center h-full py-8">
            <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : file === null ? (
          <div className="flex flex-col items-center justify-center h-full py-8 text-center px-4">
            <FileIcon className="size-8 text-muted-foreground/50" />
            <p className="mt-2 text-sm text-muted-foreground">File not found</p>
          </div>
        ) : fileType === "binary" ? (
          <div className="flex flex-col items-center justify-center h-full py-8 text-center px-4">
            <FileIcon className="size-8 text-muted-foreground/50" />
            <p className="mt-2 text-sm text-muted-foreground">Binary file cannot be previewed</p>
            <p className="text-xs text-muted-foreground/70 mt-1">{filename}</p>
          </div>
        ) : fileType === "image" ? (
          <ImagePreview file={file} filename={filename} />
        ) : (
          <TextPreview file={file} language={language} />
        )}
      </div>
    </div>
  );
}

function ImagePreview({
  file,
  filename,
}: {
  file: { content?: string; downloadUrl?: string; binary: boolean };
  filename: string;
}) {
  // For images, we need the download URL
  if (!file.downloadUrl) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-8 text-center px-4">
        <ImageIcon className="size-8 text-muted-foreground/50" />
        <p className="mt-2 text-sm text-muted-foreground">Image cannot be loaded</p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex items-center justify-center p-4">
        <img
          src={file.downloadUrl}
          alt={filename}
          className="max-w-full max-h-[400px] object-contain rounded border border-border/40"
        />
      </div>
    </ScrollArea>
  );
}

function TextPreview({
  file,
  language,
}: {
  file: { content?: string; downloadUrl?: string; binary: boolean };
  language: BundledLanguage | null;
}) {
  const content = file.content ?? "";

  // If it's marked as binary but we're trying to show as text, show a warning
  if (file.binary && !file.content) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-8 text-center px-4">
        <FileIcon className="size-8 text-muted-foreground/50" />
        <p className="mt-2 text-sm text-muted-foreground">Binary file cannot be previewed as text</p>
      </div>
    );
  }

  // Empty file
  if (!content) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-8 text-center px-4">
        <FileTextIcon className="size-8 text-muted-foreground/50" />
        <p className="mt-2 text-sm text-muted-foreground">File is empty</p>
      </div>
    );
  }

  // Use syntax highlighting if we have a language
  if (language) {
    return (
      <ScrollArea className="h-full">
        <CodeBlock code={content} language={language} showLineNumbers fontSize="xs" className="rounded-none border-0">
          <CodeBlockCopyButton className="size-7" />
        </CodeBlock>
      </ScrollArea>
    );
  }

  // Plain text fallback
  return (
    <ScrollArea className="h-full">
      <div className="relative">
        <pre className="p-4 text-xs font-mono whitespace-pre-wrap break-all">{content}</pre>
        <div className="absolute top-2 right-2">
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7"
            onClick={() => navigator.clipboard.writeText(content)}
            title="Copy to clipboard"
          >
            <CopyIcon className="size-3.5" />
          </Button>
        </div>
      </div>
    </ScrollArea>
  );
}
