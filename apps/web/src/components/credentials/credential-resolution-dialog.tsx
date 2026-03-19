import { Link } from "@tanstack/react-router";
import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { useAction, useMutation } from "convex/react";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ResolvedCredentialIcon } from "@/components/credentials/credential-icon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CredentialMissingPayload } from "@/lib/credential-missing";

type OAuthDraft = {
  accessToken: string;
  tokenType: string;
  expiresAt: string;
  scopes: string;
  refreshToken: string;
};

function emptyOAuthDraft(): OAuthDraft {
  return {
    accessToken: "",
    tokenType: "",
    expiresAt: "",
    scopes: "",
    refreshToken: "",
  };
}

export function CredentialResolutionDialog({
  open,
  onOpenChange,
  payload,
  sessionId,
  revisionId,
  workspaceId,
  workspaceSlug,
  onResolved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  payload: CredentialMissingPayload | null;
  sessionId?: Id<"sessions"> | null;
  revisionId?: Id<"revisions"> | null;
  workspaceId?: Id<"workspaces"> | null;
  workspaceSlug?: string;
  onResolved?: () => void;
}) {
  const beginOAuthConnect = useAction(api.credentials.beginOAuthConnect);
  const upsertSessionCredential = useMutation(api.credentials.upsertSessionCredential);
  const upsertUserCredential = useMutation(api.credentials.upsertUserCredential);
  const [isSaving, setIsSaving] = useState(false);
  const [secretValue, setSecretValue] = useState("");
  const [oauthDraft, setOauthDraft] = useState<OAuthDraft>(emptyOAuthDraft());

  useEffect(() => {
    if (!open) return;
    setSecretValue("");
    setOauthDraft(emptyOAuthDraft());
  }, [open, payload?.credential.id]);

  const handleSave = async () => {
    if (!payload) return;
    if (payload.credential.kind === "env") {
      toast.error("Environment credentials require self-hosted executor env vars and cannot be stored here.");
      return;
    }

    setIsSaving(true);
    try {
      if (payload.credential.scope === "session") {
        if (!sessionId) {
          throw new Error("Session context is missing.");
        }
        if (payload.credential.kind === "secret") {
          if (!secretValue.trim()) {
            throw new Error("Credential value is required.");
          }
          await upsertSessionCredential({
            sessionId,
            credentialId: payload.credential.id,
            kind: "secret",
            value: { value: secretValue.trim() },
          });
        } else {
          const expiresAt = oauthDraft.expiresAt.trim() ? Number(oauthDraft.expiresAt.trim()) : undefined;
          if (!oauthDraft.accessToken.trim()) {
            throw new Error("Access token is required.");
          }
          if (expiresAt !== undefined && !Number.isFinite(expiresAt)) {
            throw new Error("expiresAt must be a unix timestamp number.");
          }
          await upsertSessionCredential({
            sessionId,
            credentialId: payload.credential.id,
            kind: "oauth",
            value: {
              accessToken: oauthDraft.accessToken.trim(),
              tokenType: oauthDraft.tokenType.trim() || undefined,
              expiresAt,
              scope: oauthDraft.scopes
                .split(",")
                .map((entry) => entry.trim())
                .filter(Boolean),
              refreshToken: oauthDraft.refreshToken.trim() || undefined,
            },
          });
        }
      } else if (payload.credential.scope === "user") {
        if (!workspaceId || !revisionId) {
          throw new Error("Workspace context is missing.");
        }
        if (payload.credential.kind === "secret") {
          if (!secretValue.trim()) {
            throw new Error("Credential value is required.");
          }
          await upsertUserCredential({
            workspaceId,
            revisionId,
            credentialId: payload.credential.id,
            kind: "secret",
            value: { value: secretValue.trim() },
          });
        } else {
          throw new Error("User OAuth credentials must be connected through the OAuth flow.");
        }
      } else {
        throw new Error("Workspace credentials must be configured in admin settings.");
      }
      toast.success("Credential saved. Re-run to continue.");
      onOpenChange(false);
      onResolved?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save credential.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleConnectOAuth = async () => {
    if (!payload || payload.credential.kind !== "oauth" || payload.credential.scope !== "user") {
      return;
    }
    if (!workspaceId || !revisionId) {
      toast.error("Workspace context is missing.");
      return;
    }

    setIsSaving(true);
    try {
      const result = await beginOAuthConnect({
        workspaceId,
        revisionId,
        credentialId: payload.credential.id,
        scope: "user",
        returnPath: `${window.location.pathname}${window.location.search}${window.location.hash}`,
      });
      if (result.mode === "redirect") {
        window.location.href = result.authorizeUrl;
        return;
      }
      toast.success("Credential connected. Re-run to continue.");
      onOpenChange(false);
      onResolved?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to start OAuth connect flow.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            {payload ? (
              <ResolvedCredentialIcon
                credentialId={payload.credential.id}
                name={payload.credential.label ?? payload.credential.id}
                sessionId={sessionId}
                revisionId={revisionId}
                className="size-8 rounded-md border border-border/60 bg-background"
                imageClassName="object-contain p-1"
                fallbackClassName="text-xs"
              />
            ) : null}
            <span>Resolve Credential</span>
          </DialogTitle>
          <DialogDescription>
            {payload
              ? `${payload.credential.label ?? payload.credential.id} (${payload.credential.scope}/${payload.credential.kind})`
              : "Configure the missing credential to continue."}
          </DialogDescription>
        </DialogHeader>

        {!payload ? null : payload.credential.scope === "workspace" ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Workspace-scoped credentials are configured from admin settings.
            </p>
            {workspaceSlug ? (
              <Button asChild className="w-full">
                <Link to="/workspace/$slug/admin/credentials" params={{ slug: workspaceSlug }}>
                  Open Credentials Settings
                </Link>
              </Button>
            ) : null}
          </div>
        ) : payload.credential.kind === "env" ? (
          <p className="text-sm text-muted-foreground">
            This is an environment credential and must be provided by self-hosted executor environment variables.
          </p>
        ) : payload.credential.kind === "secret" ? (
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="credential-secret-value">Secret Value</Label>
              <Input
                id="credential-secret-value"
                type="password"
                value={secretValue}
                onChange={(event) => setSecretValue(event.target.value)}
                placeholder="Enter credential value"
                disabled={isSaving}
              />
            </div>
            <Button className="w-full" onClick={() => void handleSave()} disabled={isSaving}>
              {isSaving ? <Loader2 className="size-4 mr-2 animate-spin" /> : null}
              Save Credential
            </Button>
          </div>
        ) : payload.credential.scope === "user" ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Connect this user-scoped OAuth credential through the provider authorization flow.
            </p>
            <Button className="w-full" onClick={() => void handleConnectOAuth()} disabled={isSaving}>
              {isSaving ? <Loader2 className="size-4 mr-2 animate-spin" /> : null}
              Connect OAuth Credential
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="credential-oauth-access-token">Access Token</Label>
                <Input
                  id="credential-oauth-access-token"
                  type="password"
                  value={oauthDraft.accessToken}
                  onChange={(event) => setOauthDraft((prev) => ({ ...prev, accessToken: event.target.value }))}
                  disabled={isSaving}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="credential-oauth-token-type">Token Type</Label>
                <Input
                  id="credential-oauth-token-type"
                  value={oauthDraft.tokenType}
                  onChange={(event) => setOauthDraft((prev) => ({ ...prev, tokenType: event.target.value }))}
                  placeholder="Bearer"
                  disabled={isSaving}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="credential-oauth-expires-at">Expires At (unix ms)</Label>
                <Input
                  id="credential-oauth-expires-at"
                  value={oauthDraft.expiresAt}
                  onChange={(event) => setOauthDraft((prev) => ({ ...prev, expiresAt: event.target.value }))}
                  placeholder="1735689600000"
                  disabled={isSaving}
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="credential-oauth-scopes">Scopes (comma-separated)</Label>
                <Input
                  id="credential-oauth-scopes"
                  value={oauthDraft.scopes}
                  onChange={(event) => setOauthDraft((prev) => ({ ...prev, scopes: event.target.value }))}
                  placeholder="repo, read:user"
                  disabled={isSaving}
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="credential-oauth-refresh-token">Refresh Token</Label>
                <Input
                  id="credential-oauth-refresh-token"
                  type="password"
                  value={oauthDraft.refreshToken}
                  onChange={(event) => setOauthDraft((prev) => ({ ...prev, refreshToken: event.target.value }))}
                  disabled={isSaving}
                />
              </div>
            </div>
            <Button className="w-full" onClick={() => void handleSave()} disabled={isSaving}>
              {isSaving ? <Loader2 className="size-4 mr-2 animate-spin" /> : null}
              Save Credential
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
