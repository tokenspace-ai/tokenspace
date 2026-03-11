import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import type { FileUIPart } from "ai";

const DEFAULT_UPLOAD_DIR = "uploads";
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;

const TEXT_MIME_HINTS = ["json", "xml", "yaml", "yml", "csv", "markdown", "toml", "javascript", "typescript"];
const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "json",
  "yaml",
  "yml",
  "toml",
  "xml",
  "html",
  "htm",
  "css",
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "mdx",
  "sql",
  "sh",
  "bash",
  "zsh",
  "env",
  "ini",
  "log",
]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif"]);

export type UploadedFileInfo = {
  displayPath: string;
  storagePath: string;
  mediaType?: string;
  size: number;
};

type UploadMetadata =
  | { kind: "inline" }
  | { kind: "existing"; blobId: Id<"blobs"> }
  | { kind: "upload"; uploadUrl: string };

type GetUploadMetadata = (args: {
  sessionId: Id<"sessions">;
  hash: string;
  size: number;
  binary: boolean;
}) => Promise<UploadMetadata>;

type WriteFile = (args: {
  sessionId: Id<"sessions">;
  path: string;
  content?: string;
  blobId?: Id<"blobs">;
  storageId?: Id<"_storage">;
  hash?: string;
  size?: number;
  binary: boolean;
}) => Promise<unknown>;

export async function uploadPromptInputFiles({
  sessionId,
  files,
  getUploadMetadata,
  writeFile,
  uploadDir = DEFAULT_UPLOAD_DIR,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
}: {
  sessionId: Id<"sessions">;
  files: FileUIPart[];
  getUploadMetadata: GetUploadMetadata;
  writeFile: WriteFile;
  uploadDir?: string;
  maxFileBytes?: number;
}): Promise<UploadedFileInfo[]> {
  if (!files.length) return [];

  const normalizedDir = uploadDir.replace(/^\/+/, "").replace(/\/+$/, "") || DEFAULT_UPLOAD_DIR;
  const usedNames = new Set<string>();
  const uploaded: UploadedFileInfo[] = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const fallbackName = `attachment-${index + 1}`;
    const rawName = file.filename?.trim() || fallbackName;
    const safeName = ensureUniqueName(sanitizeFilename(rawName, fallbackName), usedNames);

    const { bytes, mediaType: parsedMediaType } = await readFileBytes(file);
    if (bytes.length > maxFileBytes) {
      throw new Error(`"${safeName}" exceeds the ${formatBytes(maxFileBytes)} upload limit.`);
    }

    const mediaType = parsedMediaType || file.mediaType || undefined;
    const ext = getFileExtension(safeName);
    const isBinary = resolveBinaryFlag({ mediaType, extension: ext });

    const hash = await hashBytes(bytes);
    const size = bytes.length;
    const storagePath = `${normalizedDir}/${safeName}`;
    const displayPath = `/sandbox/${storagePath}`;

    const metadata = await getUploadMetadata({ sessionId, hash, size, binary: isBinary });

    if (metadata.kind === "existing") {
      await writeFile({ sessionId, path: storagePath, blobId: metadata.blobId, binary: isBinary });
    } else if (metadata.kind === "inline") {
      if (isBinary) {
        throw new Error(`Inline upload not supported for binary file "${safeName}".`);
      }
      const content = new TextDecoder("utf-8").decode(bytes);
      await writeFile({ sessionId, path: storagePath, content, binary: false });
    } else {
      const storageId = await uploadToStorage(metadata.uploadUrl, bytes, isBinary);
      await writeFile({ sessionId, path: storagePath, storageId, hash, size, binary: isBinary });
    }

    uploaded.push({
      displayPath,
      storagePath,
      mediaType,
      size,
    });
  }

  return uploaded;
}

export function appendUploadedFilesToPrompt(prompt: string, files: UploadedFileInfo[]): string {
  if (!files.length) return prompt;

  const lines = ["<uploaded_files>"];
  for (const file of files) {
    const mime = file.mediaType || "application/octet-stream";
    lines.push(`- ${file.displayPath} (${mime}, ${formatBytes(file.size)})`);
  }
  lines.push("</uploaded_files>");

  const block = lines.join("\n");
  const trimmed = prompt.trimEnd();
  if (!trimmed) return block;
  return `${trimmed}\n\n${block}`;
}

export type ParsedUploadedFile = {
  path: string;
  filename: string;
  mediaType: string;
  size: string;
};

