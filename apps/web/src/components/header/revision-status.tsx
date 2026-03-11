import { CheckCircle2, Clock, Loader2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type RevisionState = "building" | "ready" | "error" | "pending";

interface RevisionStatusProps {
  revisionId?: string;
  state: RevisionState;
  className?: string;
}

const stateConfig: Record<
  RevisionState,
  { icon: typeof Loader2; label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  building: {
    icon: Loader2,
    label: "Building",
    variant: "secondary",
  },
  ready: {
    icon: CheckCircle2,
    label: "Ready",
    variant: "default",
  },
  error: {
    icon: XCircle,
    label: "Error",
    variant: "destructive",
  },
  pending: {
    icon: Clock,
    label: "Pending",
    variant: "outline",
  },
};

export function RevisionStatus({ revisionId, state, className }: RevisionStatusProps) {
  const config = stateConfig[state];
  const Icon = config.icon;

  return (
    <div className={cn("flex items-center gap-2", className)}>
      {revisionId && <span className="text-xs text-muted-foreground font-mono">{revisionId.slice(-7)}</span>}
      <Badge variant={config.variant} className="gap-1">
        <Icon className={cn("size-3", state === "building" && "animate-spin")} />
        {config.label}
      </Badge>
    </div>
  );
}
