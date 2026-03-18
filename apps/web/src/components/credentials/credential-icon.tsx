import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { WorkspaceIcon } from "@/components/workspace-icon";
import { useAccessToken } from "@/hooks/use-access-token";
import { buildWorkspaceFileUrl } from "@/lib/workspace-files";

type CredentialIdentityProps = {
  name: string;
  iconPath?: string | null;
  sessionId?: Id<"sessions"> | null;
  revisionId?: Id<"revisions"> | null;
  className?: string;
  imageClassName?: string;
  fallbackClassName?: string;
};

export function CredentialIcon({
  name,
  iconPath,
  sessionId,
  revisionId,
  className,
  imageClassName,
  fallbackClassName,
}: CredentialIdentityProps) {
  const { getAccessToken } = useAccessToken();
  const [iconUrl, setIconUrl] = useState<string | null>(null);

  const fileUrl = useMemo(() => {
    if (!iconPath) {
      return null;
    }
    if (sessionId) {
      return buildWorkspaceFileUrl({ path: iconPath, sessionId });
    }
    if (revisionId) {
      return buildWorkspaceFileUrl({ path: iconPath, revisionId });
    }
    return null;
  }, [iconPath, sessionId, revisionId]);

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
          throw new Error(`Failed to fetch credential icon (${response.status})`);
        }

        objectUrl = URL.createObjectURL(await response.blob());
        if (active) {
          setIconUrl(objectUrl);
        }
      } catch (error) {
        if (!abortController.signal.aborted) {
          console.error("Failed to load credential icon:", error);
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

export function ResolvedCredentialIcon({
  credentialId,
  name,
  sessionId,
  revisionId,
  className,
  imageClassName,
  fallbackClassName,
}: {
  credentialId: string;
  name: string;
  sessionId?: Id<"sessions"> | null;
  revisionId?: Id<"revisions"> | null;
  className?: string;
  imageClassName?: string;
  fallbackClassName?: string;
}) {
  const requirements = useQuery(
    api.credentials.getCredentialRequirementsForRevision,
    revisionId ? { revisionId } : "skip",
  );
  const requirement = requirements?.find((entry) => entry.id === credentialId);

  return (
    <CredentialIcon
      name={name}
      iconPath={requirement?.iconPath}
      sessionId={sessionId}
      revisionId={revisionId}
      className={className}
      imageClassName={imageClassName}
      fallbackClassName={fallbackClassName}
    />
  );
}
