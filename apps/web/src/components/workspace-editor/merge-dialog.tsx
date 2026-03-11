import { GitMerge, Loader2 } from "lucide-react";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { Branch } from "./branch-selector";

interface MergeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceBranch?: Branch;
  targetBranch?: Branch;
  onConfirm: () => Promise<void>;
}

export function MergeDialog({ open, onOpenChange, sourceBranch, targetBranch, onConfirm }: MergeDialogProps) {
  const [isMerging, setIsMerging] = useState(false);

  const handleMerge = async () => {
    setIsMerging(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setIsMerging(false);
    }
  };

  if (!sourceBranch || !targetBranch) return null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <GitMerge className="size-5" />
            Merge Branch
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>
                You are about to merge{" "}
                <code className="bg-muted px-1.5 py-0.5 rounded font-mono text-foreground">{sourceBranch.name}</code>{" "}
                into{" "}
                <code className="bg-muted px-1.5 py-0.5 rounded font-mono text-foreground">{targetBranch.name}</code>.
              </p>
              <p className="text-sm">
                This will bring all commits from{" "}
                <span className="font-medium text-foreground">{sourceBranch.name}</span> into{" "}
                <span className="font-medium text-foreground">{targetBranch.name}</span>.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isMerging}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleMerge} disabled={isMerging}>
            {isMerging ? (
              <>
                <Loader2 className="size-4 mr-2 animate-spin" />
                Merging...
              </>
            ) : (
              <>
                <GitMerge className="size-4 mr-2" />
                Merge
              </>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
