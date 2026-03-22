import { Check, ChevronDown, GitBranch, GitMerge, MoreHorizontal, Plus, Star, Trash2 } from "lucide-react";
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

interface BranchSelectorProps {
  branches: Branch[];
  currentBranchId?: string;
  onBranchChange: (branchId: string) => void;
  onCreateBranch: () => void;
  onMergeBranch?: (sourceBranchId: string) => void;
  onSetDefaultBranch?: (branchId: string) => void;
  onDeleteBranch?: (branchId: string) => void;
  className?: string;
}

export function BranchSelector({
  branches,
  currentBranchId,
  onBranchChange,
  onCreateBranch,
  onMergeBranch,
  onSetDefaultBranch,
  onDeleteBranch,
  className,
}: BranchSelectorProps) {
  const currentBranch = branches.find((b) => b.id === currentBranchId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className={cn("gap-2", className)}>
          <GitBranch className="size-4" />
          <span className="truncate max-w-[120px]">{currentBranch?.name ?? "Select branch state"}</span>
          {currentBranch?.isDefault && (
            <span className="text-xs bg-primary/20 text-primary px-1.5 py-0.5 rounded">main</span>
          )}
          <ChevronDown className="size-3 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {branches.map((branch) => (
          <div key={branch.id} className="flex items-center group">
            <DropdownMenuItem onClick={() => onBranchChange(branch.id)} className="flex-1 flex items-center gap-2">
              <Check className={cn("size-4 shrink-0", branch.id === currentBranchId ? "opacity-100" : "opacity-0")} />
              <GitBranch className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate">{branch.name}</span>
              {branch.isDefault && <span className="text-xs text-muted-foreground shrink-0">default</span>}
            </DropdownMenuItem>
            {/* Branch actions menu */}
            {(onMergeBranch || onSetDefaultBranch || onDeleteBranch) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity mr-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <MoreHorizontal className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="right" className="w-48">
                  {onMergeBranch && !branch.isDefault && (
                    <DropdownMenuItem onClick={() => onMergeBranch(branch.id)}>
                      <GitMerge className="size-4 mr-2" />
                      Merge into main
                    </DropdownMenuItem>
                  )}
                  {onSetDefaultBranch && !branch.isDefault && (
                    <DropdownMenuItem onClick={() => onSetDefaultBranch(branch.id)}>
                      <Star className="size-4 mr-2" />
                      Set as main
                    </DropdownMenuItem>
                  )}
                  {(onMergeBranch || onSetDefaultBranch) && onDeleteBranch && !branch.isDefault && (
                    <DropdownMenuSeparator />
                  )}
                  {onDeleteBranch && (
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => onDeleteBranch(branch.id)}
                      disabled={branch.isDefault}
                    >
                      <Trash2 className="size-4 mr-2" />
                      Delete branch state
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        ))}
        {branches.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onClick={onCreateBranch} className="gap-2">
          <Plus className="size-4" />
          Create draft state
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
