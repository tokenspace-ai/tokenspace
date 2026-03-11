import type { FileUIPart, UIDataTypes, UIMessage } from "ai";

type AgentTools = any;

function createOptimisticMessageId() {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `optimistic-${suffix}`;
}

function sanitizeAttachmentName(filename: string, fallback: string) {
  const base = filename.trim().split(/[\\/]/).pop() || fallback;
  return base.replace(/\s+/g, "-");
}

function createOptimisticUploadedFilesBlock(files: FileUIPart[]) {
  if (files.length === 0) {
    return "";
  }

  const lines = ["<uploaded_files>"];
  for (const [index, file] of files.entries()) {
    const filename = sanitizeAttachmentName(file.filename || "", `attachment-${index + 1}`);
    const mediaType = file.mediaType || "application/octet-stream";
    lines.push(`- /sandbox/uploads/${filename} (${mediaType}, uploading...)`);
  }
  lines.push("</uploaded_files>");
  return lines.join("\n");
}

export function createOptimisticPrompt(text: string, files: FileUIPart[]) {
  const message = text.trimEnd();
  const uploadedFilesBlock = createOptimisticUploadedFilesBlock(files);

  if (!uploadedFilesBlock) {
    return message;
  }

  if (!message) {
    return uploadedFilesBlock;
  }

  return `${message}\n\n${uploadedFilesBlock}`;
}

export function createOptimisticUserMessage({
  text,
  files,
}: {
  text: string;
  files: FileUIPart[];
}): UIMessage<unknown, UIDataTypes, AgentTools> {
  return createOptimisticUserMessageFromPrompt(createOptimisticPrompt(text, files));
}

export function createOptimisticUserMessageFromPrompt(prompt: string): UIMessage<unknown, UIDataTypes, AgentTools> {
  return {
    id: createOptimisticMessageId(),
    role: "user",
    parts: [{ type: "text", text: prompt }],
  };
}
