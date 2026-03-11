import { Check, ChevronDown, Clock, GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export type Branch = {
  id: string;
  name: string;
  isDefault: boolean;
};

interface HeaderBranchSelectorProps {
  branches: Branch[];
  currentBranchId?: string;
  includeWorkingState: boolean;
  workingStateHash?: string;
  onBranchChange: (branchId: string, includeWorkingState: boolean) => void;
  onToggleWorkingState: (include: boolean) => void;
  className?: string;
}

export function HeaderBranchSelector({
  branches,
  currentBranchId,
  includeWorkingState,
  workingStateHash,
  onBranchChange,
  onToggleWorkingState,
  className,
}: HeaderBranchSelectorProps) {
  const currentBranch = branches.find((b) => b.id === currentBranchId);
  const hasWorkingChanges = Boolean(workingStateHash);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className={cn("gap-2", className)}>
          <GitBranch className="size-4" />
          <span className="truncate max-w-[100px]">{currentBranch?.name ?? "main"}</span>
          {currentBranch?.isDefault && (
            <span className="text-xs bg-primary/20 text-primary px-1.5 py-0.5 rounded">default</span>
          )}
          {includeWorkingState && hasWorkingChanges && (
            <span className="text-xs bg-amber-500/20 text-amber-600 dark:text-amber-400 px-1.5 py-0.5 rounded">
              working
            </span>
          )}
          <ChevronDown className="size-3 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {branches.map((branch) => (
          <DropdownMenuItem
            key={branch.id}
            onClick={() => onBranchChange(branch.id, includeWorkingState)}
            className="flex items-center gap-2"
          >
            <Check
              className={cn(
                "size-4 shrink-0",
                branch.id === currentBranchId && !includeWorkingState ? "opacity-100" : "opacity-0",
              )}
            />
            <GitBranch className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate">{branch.name}</span>
            {branch.isDefault && <span className="text-xs text-muted-foreground shrink-0">default</span>}
          </DropdownMenuItem>
        ))}

        {hasWorkingChanges && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onToggleWorkingState(!includeWorkingState)}
              className="flex items-center gap-2"
            >
              <Check className={cn("size-4 shrink-0", includeWorkingState ? "opacity-100" : "opacity-0")} />
              <Clock className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <span className="flex-1">Include working state</span>
              {workingStateHash && (
                <span className="text-xs text-muted-foreground font-mono">{workingStateHash.slice(0, 7)}</span>
              )}
            </DropdownMenuItem>
          </>
        )}

        {branches.length === 0 && (
          <DropdownMenuItem disabled className="text-muted-foreground">
            No branches available
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
