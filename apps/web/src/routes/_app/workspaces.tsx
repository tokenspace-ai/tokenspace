import { createFileRoute, Link } from "@tanstack/react-router";
import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { useMutation, useQuery } from "convex/react";
import {
  Code2,
  FolderGit2,
  MessageSquareIcon,
  MoreHorizontal,
  Plus,
  TerminalIcon,
  Trash2,
  UserPlus2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkspaceIcon } from "@/components/workspace-icon";
import { getInvalidWorkspaceSlugReason } from "@/lib/workspace-slug";

export const Route = createFileRoute("/_app/workspaces")({
  component: WorkspacesPage,
});

function WorkspacesPage() {
  const { user } = useAuth();
  const workspaces = useQuery(api.workspace.list);
  const invitations = useQuery(api.workspace.listPendingInvitations);
  const acceptInvitation = useMutation(api.workspace.acceptInvitation);
  const dismissInvitation = useMutation(api.workspace.dismissInvitation);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [processingInvitationId, setProcessingInvitationId] = useState<Id<"workspaceInvitations"> | null>(null);

  const handleAcceptInvitation = async (invitationId: Id<"workspaceInvitations">, workspaceName: string) => {
    setProcessingInvitationId(invitationId);
    try {
      await acceptInvitation({ invitationId });
      toast.success(`Joined "${workspaceName}"`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to accept invitation");
    } finally {
      setProcessingInvitationId(null);
    }
  };

  const handleDismissInvitation = async (invitationId: Id<"workspaceInvitations">) => {
    setProcessingInvitationId(invitationId);
    try {
      await dismissInvitation({ invitationId });
      toast.success("Invitation dismissed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to dismiss invitation");
    } finally {
      setProcessingInvitationId(null);
    }
  };

  return (
    <div className="min-h-screen bg-linear-to-br from-background via-background to-muted/20">
      {/* Decorative background elements */}
      <div className="fixed inset-0 -z-10 overflow-hidden pointer-events-none">
        <div className="absolute -top-1/2 -right-1/2 w-[800px] h-[800px] rounded-full bg-linear-to-br from-primary/5 via-primary/3 to-transparent blur-3xl" />
        <div className="absolute -bottom-1/2 -left-1/2 w-[600px] h-[600px] rounded-full bg-linear-to-tr from-chart-2/8 via-chart-2/3 to-transparent blur-3xl" />
      </div>

      <div className="container mx-auto px-6 py-12 max-w-6xl">
        {/* Header */}
        <header className="mb-12">
          <div className="flex items-center justify-between">
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-linear-to-br from-primary/20 to-primary/5 border border-primary/10">
                  <FolderGit2 className="size-6 text-primary" />
                </div>
                <h1 className="text-3xl font-bold tracking-tight bg-linear-to-r from-foreground to-foreground/70 bg-clip-text">
                  Tokenspaces
                </h1>
              </div>
              <p className="text-muted-foreground text-lg ml-14">Manage your code, documentation, and integrations</p>
            </div>

            <CreateWorkspaceDialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen} userId={user?.id} />
          </div>
        </header>

        {invitations && invitations.length > 0 && (
          <section className="mb-10 space-y-4">
            <div className="flex items-center gap-2">
              <UserPlus2 className="size-5 text-primary" />
              <h2 className="font-semibold">Invitations</h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {invitations.map((invitation) => (
                <InvitationCard
                  key={invitation.invitationId}
                  invitation={invitation}
                  isProcessing={processingInvitationId === invitation.invitationId}
                  onAccept={() => handleAcceptInvitation(invitation.invitationId, invitation.workspaceName)}
                  onDismiss={() => handleDismissInvitation(invitation.invitationId)}
                />
              ))}
            </div>
          </section>
        )}

        {/* Workspaces Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {workspaces === undefined ? (
            // Loading skeletons
            [1, 2, 3].map((i) => <WorkspaceCardSkeleton key={i} />)
          ) : workspaces.length === 0 ? (
            // Empty state
            <div className="col-span-full">
              <EmptyState onCreateClick={() => setIsCreateDialogOpen(true)} />
            </div>
          ) : (
            // Workspace cards
            workspaces.map((workspace, index) => (
              <WorkspaceCard key={workspace._id} workspace={workspace} index={index} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function InvitationCard({
  invitation,
  isProcessing,
  onAccept,
  onDismiss,
}: {
  invitation: {
    invitationId: Id<"workspaceInvitations">;
    workspaceName: string;
    workspaceSlug: string;
    role: "workspace_admin" | "member";
    invitedAt: number;
    iconUrl?: string;
  };
  isProcessing: boolean;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-3">
          <WorkspaceIcon
            name={invitation.workspaceName}
            iconUrl={invitation.iconUrl}
            className="size-10 rounded-lg border"
            fallbackClassName="bg-muted text-muted-foreground"
          />
          <div className="min-w-0">
            <CardTitle className="text-base truncate">{invitation.workspaceName}</CardTitle>
            <CardDescription className="text-xs">
              {invitation.role === "workspace_admin" ? "workspace admin" : "member"}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex gap-2">
        <Button size="sm" onClick={onAccept} disabled={isProcessing}>
          Accept
        </Button>
        <Button size="sm" variant="outline" onClick={onDismiss} disabled={isProcessing}>
          Dismiss
        </Button>
      </CardContent>
    </Card>
  );
}

interface WorkspaceCardProps {
  workspace: {
    _id: Id<"workspaces">;
    name: string;
    slug: string;
    role?: "workspace_admin" | "member";
    iconUrl?: string;
    activeRevisionId?: Id<"revisions">;
    createdAt: number;
    updatedAt: number;
  };
  index: number;
}

function WorkspaceCard({ workspace, index }: WorkspaceCardProps) {
  const removeWorkspace = useMutation(api.workspace.remove);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await removeWorkspace({ workspaceId: workspace._id });
      toast.success(`Tokenspace "${workspace.name}" deleted`);
      setIsDeleteDialogOpen(false);
    } catch (error) {
      toast.error("Failed to delete tokenspace");
      console.error(error);
    } finally {
      setIsDeleting(false);
    }
  };

  const formattedDate = new Date(workspace.updatedAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <Card
      className="group relative overflow-hidden transition-all duration-300 hover:shadow-lg hover:shadow-primary/5 hover:border-primary/20"
      style={{
        animationDelay: `${index * 50}ms`,
        animation: "fadeInUp 0.4s ease-out backwards",
      }}
    >
      {/* Hover gradient overlay */}
      <div className="absolute inset-0 bg-linear-to-br from-primary/3 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />

      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3 min-w-0 flex-1">
            <WorkspaceIcon
              name={workspace.name}
              iconUrl={workspace.iconUrl}
              className="size-10 rounded-lg border"
              fallbackClassName="bg-muted text-muted-foreground"
            />
            <div className="space-y-1.5 flex-1 min-w-0">
              <CardTitle className="text-lg font-semibold truncate">{workspace.name}</CardTitle>
              <CardDescription className="flex items-center gap-2 font-mono text-xs">
                <span className="truncate">{workspace.slug}</span>
              </CardDescription>
            </div>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link to="/workspace/$slug" params={{ slug: workspace.slug }}>
                  <Code2 className="size-4 mr-2" />
                  Open Tokenspace
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to="/workspace/$slug/playground" params={{ slug: workspace.slug }}>
                  <TerminalIcon className="size-4 mr-2" />
                  Playground
                </Link>
              </DropdownMenuItem>
              {workspace.role === "workspace_admin" && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => setIsDeleteDialogOpen(true)}
                    disabled={isDeleting}
                  >
                    <Trash2 className="size-4 mr-2" />
                    {isDeleting ? "Deleting..." : "Delete"}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Status badges */}
        <div className="flex items-center gap-2 flex-wrap">
          {workspace.activeRevisionId && (
            <Badge variant="default" className="text-xs">
              Active
            </Badge>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between pt-2 border-t border-border/50">
          <span className="text-xs text-muted-foreground">Updated {formattedDate}</span>
          <Button asChild size="sm" variant="ghost" className="gap-1.5 -mr-2">
            <Link to="/workspace/$slug" params={{ slug: workspace.slug }}>
              <MessageSquareIcon className="size-3.5" />
              Open
            </Link>
          </Button>
        </div>
      </CardContent>

      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Tokenspace</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <span className="font-semibold text-foreground">{workspace.name}</span>?
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function WorkspaceCardSkeleton() {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-start gap-3">
          <Skeleton className="size-10 rounded-lg shrink-0" />
          <div className="space-y-2 flex-1">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-24" />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Skeleton className="h-5 w-20 rounded-full" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
        <div className="flex items-center justify-between pt-2 border-t border-border/50">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-8 w-16" />
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyState({ onCreateClick }: { onCreateClick: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 px-6 text-center">
      <div className="p-4 rounded-2xl bg-linear-to-br from-muted/80 to-muted/40 border border-border/50 mb-6">
        <FolderGit2 className="size-12 text-muted-foreground" />
      </div>
      <h2 className="text-xl font-semibold mb-2">No tokenspaces yet</h2>
      <p className="text-muted-foreground max-w-md mb-8">
        Create your first tokenspace to start managing code, documentation, and integrations for your agents.
      </p>
      <Button onClick={onCreateClick} className="gap-2">
        <Plus className="size-4" />
        Create Tokenspace
      </Button>
    </div>
  );
}

interface CreateWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId?: string;
}

function CreateWorkspaceDialog({ open, onOpenChange, userId }: CreateWorkspaceDialogProps) {
  const createWorkspace = useMutation(api.workspace.create);
  const initializeWorkspace = useMutation(api.vcs.initializeWorkspace);
  const [isCreating, setIsCreating] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");

  // Auto-generate slug from name
  const handleNameChange = (value: string) => {
    setName(value);
    // Generate slug: lowercase, replace spaces with hyphens, remove special chars
    const generatedSlug = value
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    setSlug(generatedSlug);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim() || !slug.trim()) {
      toast.error("Name and slug are required");
      return;
    }

    const invalidSlugReason = getInvalidWorkspaceSlugReason(slug.trim());
    if (invalidSlugReason) {
      toast.error(invalidSlugReason);
      return;
    }

    if (!userId) {
      toast.error("You must be logged in to create a tokenspace");
      return;
    }

    setIsCreating(true);
    try {
      const workspaceId = await createWorkspace({
        name: name.trim(),
        slug: slug.trim(),
      });

      // Initialize the workspace with VCS (empty commit on main branch)
      await initializeWorkspace({ workspaceId });

      toast.success(`Tokenspace "${name}" created successfully`);
      onOpenChange(false);

      // Reset form
      setName("");
      setSlug("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create tokenspace");
      console.error(error);
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button className="gap-2 shadow-lg shadow-primary/10">
          <Plus className="size-4" />
          New Tokenspace
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleCreate}>
          <DialogHeader>
            <DialogTitle>Create Tokenspace</DialogTitle>
            <DialogDescription>Set up a new tokenspace for managing code, docs, and configurations.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-6">
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                placeholder="My Tokenspace"
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                autoFocus
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="slug">Slug</Label>
              <Input
                id="slug"
                placeholder="my-tokenspace"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                URL-friendly identifier. Will be used in the tokenspace URL.
              </p>
            </div>
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={isCreating || !name.trim() || !slug.trim()}>
              {isCreating ? "Creating..." : "Create Tokenspace"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
