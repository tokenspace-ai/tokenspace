import { useNavigate } from "@tanstack/react-router";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { MessageSquareIcon, StarIcon } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Thread } from "@/components/app-sidebar";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

interface ChatCommandMenuContextValue {
  isOpen: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

const ChatCommandMenuContext = createContext<ChatCommandMenuContextValue | null>(null);

export function useChatCommandMenu(): ChatCommandMenuContextValue {
  const ctx = useContext(ChatCommandMenuContext);
  if (!ctx) throw new Error("useChatCommandMenu must be used within ChatCommandMenuProvider");
  return ctx;
}

interface ChatCommandMenuProviderProps {
  threads: Thread[];
  workspaceSlug: string;
  children: React.ReactNode;
}

export function ChatCommandMenuProvider({ threads, workspaceSlug, children }: ChatCommandMenuProviderProps) {
  const [isOpen, setIsOpen] = useState(false);

  const setOpen = useCallback((open: boolean) => setIsOpen(open), []);
  const toggle = useCallback(() => setIsOpen((prev) => !prev), []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggle]);

  const value = useMemo(() => ({ isOpen, setOpen, toggle }), [isOpen, setOpen, toggle]);

  return (
    <ChatCommandMenuContext.Provider value={value}>
      {children}
      <ChatCommandMenu threads={threads} workspaceSlug={workspaceSlug} isOpen={isOpen} setOpen={setOpen} />
    </ChatCommandMenuContext.Provider>
  );
}

function ChatCommandMenu({
  threads,
  workspaceSlug,
  isOpen,
  setOpen,
}: {
  threads: Thread[];
  workspaceSlug: string;
  isOpen: boolean;
  setOpen: (open: boolean) => void;
}) {
  const navigate = useNavigate();

  const handleSelect = useCallback(
    (chatId: Id<"chats">) => {
      setOpen(false);
      navigate({
        to: "/workspace/$slug/chat/$chatId",
        params: { slug: workspaceSlug, chatId },
      });
    },
    [navigate, workspaceSlug, setOpen],
  );

  return (
    <CommandDialog
      open={isOpen}
      onOpenChange={setOpen}
      title="Find Chat"
      description="Search chats by title"
      showCloseButton={false}
    >
      <CommandInput placeholder="Search chats..." />
      <CommandList>
        <CommandEmpty>No chats found.</CommandEmpty>
        <CommandGroup heading="Chats">
          {threads.map((thread) => (
            <CommandItem
              key={thread.id}
              value={`${thread.id}-${thread.title}`}
              onSelect={() => handleSelect(thread.id)}
              className="gap-2"
            >
              {thread.isStarred ? (
                <StarIcon className="size-4 fill-current text-yellow-500" />
              ) : (
                <MessageSquareIcon className="size-4" />
              )}
              <span className="truncate">{thread.title}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
