import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { getSignInUrl, type User } from "@workos/authkit-tanstack-react-start";
import { useAction, useQuery as useConvexQuery, useMutation } from "convex/react";
import { FolderGit2, MoreHorizontal, Plus, ServerIcon, UserPlus2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { UserMenu } from "@/components/header/user-menu";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkspaceIcon } from "@/components/workspace-icon";
import { useAuth } from "@/hooks/use-auth";
import { getInvalidWorkspaceSlugReason } from "@/lib/workspace-slug";

export const Route = createFileRoute("/")({
  component: HomeComponent,
});

function HomeComponent() {
  const { loading, user, signOut } = useAuth();
  const healthCheck = useQuery(convexQuery(api.health.check, {}));

  return (
    <div className="min-h-svh flex flex-col">
      <header className="border-b border-border/50 px-6 py-4">
        <div className="mx-auto max-w-4xl flex items-center justify-between">
          <Logo className="h-8 w-auto" />
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <div
                className={`size-1.5 rounded-full ${healthCheck.data === "OK" ? "bg-green-500" : healthCheck.isLoading ? "bg-orange-400" : "bg-red-500"}`}
              />
              <span className="text-muted-foreground text-xs">
                {healthCheck.isLoading ? "Connecting..." : healthCheck.data === "OK" ? "Online" : "Offline"}
              </span>
            </div>
            {user ? <UserMenu user={user} onSignOut={signOut} /> : <ThemeToggle />}
          </div>
        </div>
      </header>

      <main className="flex-1 px-6 py-8">
        <div className="mx-auto max-w-4xl">
          {loading ? <Loading /> : user ? <LoggedIn user={user} /> : <NotLoggedIn />}
        </div>
      </main>
    </div>
  );
}

function NotLoggedIn() {
  const handleLoginClick = useCallback(() => {
    getSignInUrl({ data: { returnPathname: window.location.pathname } }).then((url) => {
      window.location.href = url;
    });
  }, []);
  return (
    <div className="flex justify-center">
      <Button onClick={handleLoginClick}>Login</Button>
    </div>
  );
}

function LoggedIn({ user }: { user: User }) {
  const workspaces = useConvexQuery(api.workspace.list);
  const invitations = useConvexQuery(api.workspace.listPendingInvitations);
  const acceptInvitation = useMutation(api.workspace.acceptInvitation);
  const dismissInvitation = useMutation(api.workspace.dismissInvitation);
  const refreshInvitationsAfterSignup = useAction(api.workspace.refreshInvitationsAfterSignup);
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

  useEffect(() => {
    refreshInvitationsAfterSignup({}).catch((e) => {
      console.error(e);
    });
  }, []);

  return (
    <div className="space-y-6">
      {invitations && invitations.length > 0 && (
        <section className="space-y-4">
          <div className="flex items-center gap-2">
            <UserPlus2 className="size-5 text-primary" />
            <h2 className="font-semibold">Invitations</h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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

      {/* Tokenspaces Section */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FolderGit2 className="size-5 text-primary" />
            <h2 className="font-semibold">Tokenspaces</h2>
          </div>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-9">
                  <MoreHorizontal className="size-4" />
                  <span className="sr-only">More actions</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <Link to="/executors">
                    <ServerIcon className="size-4 mr-2" />
                    Manage executors
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <CreateWorkspaceDialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen} userId={user?.id} />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {workspaces === undefined ? (
            [1, 2].map((i) => <WorkspaceCardSkeleton key={i} />)
          ) : workspaces.length === 0 ? (
            <div className="col-span-full">
              <EmptyState onCreateClick={() => setIsCreateDialogOpen(true)} />
            </div>
          ) : (
            workspaces.map((workspace, index) => (
              <WorkspaceCard key={workspace._id} workspace={workspace} index={index} />
            ))
          )}
        </div>
      </section>
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
    workspaceId: Id<"workspaces">;
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
  const formattedDate = new Date(invitation.invitedAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardHeader className="pb-3">
        <div className="flex items-start gap-3 min-w-0">
          <WorkspaceIcon
            name={invitation.workspaceName}
            iconUrl={invitation.iconUrl}
            className="size-10 rounded-lg border"
            fallbackClassName="bg-muted text-muted-foreground"
          />
          <div className="space-y-1.5 flex-1 min-w-0">
            <CardTitle className="text-lg font-semibold truncate">{invitation.workspaceName}</CardTitle>
            <CardDescription className="text-xs">
              Invited as {invitation.role === "workspace_admin" ? "workspace admin" : "member"} on {formattedDate}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex gap-2">
        <Button onClick={onAccept} disabled={isProcessing} size="sm">
          Accept
        </Button>
        <Button onClick={onDismiss} disabled={isProcessing} size="sm" variant="outline">
          Dismiss
        </Button>
      </CardContent>
    </Card>
  );
}

function Loading() {
  return <div>Loading...</div>;
}

interface WorkspaceCardProps {
  workspace: {
    _id: Id<"workspaces">;
    name: string;
    slug: string;
    iconUrl?: string;
    activeCommitId?: Id<"commits">;
    createdAt: number;
    updatedAt: number;
  };
  index: number;
}

function WorkspaceCard({ workspace, index }: WorkspaceCardProps) {
  const formattedDate = new Date(workspace.updatedAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <Link
      to="/workspace/$slug"
      params={{ slug: workspace.slug }}
      className="block"
      style={{
        animationDelay: `${index * 50}ms`,
        animation: "fadeInUp 0.4s ease-out backwards",
      }}
    >
      <Card className="group relative overflow-hidden transition-all duration-300 hover:shadow-lg hover:shadow-primary/10 hover:border-primary/30 h-full">
        <div className="absolute inset-0 bg-linear-to-br from-primary/5 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />

        <CardHeader className="pb-3">
          <div className="flex items-start gap-3 min-w-0">
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
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="flex items-center gap-2 flex-wrap">
            {workspace.activeCommitId && (
              <Badge variant="default" className="text-xs">
                Active
              </Badge>
            )}
          </div>

          <div className="pt-2 border-t border-border/50">
            <span className="text-xs text-muted-foreground">Updated {formattedDate}</span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function WorkspaceCardSkeleton() {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <div className="space-y-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-24" />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Skeleton className="h-5 w-20 rounded-full" />
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
    <div className="flex flex-col items-center justify-center py-12 px-6 text-center rounded-lg border border-dashed">
      <FolderGit2 className="size-10 text-muted-foreground mb-4" />
      <h3 className="font-medium mb-1">No tokenspaces yet</h3>
      <p className="text-muted-foreground text-sm mb-4">Create your first tokenspace to get started.</p>
      <Button onClick={onCreateClick} size="sm" className="gap-2">
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

  const handleNameChange = (value: string) => {
    setName(value);
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

      await initializeWorkspace({ workspaceId });

      toast.success(`Tokenspace "${name}" created successfully`);
      onOpenChange(false);

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
        <Button size="sm" className="gap-1.5">
          <Plus className="size-4" />
          New
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
