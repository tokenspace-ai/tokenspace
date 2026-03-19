import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { useEffect, useMemo, useRef, useState } from "react";
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
  const objectUrlRef = useRef<string | null>(null);

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
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
      setIconUrl(null);
      return;
    }

    let active = true;
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

        const nextObjectUrl = URL.createObjectURL(await response.blob());
        if (active) {
          if (objectUrlRef.current) {
            URL.revokeObjectURL(objectUrlRef.current);
          }
          objectUrlRef.current = nextObjectUrl;
          setIconUrl(nextObjectUrl);
        } else {
          URL.revokeObjectURL(nextObjectUrl);
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
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
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