export type ParsedMessageWithFiles = {
  textWithoutBlock: string;
  files: ParsedUploadedFile[];
};

const UPLOADED_FILES_BLOCK_REGEX = /<uploaded_files>\n([\s\S]*?)\n<\/uploaded_files>/;
const UPLOADED_FILE_LINE_REGEX = /^- (\/sandbox\/[^\s]+) \(([^,]+), ([^)]+)\)$/;

export function parseUploadedFilesFromMessage(text: string): ParsedMessageWithFiles {
  const match = UPLOADED_FILES_BLOCK_REGEX.exec(text);
  if (!match) {
    return { textWithoutBlock: text, files: [] };
  }

  const blockContent = match[1];
  const files: ParsedUploadedFile[] = [];

  for (const line of blockContent.split("\n")) {
    const lineMatch = UPLOADED_FILE_LINE_REGEX.exec(line.trim());
    if (lineMatch) {
      const path = lineMatch[1];
      const filename = path.split("/").pop() ?? path;
      files.push({
        path,
        filename,
        mediaType: lineMatch[2],
        size: lineMatch[3],
      });
    }
  }

  const textWithoutBlock = text.replace(UPLOADED_FILES_BLOCK_REGEX, "").trimEnd();
  return { textWithoutBlock, files };
}

function sanitizeFilename(name: string, fallback: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\\/]/g, "_").replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return fallback;
  }
  return cleaned;
}

function ensureUniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }

  const lastDot = name.lastIndexOf(".");
  const stem = lastDot > 0 ? name.slice(0, lastDot) : name;
  const ext = lastDot > 0 ? name.slice(lastDot) : "";

  let counter = 2;
  let candidate = `${stem}-${counter}${ext}`;
  while (used.has(candidate)) {
    counter += 1;
    candidate = `${stem}-${counter}${ext}`;
  }
  used.add(candidate);
  return candidate;
}

function getFileExtension(filename: string): string {
  const parts = filename.toLowerCase().split(".");
  if (parts.length < 2) return "";
  return parts.pop() ?? "";
}

function resolveBinaryFlag({ mediaType, extension }: { mediaType?: string; extension: string }): boolean {
  if (mediaType?.startsWith("image/")) return true;
  if (mediaType?.startsWith("text/")) return false;
  if (mediaType?.startsWith("application/")) {
    if (TEXT_MIME_HINTS.some((hint) => mediaType.includes(hint))) return false;
  }
  if (IMAGE_EXTENSIONS.has(extension)) return true;
  if (TEXT_EXTENSIONS.has(extension)) return false;
  return true;
}

async function readFileBytes(file: FileUIPart): Promise<{ bytes: Uint8Array; mediaType?: string }> {
  const url = file.url;
  if (!url) {
    throw new Error("Attachment is missing a file URL.");
  }

  if (url.startsWith("data:")) {
    const parsed = parseDataUrl(url);
    return {
      bytes: parsed.bytes,
      mediaType: parsed.mediaType || file.mediaType || undefined,
    };
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to read attachment (${response.status})`);
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  const mediaType = response.headers.get("content-type") || file.mediaType || undefined;
  return { bytes: buffer, mediaType };
}

function parseDataUrl(dataUrl: string): { bytes: Uint8Array; mediaType?: string } {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/i.exec(dataUrl);
  if (!match) {
    throw new Error("Invalid attachment data URL.");
  }
  const mediaType = match[1] || undefined;
  const isBase64 = Boolean(match[2]);
  const data = match[3] ?? "";

  if (isBase64) {
    return { bytes: base64ToBytes(data), mediaType };
  }

  const text = decodeURIComponent(data);
  return { bytes: new TextEncoder().encode(text), mediaType };
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", bytes.slice().buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  throw new Error("Web Crypto is unavailable for hashing uploads.");
}

async function uploadToStorage(uploadUrl: string, data: Uint8Array, binary: boolean): Promise<Id<"_storage">> {
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Type": binary ? "application/octet-stream" : "text/plain; charset=utf-8",
    },
    body: data.slice().buffer,
  });
  if (!response.ok) {
    throw new Error(`Failed to upload file content (${response.status})`);
  }
  const payload = (await response.json()) as { storageId?: string };
  if (!payload.storageId) {
    throw new Error("Upload response missing storageId");
  }
  return payload.storageId as Id<"_storage">;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)}MB`;
}
