import { Check, ChevronDown, GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
  onBranchChange: (branchId: string) => void;
  className?: string;
}

export function HeaderBranchSelector({
  branches,
  currentBranchId,
  onBranchChange,
  className,
}: HeaderBranchSelectorProps) {
  const currentBranch = branches.find((b) => b.id === currentBranchId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className={cn("gap-2", className)}>
          <GitBranch className="size-4" />
          <span className="truncate max-w-[100px]">{currentBranch?.name ?? "main"}</span>
          {currentBranch?.isDefault && (
            <span className="text-xs bg-primary/20 text-primary px-1.5 py-0.5 rounded">default</span>
          )}
          <ChevronDown className="size-3 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {branches.map((branch) => (
          <DropdownMenuItem
            key={branch.id}
            onClick={() => onBranchChange(branch.id)}
            className="flex items-center gap-2"
          >
            <Check className={cn("size-4 shrink-0", branch.id === currentBranchId ? "opacity-100" : "opacity-0")} />
            <GitBranch className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate">{branch.name}</span>
            {branch.isDefault && <span className="text-xs text-muted-foreground shrink-0">default</span>}
          </DropdownMenuItem>
        ))}

        {branches.length === 0 && (
          <DropdownMenuItem disabled className="text-muted-foreground">
            No branches available
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
