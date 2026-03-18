import { createFileRoute } from "@tanstack/react-router";
import { api } from "@tokenspace/backend/convex/_generated/api";
import { useAction } from "convex/react";
import { BookOpenIcon, BracesIcon, ChevronDownIcon, FileCode2Icon, Layers3Icon, Loader2Icon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WorkspaceFileIcon } from "@/components/workspace-file-icon";
import { useWorkspaceRevision } from "@/components/workspace-revision";

export const Route = createFileRoute("/_app/workspace/$slug/_app/capabilities")({
  component: CapabilitiesPage,
  ssr: false,
});

type CapabilityMethod = {
  name: string;
  signature: string;
  params: Array<{
    path: string;
    description: string;
  }>;
};

type CapabilityExplorerEntry = {
  namespace: string;
  name: string;
  description: string;
  capabilityPath: string;
  typesPath: string;
  iconPath?: string;
  markdown: string;
  declaration: string;
  methods: CapabilityMethod[];
};

function CapabilitiesPage() {
  const revisionId = useWorkspaceRevision();
  const loadExplorer = useAction(api.playground.getCapabilityExplorerForRevision);
  const [capabilities, setCapabilities] = useState<CapabilityExplorerEntry[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openByNamespace, setOpenByNamespace] = useState<Record<string, boolean>>({});
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    setError(null);

    loadExplorer({ revisionId })
      .then((result) => {
        if (requestIdRef.current !== requestId) {
          return;
        }
        setCapabilities(result);
      })
      .catch((nextError) => {
        if (requestIdRef.current !== requestId) {
          return;
        }
        console.error("Failed to load capability explorer:", nextError);
        setCapabilities(null);
        setError(nextError instanceof Error ? nextError.message : "Failed to load capabilities.");
      })
      .finally(() => {
        if (requestIdRef.current !== requestId) {
          return;
        }
        setIsLoading(false);
      });
  }, [loadExplorer, revisionId]);

  if (isLoading && !capabilities) {
    return (
      <ExplorerShell>
        <div className="flex items-center gap-2 rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
          Loading capabilities…
        </div>
      </ExplorerShell>
    );
  }

  if (error) {
    return (
      <ExplorerShell>
        <Alert variant="destructive">
          <Layers3Icon className="size-4" />
          <AlertTitle>Could not load capabilities</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </ExplorerShell>
    );
  }

  if (!capabilities || capabilities.length === 0) {
    return (
      <ExplorerShell>
        <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          This workspace does not currently advertise any capabilities.
        </div>
      </ExplorerShell>
    );
  }

  return (
    <ExplorerShell>
      <div className="space-y-3">
        {capabilities.map((capability) => {
          const isOpen = openByNamespace[capability.namespace] ?? false;
          return (
            <Collapsible
              key={capability.namespace}
              open={isOpen}
              onOpenChange={(open) =>
                setOpenByNamespace((current) => ({
                  ...current,
                  [capability.namespace]: open,
                }))
              }
            >
              <div className="rounded-xl border bg-card">
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="flex w-full items-start justify-between gap-4 px-4 py-4 text-left transition-colors hover:bg-muted/30"
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <WorkspaceFileIcon
                        name={capability.name}
                        filePath={capability.iconPath}
                        revisionId={revisionId}
                        className="size-10 rounded-lg border border-border/60 bg-background"
                        imageClassName="object-contain p-1.5"
                        fallbackClassName="text-sm"
                      />
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="text-sm font-semibold">{capability.name}</h2>
                          <Badge variant="outline" className="font-mono text-[11px]">
                            {capability.namespace}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground">{capability.description}</p>
                      </div>
                    </div>
                    <ChevronDownIcon
                      className={`mt-1 size-4 shrink-0 text-muted-foreground transition-transform ${isOpen ? "rotate-180" : ""}`}
                    />
                  </button>
                </CollapsibleTrigger>

                <CollapsibleContent className="border-t">
                  <div className="px-4 py-4">
                    <Tabs defaultValue="guide" className="gap-4">
                      <TabsList className="w-fit">
                        <TabsTrigger value="guide" className="gap-2">
                          <BookOpenIcon className="size-4" />
                          Guide
                        </TabsTrigger>
                        <TabsTrigger value="methods" className="gap-2">
                          <BracesIcon className="size-4" />
                          Methods
                        </TabsTrigger>
                        <TabsTrigger value="types" className="gap-2">
                          <FileCode2Icon className="size-4" />
                          .d.ts
                        </TabsTrigger>
                      </TabsList>

                      <TabsContent value="guide">
                        <CapabilityGuide markdown={capability.markdown} />
                      </TabsContent>

                      <TabsContent value="methods">
                        <CapabilityMethods methods={capability.methods} />
                      </TabsContent>

                      <TabsContent value="types">
                        <CapabilityDeclaration declaration={capability.declaration} />
                      </TabsContent>
                    </Tabs>
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>
          );
        })}
      </div>
    </ExplorerShell>
  );
}

function ExplorerShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 p-8">
        <div className="flex items-start gap-4">
          <div className="flex size-12 items-center justify-center rounded-2xl border bg-card">
            <Layers3Icon className="size-5 text-muted-foreground" />
          </div>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-lg font-semibold">Capabilities</h1>
              <Badge variant="outline">Revision snapshot</Badge>
            </div>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Browse the capabilities available in this workspace, inspect their guidance, and scan the exported methods
              exposed by the compiled revision.
            </p>
          </div>
        </div>

        {children}
      </div>
    </div>
  );
}

function CapabilityGuide({ markdown }: { markdown: string }) {
  return (
    <MessageResponse className="prose max-w-none text-sm leading-6 prose-headings:scroll-mt-20 prose-pre:border prose-pre:border-border/40 prose-pre:bg-secondary/70 prose-code:rounded prose-code:bg-secondary prose-code:px-1 prose-code:py-0.5">
      {markdown}
    </MessageResponse>
  );
}

function CapabilityMethods({ methods }: { methods: CapabilityMethod[] }) {
  if (methods.length === 0) {
    return (
      <div className="rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground">No callable methods found.</div>
    );
  }

  return (
    <div className="space-y-3">
      {methods.map((method) => (
        <div key={method.name} className="rounded-lg border bg-muted/10 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">{method.name}</h3>
            <Badge variant="secondary" className="text-[10px]">
              method
            </Badge>
          </div>
          <pre className="mt-3 overflow-x-auto rounded-md border border-border/60 bg-background p-3 font-mono text-xs leading-5 text-foreground">
            <code>{method.signature}</code>
          </pre>
          {method.params.length > 0 ? (
            <dl className="mt-3 space-y-2">
              {method.params.map((param) => (
                <div key={`${method.name}:${param.path}`} className="grid gap-1 sm:grid-cols-[180px_1fr] sm:gap-3">
                  <dt className="font-mono text-xs text-muted-foreground">{param.path}</dt>
                  <dd className="text-sm text-muted-foreground">{param.description}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function CapabilityDeclaration({ declaration }: { declaration: string }) {
  if (!declaration.trim()) {
    return (
      <div className="rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground">No declaration file found.</div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-slate-950 text-slate-50 shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/80 px-4 py-2">
        <div className="font-mono text-xs uppercase tracking-[0.22em] text-slate-400">Type Declarations</div>
        <div className="font-mono text-xs text-slate-500">capability.d.ts</div>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-xs leading-6 text-slate-100">
        <code>{declaration}</code>
      </pre>
    </div>
  );
}
