import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import { CheckIcon, CopyIcon, InfoIcon, Loader2, Pencil } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { MessageResponse } from "@/components/ai-elements/message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type WorkspaceCredentialBinding = {
  credentialId: string;
  kind: "secret" | "oauth";
  updatedAt: number;
  isExpired: boolean;
};

type CredentialRequirement = {
  id: string;
  label?: string;
  group?: string;
  kind: "secret" | "env" | "oauth";
  scope: "workspace" | "session" | "user";
  description?: string;
  placeholder?: string;
  optional?: boolean;
  config?: unknown;
};

type CredentialGroup = {
  key: string;
  label?: string;
  requirements: CredentialRequirement[];
};

function formatUpdatedAt(timestamp: number | undefined): string {
  if (!timestamp) return "Not configured";
  return new Date(timestamp).toLocaleString();
}

function requirementBadgeLabel(requirement: {
  kind: "secret" | "env" | "oauth";
  scope: "workspace" | "session" | "user";
}) {
  return `${requirement.scope}/${requirement.kind}`;
}

function requirementDisplayName(requirement: { id: string; label?: string }) {
  return requirement.label ?? requirement.id;
}

function requirementHint(requirement: CredentialRequirement): string | null {
  if (requirement.kind === "env") {
    return "Environment credentials require self-hosted executor environment variables and are not stored in Tokenspace.";
  }
  if (requirement.kind === "oauth") {
    return "Connect this OAuth credential through the provider. Manual token entry is still available via API for break-glass cases.";
  }
  if (requirement.scope !== "workspace") {
    return "Session and user credentials are configured when a run requests them from chat or playground.";
  }
  return null;
}

function RequirementMeta({
  requirement,
  configured,
  configuredLabel,
}: {
  requirement: CredentialRequirement;
  configured?: boolean;
  configuredLabel?: string;
}) {
  const hint = requirementHint(requirement);

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Badge variant="outline" className="text-[10px]">
        {requirementBadgeLabel(requirement)}
      </Badge>
      {requirement.optional ? (
        <Badge variant="secondary" className="text-[10px]">
          optional
        </Badge>
      ) : null}
      {configured !== undefined ? (
        <Badge variant={configured ? "default" : "destructive"} className="text-[10px]">
          {configuredLabel ?? (configured ? "configured" : "not configured")}
        </Badge>
      ) : null}
      {hint ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
              aria-label="Credential info"
            >
              <InfoIcon className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" align="end" className="max-w-xs text-xs leading-5">
            {hint}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}

function CredentialDescription({ description }: { description: string }) {
  return (
    <MessageResponse className="prose max-w-none text-[11px] leading-4 text-muted-foreground prose-p:my-1 prose-p:leading-4 prose-headings:my-1 prose-headings:text-[11px] prose-headings:leading-4 prose-headings:text-muted-foreground prose-strong:text-muted-foreground prose-code:rounded prose-code:bg-secondary prose-code:px-1 prose-code:py-0.5 prose-code:text-[10px] prose-code:text-muted-foreground prose-pre:bg-secondary/80 prose-pre:border prose-pre:border-border/40 prose-pre:p-2 prose-pre:text-muted-foreground prose-a:text-primary prose-a:no-underline hover:prose-a:underline">
      {description}
    </MessageResponse>
  );
}

function EnvVarCopyButton({
  value,
  className,
  ...props
}: {
  value: string;
  className?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const [isCopied, setIsCopied] = useState(false);

  const copyToClipboard = async () => {
    if (!navigator?.clipboard) {
      toast.error("Clipboard API not available.");
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      setIsCopied(true);
      toast.success("Environment variable copied.");
      window.setTimeout(() => setIsCopied(false), 2000);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to copy environment variable.");
    }
  };

  const Icon = isCopied ? CheckIcon : CopyIcon;

  return (
    <button
      type="button"
      className={`inline-flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground ${className ?? ""}`}
      onClick={() => void copyToClipboard()}
      aria-label={isCopied ? "Copied" : "Copy environment variable"}
      title={isCopied ? "Copied" : "Copy environment variable"}
      {...props}
    >
      <Icon className="size-3.5" />
    </button>
  );
}

function groupRequirements(requirements: CredentialRequirement[]): CredentialGroup[] {
  const groups: CredentialGroup[] = [];
  const byGroup = new Map<string, CredentialGroup>();

  for (const requirement of requirements) {
    const key = requirement.group ?? "__ungrouped__";
    let group = byGroup.get(key);
    if (!group) {
      group = {
        key,
        label: requirement.group,
        requirements: [],
      };
      byGroup.set(key, group);
      groups.push(group);
    }
    group.requirements.push(requirement);
  }

  return groups;
}

function GroupedRequirementList({
  groups,
  renderRequirement,
}: {
  groups: CredentialGroup[];
  renderRequirement: (requirement: CredentialRequirement) => ReactNode;
}) {
  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <div key={group.key} className="space-y-2">
          {group.label ? <h3 className="text-sm font-medium">{group.label}</h3> : null}
          <div className="space-y-2">{group.requirements.map(renderRequirement)}</div>
        </div>
      ))}
    </div>
  );
}

