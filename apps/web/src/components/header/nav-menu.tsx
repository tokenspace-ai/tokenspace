import { Code2, FolderOpen, Menu, MessageSquare, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export type NavItem = "editor" | "revision-files" | "chat" | "playground";

interface NavMenuProps {
  currentItem?: NavItem;
  workspaceSlug?: string;
  onNavigate: (item: NavItem) => void;
  className?: string;
}

const navItems: Array<{ id: NavItem; label: string; icon: typeof Code2 }> = [
  { id: "editor", label: "Editor", icon: Code2 },
  { id: "revision-files", label: "Revision Files", icon: FolderOpen },
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "playground", label: "Playground", icon: TerminalSquare },
];

export function NavMenu({ currentItem, workspaceSlug, onNavigate, className }: NavMenuProps) {
  const currentNav = navItems.find((item) => item.id === currentItem);
  const CurrentIcon = currentNav?.icon ?? Menu;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className={cn("", className)}>
          <CurrentIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isDisabled = !workspaceSlug;
          return (
            <DropdownMenuItem
              key={item.id}
              onClick={() => onNavigate(item.id)}
              disabled={isDisabled}
              className={cn("flex items-center gap-2", item.id === currentItem && "bg-accent")}
            >
              <Icon className="size-4" />
              <span>{item.label}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
