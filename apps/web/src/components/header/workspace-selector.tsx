import { Link } from "@tanstack/react-router";
import { ArrowLeftRight, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WorkspaceIcon } from "@/components/workspace-icon";
import { cn } from "@/lib/utils";
import type { Workspace } from "@/types/workspace";

export type { Workspace } from "@/types/workspace";

interface WorkspaceSelectorProps {
  workspaces: Workspace[];
  currentWorkspaceSlug?: string;
  className?: string;
}

export function WorkspaceSelector({ workspaces, currentWorkspaceSlug, className }: WorkspaceSelectorProps) {
  const currentWorkspace = workspaces.find((w) => w.slug === currentWorkspaceSlug);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className={cn("gap-2", className)}>
          <WorkspaceIcon
            name={currentWorkspace?.name ?? "Tokenspace"}
            iconUrl={currentWorkspace?.iconUrl}
            className="size-4 rounded-sm"
            fallbackClassName="bg-transparent text-current"
          />
          <span className="truncate max-w-[140px]">{currentWorkspace?.name ?? "Select tokenspace"}</span>
          <ChevronDown className="size-3 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuItem asChild className="flex items-center gap-2">
          <Link to="/">
            <ArrowLeftRight className="size-4 shrink-0 text-muted-foreground" />
            <span>Switch workspace</span>
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
