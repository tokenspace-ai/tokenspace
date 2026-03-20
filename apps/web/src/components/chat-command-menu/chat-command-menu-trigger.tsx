import { SearchIcon } from "lucide-react";
import { Kbd } from "@/components/ui/kbd";
import { SidebarGroup, SidebarMenuButton, useSidebar } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useModifierKey } from "@/hooks/use-modifier-key";
import { useChatCommandMenu } from "./chat-command-menu-provider";

export function ChatCommandMenuTrigger() {
  const { setOpen } = useChatCommandMenu();
  const { open: sidebarOpen } = useSidebar();
  const modifierKey = useModifierKey();

  const handleClick = () => {
    setOpen(true);
  };

  if (!sidebarOpen) {
    return (
      <SidebarGroup className="py-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <SidebarMenuButton onClick={handleClick} className="h-9 justify-center">
              <SearchIcon className="size-4" />
            </SidebarMenuButton>
          </TooltipTrigger>
          <TooltipContent side="right">
            <span>Find ({modifierKey}K)</span>
          </TooltipContent>
        </Tooltip>
      </SidebarGroup>
    );
  }

  return (
    <SidebarGroup className="py-0">
      <SidebarMenuButton
        onClick={handleClick}
        className="h-9 justify-start gap-2 border border-input bg-background/50 hover:bg-accent hover:text-accent-foreground"
      >
        <SearchIcon className="size-4 text-muted-foreground" />
        <span className="flex-1 text-muted-foreground text-sm">Find...</span>
        <Kbd>{modifierKey}K</Kbd>
      </SidebarMenuButton>
    </SidebarGroup>
  );
}
