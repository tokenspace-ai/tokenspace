import { Info, Key, Pencil, ShieldOff, Trash2, Variable, X } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { StatusBadge } from "@/ui/components/status-badge";
import { Badge } from "@/ui/components/ui/badge";
import { Button } from "@/ui/components/ui/button";
import { Card, CardContent } from "@/ui/components/ui/card";
import { Input } from "@/ui/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/components/ui/tooltip";
import { deleteCredentialSecret, saveCredentialSecret, useCredentials, useNonce } from "@/ui/hooks/use-api";
import type { CredentialSummary } from "@/ui/lib/types";

function groupCredentials(credentials: CredentialSummary[]): Array<{ group: string; items: CredentialSummary[] }> {
  const groups = new Map<string, CredentialSummary[]>();
  for (const credential of credentials) {
    const group = credential.group ?? "Other";
    const entries = groups.get(group);
    if (entries) {
      entries.push(credential);
    } else {
      groups.set(group, [credential]);
    }
  }
  return [...groups.entries()].map(([group, items]) => ({ group, items }));
}

const kindIcons: Record<string, typeof Key> = {
  secret: Key,
  env: Variable,
  oauth: ShieldOff,
};

export function CredentialsPage() {
  const credentials = useCredentials();
  const nonceResult = useNonce();
  const [editingId, setEditingId] = useState<string | null>(null);

  const credentialGroups = useMemo(
    () => (credentials.data ? groupCredentials(credentials.data) : []),
    [credentials.data],
  );

  return (
    <section>
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-lg font-semibold">Credentials</h2>
        <span className="text-sm text-muted-foreground">
          {credentials.data?.length ?? 0} requirement{credentials.data?.length === 1 ? "" : "s"}
        </span>
      </div>

      {credentials.error && (
        <Card className="mb-4">
          <CardContent className="pt-6">
            <p className="text-sm text-destructive">Failed to load credential state: {credentials.error}</p>
          </CardContent>
        </Card>
      )}

      {credentials.data?.length === 0 && (
        <p className="text-sm italic text-muted-foreground">
          No credential requirements were extracted from this workspace.
        </p>
      )}

      {credentialGroups.map(({ group, items }) => (
        <div key={group} className="mb-6">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">{group}</h3>
          <div className="rounded-md border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="text-left font-medium text-muted-foreground px-3 py-2">Name</th>
                  <th className="text-left font-medium text-muted-foreground px-3 py-2 w-20">Kind</th>
                  <th className="text-left font-medium text-muted-foreground px-3 py-2 w-24">Scope</th>
                  <th className="text-left font-medium text-muted-foreground px-3 py-2 w-28">Status</th>
                  <th className="text-right font-medium text-muted-foreground px-3 py-2 w-24">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((credential) => (
                  <CredentialRow
                    key={credential.id}
                    credential={credential}
                    nonce={nonceResult.data}
                    isEditing={editingId === credential.id}
                    onEdit={() => setEditingId(credential.id)}
                    onCancel={() => setEditingId(null)}
                    onMutated={() => {
                      setEditingId(null);
                      void credentials.refresh();
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </section>
  );
}

type CredentialRowProps = {
  credential: CredentialSummary;
  nonce: string | null;
  isEditing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onMutated: () => void;
};

function CredentialRow({ credential, nonce, isEditing, onEdit, onCancel, onMutated }: CredentialRowProps) {
  const [secretValue, setSecretValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [iconErrored, setIconErrored] = useState(false);

  const title = credential.label ?? credential.id;
  const KindIcon = kindIcons[credential.kind] ?? Key;
  const showIconImage = Boolean(credential.iconUrl) && !iconErrored;

  useEffect(() => {
    setIconErrored(false);
  }, [credential.iconUrl]);

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (!nonce) {
      setError("Action token is still loading. Please try again in a moment.");
      return;
    }
    if (!secretValue.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await saveCredentialSecret(credential.id, secretValue, nonce);
      setSecretValue("");
      onMutated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!nonce) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteCredentialSecret(credential.id, nonce);
      onMutated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  };

  const tooltipParts: string[] = [];
  if (credential.description) tooltipParts.push(credential.description);
  if (credential.localScopeNote) tooltipParts.push(credential.localScopeNote);
  if (credential.unsupportedReason && !credential.overridden) tooltipParts.push(credential.unsupportedReason);
  if (credential.kind === "env" && credential.overridden) {
    tooltipParts.push("Manual override active — takes precedence over process.env.");
  }

  const secondaryLabel = credential.kind === "env" && credential.variableName ? credential.variableName : credential.id;
  const showSecondaryLabel = secondaryLabel !== title;

  return (
    <>
      <tr className="border-b border-border last:border-b-0 hover:bg-muted/30 transition-colors">
        <td className="px-3 py-2">
          <div className="flex items-center gap-2 min-w-0">
            {showIconImage ? (
              <img
                src={credential.iconUrl}
                alt=""
                className="size-5 shrink-0 rounded-sm border border-border/60 bg-background object-contain p-0.5"
                onError={() => setIconErrored(true)}
              />
            ) : (
              <KindIcon className="size-3.5 text-muted-foreground shrink-0" />
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="font-medium truncate">{title}</span>
                {credential.optional && <span className="text-[10px] text-muted-foreground italic shrink-0">opt</span>}
                {tooltipParts.length > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground shrink-0"
                        aria-label={`Show details for ${title}`}
                      >
                        <Info className="size-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      {tooltipParts.map((part, i) => (
                        <p key={i} className={i > 0 ? "mt-1" : ""}>
                          {part}
                        </p>
                      ))}
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
              {showSecondaryLabel && (
                <span className="text-xs text-muted-foreground font-mono truncate block">{secondaryLabel}</span>
              )}
            </div>
          </div>
        </td>
        <td className="px-3 py-2">
          <Badge variant="outline" className="text-[11px] font-mono">
            {credential.kind}
          </Badge>
        </td>
        <td className="px-3 py-2 text-muted-foreground font-mono text-xs">{credential.scope}</td>
        <td className="px-3 py-2">
          <div className="flex items-center gap-1.5">
            <StatusBadge status={credential.status} />
            {credential.overridden && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="secondary" className="text-[10px]">
                    override
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>Value manually set in local MCP, overriding the default source.</TooltipContent>
              </Tooltip>
            )}
          </div>
        </td>
        <td className="px-3 py-2 text-right">
          <div className="flex items-center justify-end gap-1">
            {!isEditing && (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={onEdit}
                title="Set value"
                aria-label={`Set value for ${title}`}
              >
                <Pencil className="size-3" />
              </Button>
            )}
            {isEditing && (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={onCancel}
                title="Cancel"
                aria-label={`Cancel editing ${title}`}
              >
                <X className="size-3" />
              </Button>
            )}
            {(credential.kind === "secret" || credential.overridden) && (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={handleDelete}
                disabled={saving || deleting || !nonce}
                title="Delete stored value"
                aria-label={`Delete stored value for ${title}`}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="size-3" />
              </Button>
            )}
          </div>
        </td>
      </tr>
      {isEditing && (
        <tr className="border-b border-border last:border-b-0 bg-muted/20">
          <td colSpan={5} className="px-3 py-2">
            <form onSubmit={handleSave} className="flex items-center gap-2">
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={credential.placeholder ?? `Enter ${credential.kind} value`}
                aria-label={`Value for ${title}`}
                value={secretValue}
                onChange={(e) => setSecretValue(e.target.value)}
                className="h-7 text-sm flex-1"
                autoFocus
              />
              <Button type="submit" size="xs" disabled={saving || deleting || !nonce || !secretValue.trim()}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </form>
            {credential.kind === "env" && !credential.overridden && (
              <p className="text-xs text-muted-foreground mt-1.5">
                Setting a value here will override the <code className="font-mono">{credential.variableName}</code>{" "}
                environment variable.
              </p>
            )}
            {credential.kind === "oauth" && !credential.overridden && (
              <p className="text-xs text-muted-foreground mt-1.5">
                OAuth is not natively supported in local MCP. You can manually provide a token value here.
              </p>
            )}
            {error && <p className="text-xs text-destructive mt-1.5">{error}</p>}
          </td>
        </tr>
      )}
      {!isEditing && error && (
        <tr className="border-b border-border last:border-b-0 bg-muted/20">
          <td colSpan={5} className="px-3 py-2">
            <p className="text-xs text-destructive">{error}</p>
          </td>
        </tr>
      )}
    </>
  );
}
