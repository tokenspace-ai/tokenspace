import { Link } from "@tanstack/react-router";
import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import { ArrowRightIcon, InfoIcon, KeyRoundIcon, Loader2, Pencil, ShieldCheckIcon, UserIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { MessageResponse } from "@/components/ai-elements/message";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

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

type CredentialBinding = {
  credentialId: string;
  kind: "secret" | "oauth";
  updatedAt: number;
};

function formatUpdatedAt(timestamp: number | undefined): string {
  if (!timestamp) return "Not configured";
  return new Date(timestamp).toLocaleString();
}

function requirementBadgeLabel(requirement: Pick<CredentialRequirement, "scope" | "kind">) {
  return `${requirement.scope}/${requirement.kind}`;
}

function requirementDisplayName(requirement: Pick<CredentialRequirement, "id" | "label">) {
  return requirement.label ?? requirement.id;
}

function requirementHint(requirement: CredentialRequirement): string | null {
  if (requirement.kind === "env") {
    return "Environment credentials must be provided by the executor environment and are not stored in Tokenspace.";
  }
  if (requirement.kind === "oauth") {
    return "OAuth credentials connect through the provider authorization flow.";
  }
  if (requirement.scope === "session") {
    return "Session credentials are requested while a chat or playground run is in progress.";
  }
  if (requirement.scope === "workspace") {
    return "Workspace credentials are configured by workspace admins in admin settings.";
  }
  return null;
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

function CredentialDescription({ description }: { description: string }) {
  return (
    <MessageResponse className="prose max-w-none text-[11px] leading-4 text-muted-foreground prose-p:my-1 prose-p:leading-4 prose-headings:my-1 prose-headings:text-[11px] prose-headings:leading-4 prose-headings:text-muted-foreground prose-strong:text-muted-foreground prose-code:rounded prose-code:bg-secondary prose-code:px-1 prose-code:py-0.5 prose-code:text-[10px] prose-code:text-muted-foreground prose-pre:bg-secondary/80 prose-pre:border prose-pre:border-border/40 prose-pre:p-2 prose-pre:text-muted-foreground prose-a:text-primary prose-a:no-underline hover:prose-a:underline">
      {description}
    </MessageResponse>
  );
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

export function WorkspaceAppCredentialsPage({
  workspaceId,
  revisionId,
  workspaceSlug,
  isWorkspaceAdmin,
}: {
  workspaceId: Id<"workspaces">;
  revisionId: Id<"revisions"> | null;
  workspaceSlug: string;
  isWorkspaceAdmin: boolean;
}) {
  const requirements = useQuery(
    api.credentials.getCredentialRequirementsForRevision,
    revisionId ? { revisionId } : "skip",
  );
  const summary = useQuery(api.credentials.getCredentialNavigationSummary, revisionId ? { revisionId } : "skip");
  const userBindings = useQuery(api.credentials.listUserCredentialBindings, { workspaceId });
  const workspaceBindings = useQuery(
    api.credentials.listWorkspaceCredentialBindings,
    isWorkspaceAdmin ? { workspaceId } : "skip",
  );
  const beginOAuthConnect = useAction(api.credentials.beginOAuthConnect);
  const upsertUserCredential = useMutation(api.credentials.upsertUserCredential);
  const deleteUserCredential = useMutation(api.credentials.deleteUserCredential);

  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [editingSecret, setEditingSecret] = useState<Record<string, boolean>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  const requirementBuckets = useMemo(() => {
    const all = requirements ?? [];
    return {
      userGroups: groupRequirements(all.filter((requirement) => requirement.scope === "user")),
      workspaceGroups: groupRequirements(all.filter((requirement) => requirement.scope === "workspace")),
      sessionGroups: groupRequirements(all.filter((requirement) => requirement.scope === "session")),
    };
  }, [requirements]);

  const userBindingByKey = useMemo(() => {
    const map = new Map<string, CredentialBinding>();
    for (const binding of userBindings ?? []) {
      map.set(`${binding.credentialId}:${binding.kind}`, {
        credentialId: binding.credentialId,
        kind: binding.kind,
        updatedAt: binding.updatedAt,
      });
    }
    return map;
  }, [userBindings]);

  const workspaceBindingByKey = useMemo(() => {
    const map = new Map<string, CredentialBinding>();
    for (const binding of workspaceBindings ?? []) {
      map.set(`${binding.credentialId}:${binding.kind}`, {
        credentialId: binding.credentialId,
        kind: binding.kind,
        updatedAt: binding.updatedAt,
      });
    }
    return map;
  }, [workspaceBindings]);

  const handleSaveUserSecret = async (credentialId: string) => {
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
      await upsertUserCredential({
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

  const handleConnectUserOAuth = async (credentialId: string) => {
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
        scope: "user",
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

  const handleDeleteUserCredential = async (credentialId: string, kind: "secret" | "oauth") => {
    const key = `${credentialId}:${kind}`;
    setDeletingKey(key);
    try {
      await deleteUserCredential({ workspaceId, credentialId, kind });
      toast.success("Credential removed.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to remove credential.");
    } finally {
      setDeletingKey(null);
    }
  };

  if (!revisionId) {
    return (
      <Alert>
        <InfoIcon />
        <AlertTitle>No compiled revision</AlertTitle>
        <AlertDescription>
          Compile this branch first so the current revision can expose its credential requirements.
        </AlertDescription>
      </Alert>
    );
  }

  if (
    !requirements ||
    !userBindings ||
    summary === undefined ||
    (isWorkspaceAdmin && workspaceBindings === undefined)
  ) {
    return (
      <div className="rounded-lg border p-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin" />
          Loading credential requirements...
        </div>
      </div>
    );
  }

  if (requirements.length === 0) {
    return (
      <Alert>
        <KeyRoundIcon />
        <AlertTitle>No credentials required</AlertTitle>
        <AlertDescription>This revision does not define any workspace, user, or session credentials.</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-8">
      {summary.missingActionableCount > 0 ? (
        <Alert variant="destructive">
          <InfoIcon />
          <AlertTitle>Action needed</AlertTitle>
          <AlertDescription>
            {summary.missingActionableCount === 1
              ? "At least one required credential still needs to be configured."
              : `${summary.missingActionableCount} required credentials still need to be configured.`}
          </AlertDescription>
        </Alert>
      ) : null}

      <section className="space-y-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <UserIcon className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">Your Credentials</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            Configure the user-scoped credentials you can provide directly for this workspace revision.
          </p>
        </div>

        {requirementBuckets.userGroups.length === 0 ? (
          <div className="rounded-lg border p-4 text-sm text-muted-foreground">
            No user-scoped credentials are defined for this revision.
          </div>
        ) : (
          <GroupedRequirementList
            groups={requirementBuckets.userGroups}
            renderRequirement={(requirement) => {
              const key = `${requirement.id}:${requirement.kind}`;
              const binding = userBindingByKey.get(key);
              const isMissing = !requirement.optional && requirement.kind !== "env" && !binding;
              const showSecretEditor =
                requirement.kind === "secret" && (!binding || editingSecret[requirement.id] === true);
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
                      configured={requirement.kind !== "env" ? !!binding : undefined}
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
                              disabled={isBusy}
                            >
                              <Pencil className="size-3 mr-1" />
                              Edit
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-6 px-2 text-xs text-muted-foreground"
                              onClick={() => void handleDeleteUserCredential(requirement.id, "secret")}
                              disabled={isBusy}
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
                          <Label htmlFor={`user-secret-${requirement.id}`} className="text-xs">
                            Secret Value
                          </Label>
                          <Input
                            id={`user-secret-${requirement.id}`}
                            type="password"
                            value={secretValues[requirement.id] ?? ""}
                            onChange={(event) =>
                              setSecretValues((prev) => ({ ...prev, [requirement.id]: event.target.value }))
                            }
                            placeholder={
                              requirement.placeholder ||
                              (binding ? "Enter a new value to rotate" : "Enter secret value")
                            }
                            disabled={isBusy}
                          />
                          <div className="flex flex-wrap gap-2">
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => void handleSaveUserSecret(requirement.id)}
                              disabled={isBusy || (secretValues[requirement.id] ?? "").trim().length === 0}
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
                                  disabled={isBusy}
                                >
                                  Cancel
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={() => void handleDeleteUserCredential(requirement.id, "secret")}
                                  disabled={isBusy}
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
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => void handleConnectUserOAuth(requirement.id)}
                          disabled={isBusy}
                        >
                          {isSaving ? <Loader2 className="size-4 mr-2 animate-spin" /> : null}
                          {binding ? "Reconnect" : "Connect"}
                        </Button>
                        {binding ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => void handleDeleteUserCredential(requirement.id, "oauth")}
                            disabled={isBusy}
                          >
                            {isDeleting ? <Loader2 className="size-4 mr-2 animate-spin" /> : null}
                            Remove
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                      This credential must come from the execution environment and cannot be stored in the app.
                    </div>
                  )}
                </div>
              );
            }}
          />
        )}
      </section>

      <section className="space-y-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <ShieldCheckIcon className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">Workspace Credentials</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            These credentials are managed at the workspace level and apply across runs for this revision.
          </p>
        </div>

        {requirementBuckets.workspaceGroups.length === 0 ? (
          <div className="rounded-lg border p-4 text-sm text-muted-foreground">
            No workspace-scoped credentials are defined for this revision.
          </div>
        ) : (
          <div className="space-y-4">
            <Alert>
              <InfoIcon />
              <AlertTitle>{isWorkspaceAdmin ? "Admin settings required" : "Managed by workspace admins"}</AlertTitle>
              <AlertDescription>
                {isWorkspaceAdmin
                  ? "Configure or rotate workspace-scoped credentials from the admin credentials page."
                  : "Workspace-scoped credentials are configured by workspace admins."}
              </AlertDescription>
            </Alert>

            <GroupedRequirementList
              groups={requirementBuckets.workspaceGroups}
              renderRequirement={(requirement) => {
                const key = `${requirement.id}:${requirement.kind}`;
                const binding = workspaceBindingByKey.get(key);
                return (
                  <div key={key} className="rounded-lg border bg-card p-4 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="min-w-0 text-sm font-medium">{requirementDisplayName(requirement)}</h3>
                      <RequirementMeta
                        requirement={requirement}
                        configured={isWorkspaceAdmin && requirement.kind !== "env" ? !!binding : undefined}
                        configuredLabel={isWorkspaceAdmin ? undefined : "admin managed"}
                      />
                    </div>
                    {requirement.description ? <CredentialDescription description={requirement.description} /> : null}
                    {isWorkspaceAdmin && binding ? (
                      <p className="text-xs text-muted-foreground">
                        Last updated: {formatUpdatedAt(binding.updatedAt)}
                      </p>
                    ) : null}
                  </div>
                );
              }}
            />

            {isWorkspaceAdmin ? (
              <div className="flex justify-start">
                <Button asChild variant="outline">
                  <Link to="/workspace/$slug/admin/credentials" params={{ slug: workspaceSlug }}>
                    Open Admin Credential Settings
                    <ArrowRightIcon className="size-4" />
                  </Link>
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-sm font-medium">Runtime-only Credentials</h2>
          <p className="text-sm text-muted-foreground">
            Session-scoped credentials are requested in chat or playground only when a run needs them.
          </p>
        </div>

        {requirementBuckets.sessionGroups.length === 0 ? (
          <div className="rounded-lg border p-4 text-sm text-muted-foreground">
            No session-scoped credentials are defined for this revision.
          </div>
        ) : (
          <GroupedRequirementList
            groups={requirementBuckets.sessionGroups}
            renderRequirement={(requirement) => (
              <div key={`${requirement.id}:${requirement.kind}`} className="rounded-lg border bg-card p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="min-w-0 text-sm font-medium">{requirementDisplayName(requirement)}</h3>
                  <RequirementMeta requirement={requirement} />
                </div>
                {requirement.description ? <CredentialDescription description={requirement.description} /> : null}
                <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  Configure this credential when a chat or playground run prompts for it.
                </div>
              </div>
            )}
          />
        )}
      </section>
    </div>
  );
}
