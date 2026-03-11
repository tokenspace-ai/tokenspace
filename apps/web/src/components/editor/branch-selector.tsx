import type { Doc, Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { GitBranchIcon } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface BranchSelectorProps {
  branches: Doc<"branches">[];
  selectedBranchId: Id<"branches"> | null;
  onSelectBranch: (branchId: Id<"branches">) => void;
  isLoading?: boolean;
}

export function BranchSelector({ branches, selectedBranchId, onSelectBranch, isLoading }: BranchSelectorProps) {
  if (isLoading) {
    return (
      <div className="flex h-8 w-40 items-center gap-2 rounded-md border bg-muted/30 px-3">
        <GitBranchIcon className="size-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">Loading...</span>
      </div>
    );
  }

  if (branches.length === 0) {
    return (
      <div className="flex h-8 w-40 items-center gap-2 rounded-md border bg-muted/30 px-3">
        <GitBranchIcon className="size-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">No branches</span>
      </div>
    );
  }

  const selectedBranch = branches.find((b) => b._id === selectedBranchId);

  return (
    <Select value={selectedBranchId ?? undefined} onValueChange={(value) => onSelectBranch(value as Id<"branches">)}>
      <SelectTrigger size="sm" className="w-fit min-w-40">
        <GitBranchIcon className="size-4 text-muted-foreground" />
        <SelectValue placeholder="Select branch">{selectedBranch?.name ?? "Select branch"}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {branches.map((branch) => (
          <SelectItem key={branch._id} value={branch._id}>
            <span className="flex items-center gap-2">
              {branch.name}
              {branch.isDefault && (
                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">default</span>
              )}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
