import os from "node:os";
import { DEFAULT_WEB_APP_URL, getStoredWebAppUrl } from "./auth.js";

export function getAppUrl(): string {
  return getStoredWebAppUrl() ?? DEFAULT_WEB_APP_URL;
}

export function buildRevisionUrl(workspaceSlug: string, revisionId: string): string {
  return `${getAppUrl()}/workspace/${workspaceSlug}@${revisionId}/playground`;
}

export function buildChatUrl(workspaceSlug: string, chatId: string): string {
  return `${getAppUrl()}/workspace/${workspaceSlug}/chat/${chatId}`;
}

export async function openUrl(url: string): Promise<void> {
  const platform = os.platform();
  const command =
    platform === "darwin" ? ["open", url] : platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];

  const proc = Bun.spawn(command, {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Failed to open ${url}`);
  }
}
