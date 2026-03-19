import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import { WorkspaceFileIcon } from "@/components/workspace-file-icon";

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
  return (
    <WorkspaceFileIcon
      name={name}
      filePath={iconPath}
      sessionId={sessionId}
      revisionId={revisionId}
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
