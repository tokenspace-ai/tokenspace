import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { Brain, CheckCircle2, FileCode2, FileText, Loader2, Package, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

export type CompileResult = {
  revisionId: Id<"revisions">;
  revisionFs: {
    declarationCount: number;
    fileCount: number;
    systemCount: number;
  };
  compilerVersion?: string;
  sourceFingerprint?: string;
  artifactFingerprint?: string;
};

export type CompileStatus = "idle" | "compiling" | "success" | "error";

interface CompileSidebarProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: CompileStatus;
  result: CompileResult | null;
  error: string | null;
  onCompile: () => void;
  includeWorkingState: boolean;
  onIncludeWorkingStateChange: (include: boolean) => void;
  hasWorkingChanges: boolean;
}

export function CompileSidebar({
  open,
  onOpenChange,
  status,
  result,
  error,
  onCompile,
  includeWorkingState,
  onIncludeWorkingStateChange,
  hasWorkingChanges,
}: CompileSidebarProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[400px] sm:max-w-[400px] flex flex-col p-0">
        <SheetHeader className="px-4 py-3 border-b">
          <SheetTitle className="flex items-center gap-2">
            <Package className="size-4" />
            Compile Workspace
          </SheetTitle>
        </SheetHeader>
        <ScrollArea className="flex-1">
          <div className="p-4 space-y-6">
            {/* Options */}
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Options</h3>
              <label className="flex items-start gap-3 p-3 rounded-lg border bg-card hover:bg-muted/50 transition-colors cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeWorkingState}
                  onChange={(e) => onIncludeWorkingStateChange(e.target.checked)}
                  className="mt-0.5 rounded border-border"
                  disabled={!hasWorkingChanges}
                />
                <div className="space-y-1">
                  <div className="text-sm font-medium">Include working changes</div>
                  <div className="text-xs text-muted-foreground">
                    {hasWorkingChanges
                      ? "Compile uncommitted changes along with the committed state"
                      : "No working changes to include"}
                  </div>
                </div>
              </label>
            </div>

            {/* Compile Button */}
            <Button onClick={onCompile} disabled={status === "compiling"} className="w-full gap-2" size="lg">
              {status === "compiling" ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Compiling...
                </>
              ) : (
                <>
                  <Package className="size-4" />
                  Compile
                </>
              )}
            </Button>

            {/* Status */}
            {status === "success" && result && (
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
                  <CheckCircle2 className="size-5" />
                  <span className="font-medium">Compilation successful</span>
                </div>

                {/* Stats */}
                <div className="space-y-3">
                  <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                    Artifacts Generated
                  </h3>
                  <div className="grid gap-3">
                    <div className="flex items-center gap-3 p-3 rounded-lg border bg-card">
                      <div className="p-2 rounded-md bg-blue-500/10">
                        <FileCode2 className="size-4 text-blue-500" />
                      </div>
                      <div>
                        <div className="text-sm font-medium">
                          {`${result.revisionFs.declarationCount} Declaration${
                            result.revisionFs.declarationCount !== 1 ? "s" : ""
                          }`}
                        </div>
                        <div className="text-xs text-muted-foreground">Type definitions for APIs</div>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 p-3 rounded-lg border bg-card">
                      <div className="p-2 rounded-md bg-amber-500/10">
                        <FileText className="size-4 text-amber-500" />
                      </div>
                      <div>
                        <div className="text-sm font-medium">
                          {`${result.revisionFs.fileCount} Passthrough File${
                            result.revisionFs.fileCount !== 1 ? "s" : ""
                          }`}
                        </div>
                        <div className="text-xs text-muted-foreground">Docs, memory, skills, and other files</div>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 p-3 rounded-lg border bg-card">
                      <div className="p-2 rounded-md bg-purple-500/10">
                        <Brain className="size-4 text-purple-500" />
                      </div>
                      <div>
                        <div className="text-sm font-medium">
                          {`${result.revisionFs.systemCount} System File${result.revisionFs.systemCount !== 1 ? "s" : ""}`}
                        </div>
                        <div className="text-xs text-muted-foreground">Platform-injected content</div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Revision ID */}
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Revision</h3>
                  <div className="p-3 rounded-lg border bg-muted/30 font-mono text-xs break-all">
                    {result.revisionId}
                  </div>
                </div>

                {(result.compilerVersion || result.sourceFingerprint || result.artifactFingerprint) && (
                  <div className="space-y-2">
                    <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Build Details</h3>
                    <div className="space-y-2 text-xs">
                      {result.compilerVersion && (
                        <div className="p-2 rounded border bg-muted/30">
                          <span className="font-medium">Compiler:</span> {result.compilerVersion}
                        </div>
                      )}
                      {result.sourceFingerprint && (
                        <div className="p-2 rounded border bg-muted/30 break-all">
                          <span className="font-medium">Source fingerprint:</span> {result.sourceFingerprint}
                        </div>
                      )}
                      {result.artifactFingerprint && (
                        <div className="p-2 rounded border bg-muted/30 break-all">
                          <span className="font-medium">Artifact fingerprint:</span> {result.artifactFingerprint}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {status === "error" && error && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
                  <XCircle className="size-5" />
                  <span className="font-medium">Compilation failed</span>
                </div>
                <div className="p-3 rounded-lg border border-red-500/20 bg-red-500/5 text-sm text-red-600 dark:text-red-400">
                  {error}
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