function isBindingConfigured(binding: WorkspaceCredentialBinding | undefined): boolean {
  return Boolean(binding && !binding.isExpired);
}

export function WorkspaceCredentialsSettings({
  workspaceId,
  revisionId,
  isWorkspaceAdmin,
}: {
  workspaceId: Id<"workspaces">;
  revisionId: Id<"revisions"> | null;
  isWorkspaceAdmin: boolean;
}) {
  const requirements = useQuery(
    api.credentials.getCredentialRequirementsForRevision,
    revisionId ? { revisionId } : "skip",
  );
  const workspaceBindings = useQuery(
    api.credentials.listWorkspaceCredentialBindings,
    isWorkspaceAdmin ? { workspaceId } : "skip",
  );
  const beginOAuthConnect = useAction(api.credentials.beginOAuthConnect);
  const upsertWorkspaceCredential = useMutation(api.credentials.upsertWorkspaceCredential);
  const deleteWorkspaceCredential = useMutation(api.credentials.deleteWorkspaceCredential);

  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [editingSecret, setEditingSecret] = useState<Record<string, boolean>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  const requirementBuckets = useMemo(() => {
    const all = requirements ?? [];
    const workspace = all.filter((requirement) => requirement.scope === "workspace");
    const runtime = all.filter((requirement) => requirement.scope !== "workspace");
    return {
      workspaceGroups: groupRequirements(workspace),
      runtimeGroups: groupRequirements(runtime),
      workspaceCount: workspace.length,
    };
  }, [requirements]);

  const bindingByKey = useMemo(() => {
    const map = new Map<string, WorkspaceCredentialBinding>();
    for (const binding of workspaceBindings ?? []) {
      map.set(`${binding.credentialId}:${binding.kind}`, {
        credentialId: binding.credentialId,
        kind: binding.kind,
        updatedAt: binding.updatedAt,
        isExpired: Boolean(binding.isExpired),
      });
    }
    return map;
  }, [workspaceBindings]);

  const handleSaveSecret = async (credentialId: string) => {
    if (!revisionId) {
      toast.error("Compile this branch first so credential requirements are available.");
      return;
    }
    const nextValue = secretValues[credentialId] ?? "";
    if (nextValue.trim().length === 0) {
      toast.error("Secret value is required.");
      return;
    }
    const key = `${credentialId}:secret`;
    setSavingKey(key);
    try {
      await upsertWorkspaceCredential({
        workspaceId,
        revisionId,
        credentialId,
        kind: "secret",
        value: { value: nextValue },
      });
      setSecretValues((prev) => ({ ...prev, [credentialId]: "" }));
      setEditingSecret((prev) => ({ ...prev, [credentialId]: false }));
      toast.success("Credential saved.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save credential.");
    } finally {
      setSavingKey(null);
    }
  };

  const handleConnectOAuth = async (credentialId: string) => {
    if (!revisionId) {
      toast.error("Compile this branch first so credential requirements are available.");
      return;
    }

    const key = `${credentialId}:oauth`;
    setSavingKey(key);
    try {
      const result = await beginOAuthConnect({
        workspaceId,
        revisionId,
        credentialId,
        scope: "workspace",
        returnPath: `${window.location.pathname}${window.location.search}${window.location.hash}`,
      });
      if (result.mode === "redirect") {
        window.location.href = result.authorizeUrl;
        return;
      }
      toast.success("OAuth credential connected.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to start OAuth connect flow.");
    } finally {
      setSavingKey(null);
    }
  };

  const handleDelete = async (credentialId: string, kind: "secret" | "oauth") => {
    const key = `${credentialId}:${kind}`;
    setDeletingKey(key);
    try {
      await deleteWorkspaceCredential({
        workspaceId,
        credentialId,
        kind,
      });
      toast.success("Credential removed.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete credential.");
    } finally {
      setDeletingKey(null);
    }
  };

  if (!revisionId) {
    return (
      <div className="rounded-lg border p-4 text-sm text-muted-foreground">
        No compiled revision found for this branch. Compile the workspace to load credential requirements.
      </div>
    );
  }

  if (!requirements) {
    return (
      <div className="rounded-lg border p-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin" />
          Loading credential requirements...
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {requirementBuckets.workspaceCount === 0 ? (
        <div className="rounded-lg border p-4 text-sm text-muted-foreground">
          No workspace-scoped credentials are defined in `src/credentials.ts`.
        </div>
      ) : (
        <GroupedRequirementList
          groups={requirementBuckets.workspaceGroups}
          renderRequirement={(requirement) => {
            const key = `${requirement.id}:${requirement.kind}`;
            const binding = bindingByKey.get(key);
            const isConfigured = isBindingConfigured(binding);
            const isMissing = requirement.kind !== "env" && !isConfigured;
            const showSecretEditor =
              requirement.kind === "secret" && (!isConfigured || editingSecret[requirement.id] === true);
            const isSaving = savingKey === key;
            const isDeleting = deletingKey === key;
            const isBusy = isSaving || isDeleting;

            return (
              <div
                key={key}
                className={
                  isMissing
                    ? "rounded-lg border border-destructive/30 bg-destructive/5 p-4 space-y-3"
                    : "rounded-lg border bg-card p-4 space-y-3"
                }
              >
                <div className="flex items-start justify-between gap-3">
                  <h3 className="min-w-0 text-sm font-medium">{requirementDisplayName(requirement)}</h3>
                  <RequirementMeta
                    requirement={requirement}
                    configured={requirement.kind !== "env" ? isConfigured : undefined}
                    configuredLabel={binding?.isExpired ? "expired" : undefined}
                  />
                </div>
                {requirement.description ? <CredentialDescription description={requirement.description} /> : null}

                {requirement.kind === "secret" ? (
                  <div className="space-y-2">
                    {!showSecretEditor && binding ? (
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-xs text-muted-foreground"
                            onClick={() => setEditingSecret((prev) => ({ ...prev, [requirement.id]: true }))}
                            disabled={!isWorkspaceAdmin || isBusy}
                          >
                            <Pencil className="size-3 mr-1" />
                            Edit
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-xs text-muted-foreground"
                            onClick={() => void handleDelete(requirement.id, "secret")}
                            disabled={!isWorkspaceAdmin || isBusy}
                          >
                            {isDeleting ? <Loader2 className="size-3 mr-1 animate-spin" /> : null}
                            Remove
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Last updated: {formatUpdatedAt(binding.updatedAt)}
                        </p>
                      </div>
                    ) : (
                      <>
                        <Label htmlFor={`secret-${requirement.id}`} className="text-xs">
                          Secret Value
                        </Label>
                        <Input
                          id={`secret-${requirement.id}`}
                          type="password"
                          value={secretValues[requirement.id] ?? ""}
                          onChange={(event) =>
                            setSecretValues((prev) => ({ ...prev, [requirement.id]: event.target.value }))
                          }
                          placeholder={
                            requirement.placeholder || (binding ? "Enter a new value to rotate" : "Enter secret value")
                          }
                          disabled={!isWorkspaceAdmin || isBusy}
                        />
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => void handleSaveSecret(requirement.id)}
                            disabled={
                              !isWorkspaceAdmin || isBusy || (secretValues[requirement.id] ?? "").trim().length === 0
                            }
                          >
                            {isSaving ? <Loader2 className="size-4 mr-2 animate-spin" /> : null}
                            Save
                          </Button>
                          {binding ? (
                            <>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => setEditingSecret((prev) => ({ ...prev, [requirement.id]: false }))}
                                disabled={!isWorkspaceAdmin || isBusy}
                              >
                                Cancel
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => void handleDelete(requirement.id, "secret")}
                                disabled={!isWorkspaceAdmin || isBusy}
                              >
                                {isDeleting ? <Loader2 className="size-4 mr-2 animate-spin" /> : null}
                                Remove
                              </Button>
                            </>
                          ) : null}
                        </div>
                      </>
                    )}
                  </div>
                ) : requirement.kind === "oauth" ? (
                  <div className="space-y-3">
                    {typeof (requirement.config as { grantType?: unknown } | undefined)?.grantType === "string" ? (
                      <p className="text-xs text-muted-foreground">
                        Grant type:{" "}
                        <span className="font-mono text-foreground">
                          {(requirement.config as { grantType: string }).grantType}
                        </span>
                      </p>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void handleConnectOAuth(requirement.id)}
                        disabled={!isWorkspaceAdmin || isBusy}
                      >
                        {isSaving ? <Loader2 className="size-4 mr-2 animate-spin" /> : null}
                        {binding ? "Reconnect" : "Connect"}
                      </Button>
                      {binding ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => void handleDelete(requirement.id, "oauth")}
                          disabled={!isWorkspaceAdmin || isBusy}
                        >
                          {isDeleting ? <Loader2 className="size-4 mr-2 animate-spin" /> : null}
                          Remove
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      Environment Variable:{" "}
                      <span className="inline-flex items-center gap-1.5">
                        <span className="font-mono text-foreground">
                          {requirement.config &&
                          typeof requirement.config === "object" &&
                          !Array.isArray(requirement.config) &&
                          typeof (requirement.config as { variableName?: unknown }).variableName === "string"
                            ? (requirement.config as { variableName: string }).variableName
                            : "Unknown"}
                        </span>
                        {requirement.config &&
                        typeof requirement.config === "object" &&
                        !Array.isArray(requirement.config) &&
                        typeof (requirement.config as { variableName?: unknown }).variableName === "string" ? (
                          <EnvVarCopyButton
                            value={(requirement.config as { variableName: string }).variableName}
                            className="size-4"
                          />
                        ) : null}
                      </span>
                    </p>
                  </div>
                )}
              </div>
            );
          }}
        />
      )}

      {requirementBuckets.runtimeGroups.length > 0 ? (
        <div className="rounded-lg border bg-card p-4 space-y-4">
          <div>
            <h3 className="text-sm font-medium">Runtime-Scoped Credentials</h3>
          </div>
          <GroupedRequirementList
            groups={requirementBuckets.runtimeGroups}
            renderRequirement={(requirement) => (
              <div key={`${requirement.scope}:${requirement.kind}:${requirement.id}`} className="space-y-1 text-xs">
                <div className="flex items-start justify-between gap-3">
                  <span className="font-medium">{requirementDisplayName(requirement)}</span>
                  <RequirementMeta requirement={requirement} />
                </div>
              </div>
            )}
          />
        </div>
      ) : null}
    </div>
  );
}
