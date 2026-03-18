import type { LucideIcon } from "lucide-react";
import { SparklesIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";

export function WorkspaceFeaturePlaceholder({
  title,
  description,
  icon: Icon,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
}) {
  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-8 p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="flex size-12 items-center justify-center rounded-2xl border bg-card">
              <Icon className="size-5 text-muted-foreground" />
            </div>
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-lg font-semibold">{title}</h1>
                <Badge variant="outline">Coming soon</Badge>
              </div>
              <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
            </div>
          </div>
        </div>

        <Alert>
          <SparklesIcon />
          <AlertTitle>Route scaffolded</AlertTitle>
          <AlertDescription>
            This page is intentionally live now so navigation can settle before the full feature ships.
          </AlertDescription>
        </Alert>
      </div>
    </div>
  );
}
