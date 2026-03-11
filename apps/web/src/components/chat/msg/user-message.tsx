import type { TextUIPart, UIDataTypes, UIMessage } from "ai";
import { PaperclipIcon } from "lucide-react";
import { useMemo } from "react";
import { type ParsedUploadedFile, parseUploadedFilesFromMessage } from "@/lib/session-file-uploads";
import type { AgentTools } from "./tools/types";

export function UserMessageContent({ message }: { message: UIMessage<unknown, UIDataTypes, AgentTools> }) {
  const fullText = message.parts
    .filter((part): part is TextUIPart => part.type === "text")
    .map((part) => part.text)
    .join("");

  const { textWithoutBlock, files } = useMemo(() => parseUploadedFilesFromMessage(fullText), [fullText]);

  return (
    <div className="flex flex-col gap-2">
      {textWithoutBlock && <span className="whitespace-pre-wrap">{textWithoutBlock}</span>}
      {files.length > 0 && <UploadedFilesList files={files} />}
    </div>
  );
}

function UploadedFilesList({ files }: { files: ParsedUploadedFile[] }) {
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      {files.map((file, index) => (
        <div key={index} className="flex items-center gap-2 rounded-md bg-background/50 px-2.5 py-1.5 text-xs">
          <PaperclipIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium truncate max-w-[150px]" title={file.path}>
            {file.filename}
          </span>
          <span className="text-muted-foreground shrink-0">{file.size}</span>
        </div>
      ))}
    </div>
  );
}
