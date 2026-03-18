import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { useEffect, useMemo, useState } from "react";
import { useAccessToken } from "@/hooks/use-access-token";
import { buildWorkspaceFileUrl } from "@/lib/workspace-files";
import { WorkspaceIcon } from "./workspace-icon";

type WorkspaceFileIconProps = {
  name: string;
  filePath?: string | null;
  sessionId?: Id<"sessions"> | null;
  revisionId?: Id<"revisions"> | null;
  className?: string;
  imageClassName?: string;
  fallbackClassName?: string;
};

export function WorkspaceFileIcon({
  name,
  filePath,
  sessionId,
  revisionId,
  className,
  imageClassName,
  fallbackClassName,
}: WorkspaceFileIconProps) {
  const { getAccessToken } = useAccessToken();
  const [iconUrl, setIconUrl] = useState<string | null>(null);

  const fileUrl = useMemo(() => {
    if (!filePath) {
      return null;
    }
    if (sessionId) {
      return buildWorkspaceFileUrl({ path: filePath, sessionId });
    }
    if (revisionId) {
      return buildWorkspaceFileUrl({ path: filePath, revisionId });
    }
    return null;
  }, [filePath, sessionId, revisionId]);

  useEffect(() => {
    if (!fileUrl) {
      setIconUrl(null);
      return;
    }

    let active = true;
    let objectUrl: string | null = null;
    const abortController = new AbortController();

    void (async () => {
      try {
        const accessToken = await getAccessToken();
        if (!accessToken) {
          if (active) {
            setIconUrl(null);
          }
          return;
        }

        const response = await fetch(fileUrl, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          signal: abortController.signal,
        });
        if (!response.ok) {
          throw new Error(`Failed to fetch workspace file icon (${response.status})`);
        }

        objectUrl = URL.createObjectURL(await response.blob());
        if (active) {
          setIconUrl(objectUrl);
        }
      } catch (error) {
        if (!abortController.signal.aborted) {
          console.error("Failed to load workspace file icon:", error);
          if (active) {
            setIconUrl(null);
          }
        }
      }
    })();

    return () => {
      active = false;
      abortController.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [fileUrl, getAccessToken]);

  return (
    <WorkspaceIcon
      name={name}
      iconUrl={iconUrl}
      className={className}
      imageClassName={imageClassName}
      fallbackClassName={fallbackClassName}
    />
  );
}
