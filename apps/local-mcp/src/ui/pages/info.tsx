import { Blocks, BookOpen, FolderOpen, Hash } from "lucide-react";
import { Badge } from "@/ui/components/ui/badge";
import { Separator } from "@/ui/components/ui/separator";
import { useSession } from "@/ui/hooks/use-api";
import type { CapabilityInfo, SkillInfo } from "@/ui/lib/types";

export function InfoPage() {
  const session = useSession();

  if (session.error && !session.data) {
    return <p className="text-sm text-destructive">Failed to load session info: {session.error}</p>;
  }

  if (!session.data) {
    return <p className="text-sm text-muted-foreground italic">Loading session info…</p>;
  }

  const { capabilities, skills } = session.data;

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Session</h2>
        <div className="rounded-md border border-border bg-card p-3">
          <dl className="grid gap-x-6 gap-y-1.5 text-sm grid-cols-[auto_1fr]">
            <MetaRow icon={<FolderOpen className="size-3.5" />} label="Workspace" value={session.data.workspaceName} />
            <MetaRow label="Path" value={session.data.workspaceDir} mono />
            <MetaRow
              icon={<Hash className="size-3.5" />}
              label="Fingerprint"
              value={session.data.sourceFingerprint}
              mono
              truncate
            />
            <MetaRow label="Build" value={session.data.buildOrigin} />
          </dl>
        </div>
      </section>

      <Separator />

      <section>
        <div className="flex items-center gap-2 mb-2">
          <Blocks className="size-3.5 text-muted-foreground" />
          <h2 className="text-xs uppercase tracking-wide text-muted-foreground">
            Capabilities
            {capabilities.length > 0 && <span className="ml-1.5 text-foreground/60">{capabilities.length}</span>}
          </h2>
        </div>
        {capabilities.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">No capabilities registered.</p>
        ) : (
          <div className="rounded-md border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="text-left font-medium text-muted-foreground px-3 py-2 w-40">Namespace</th>
                  <th className="text-left font-medium text-muted-foreground px-3 py-2">Description</th>
                </tr>
              </thead>
              <tbody>
                {capabilities.map((cap) => (
                  <CapabilityRow key={cap.namespace} capability={cap} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {skills.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-2">
            <BookOpen className="size-3.5 text-muted-foreground" />
            <h2 className="text-xs uppercase tracking-wide text-muted-foreground">
              Skills
              <span className="ml-1.5 text-foreground/60">{skills.length}</span>
            </h2>
          </div>
          <div className="rounded-md border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="text-left font-medium text-muted-foreground px-3 py-2 w-40">Name</th>
                  <th className="text-left font-medium text-muted-foreground px-3 py-2">Description</th>
                </tr>
              </thead>
              <tbody>
                {skills.map((skill) => (
                  <SkillRow key={skill.name} skill={skill} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function MetaRow({
  icon,
  label,
  value,
  mono,
  truncate,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  mono?: boolean;
  truncate?: boolean;
}) {
  return (
    <>
      <dt className="text-muted-foreground flex items-center gap-1.5 whitespace-nowrap">
        {icon}
        {label}
      </dt>
      <dd className={`${mono ? "font-mono text-xs leading-5" : ""} ${truncate ? "truncate" : "break-all"}`}>{value}</dd>
    </>
  );
}

function CapabilityRow({ capability }: { capability: CapabilityInfo }) {
  return (
    <tr className="border-b border-border last:border-b-0 hover:bg-muted/30 transition-colors">
      <td className="px-3 py-2">
        <Badge variant="outline" className="font-mono text-[11px]">
          {capability.namespace}
        </Badge>
      </td>
      <td className="px-3 py-2 text-muted-foreground">{capability.description}</td>
    </tr>
  );
}

function SkillRow({ skill }: { skill: SkillInfo }) {
  return (
    <tr className="border-b border-border last:border-b-0 hover:bg-muted/30 transition-colors">
      <td className="px-3 py-2">
        <Badge variant="outline" className="font-mono text-[11px]">
          {skill.name}
        </Badge>
      </td>
      <td className="px-3 py-2 text-muted-foreground">{skill.description}</td>
    </tr>
  );
}
