import { createFileRoute } from "@tanstack/react-router";
import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import { Loader2, MoreHorizontal } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { UserDisplay } from "@/components/user-display";
import { parseWorkspaceSlug } from "@/lib/workspace-slug";

export const Route = createFileRoute("/_app/workspace/$slug/admin/members")({
  component: MembersSettingsPage,
  ssr: false,
});

function MembersSettingsPage() {
  const { slug } = Route.useParams();
  const { workspaceSlug } = parseWorkspaceSlug(slug);
  const workspace = useQuery(api.workspace.getBySlug, { slug: workspaceSlug });

  const inviteUser = useMutation(api.workspace.inviteUser);
  const deleteWorkspaceMember = useMutation(api.workspace.deleteWorkspaceMember);
  const changeWorkspaceMemberRole = useMutation(api.workspace.changeWorkspaceMemberRole);
  const deleteInvitation = useMutation(api.workspace.deleteInvitation);
  const members = useQuery(
    api.workspace.listWorkspaceMembers,
    workspace?.role === "workspace_admin" ? { workspaceId: workspace._id } : "skip",
  );
  const pendingInvitations = useQuery(
    api.workspace.listWorkspaceInvitations,
    workspace?.role === "workspace_admin" ? { workspaceId: workspace._id, status: "pending" } : "skip",
  );

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"workspace_admin" | "member">("member");
  const [isInviting, setIsInviting] = useState(false);
  const [updatingMemberId, setUpdatingMemberId] = useState<Id<"workspaceMemberships"> | null>(null);
  const [deletingInvitationId, setDeletingInvitationId] = useState<Id<"workspaceInvitations"> | null>(null);

  if (workspace === undefined) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }
  if (workspace === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Workspace not found or access denied.</div>
      </div>
    );
  }

  const isWorkspaceAdmin = workspace.role === "workspace_admin";

  const handleInvite = async (e: FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim()) {
      toast.error("Email is required");
      return;
    }
    setIsInviting(true);
    try {
      await inviteUser({
        workspaceId: workspace._id,
        email: inviteEmail.trim(),
        role: inviteRole,
      });
      setInviteEmail("");
      toast.success("Invitation sent");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to send invitation");
      console.error(error);
    } finally {
      setIsInviting(false);
    }
  };

  const handleDeleteInvitation = async (invitationId: Id<"workspaceInvitations">) => {
    setDeletingInvitationId(invitationId);
    try {
      await deleteInvitation({ invitationId });
      toast.success("Invitation deleted");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete invitation");
      console.error(error);
    } finally {
      setDeletingInvitationId(null);
    }
  };

  const handleDeleteMember = async (membershipId: Id<"workspaceMemberships">) => {
    setUpdatingMemberId(membershipId);
    try {
      await deleteWorkspaceMember({ membershipId });
      toast.success("Member removed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to remove member");
      console.error(error);
    } finally {
      setUpdatingMemberId(null);
    }
  };

  const handleChangeMemberRole = async (
    membershipId: Id<"workspaceMemberships">,
    currentRole: "workspace_admin" | "member",
  ) => {
    const nextRole: "workspace_admin" | "member" = currentRole === "workspace_admin" ? "member" : "workspace_admin";
    setUpdatingMemberId(membershipId);
    try {
      await changeWorkspaceMemberRole({ membershipId, role: nextRole });
      toast.success(`Role changed to ${nextRole === "workspace_admin" ? "admin" : "member"}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to change member role");
      console.error(error);
    } finally {
      setUpdatingMemberId(null);
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl space-y-8 p-8">
        <div>
          <h1 className="text-lg font-semibold">Members</h1>
          <p className="text-sm text-muted-foreground">Manage workspace members and invitations.</p>
        </div>

        {!isWorkspaceAdmin && (
          <div className="rounded-lg border p-4 text-sm text-muted-foreground">
            You have member access to this tokenspace. Only workspace admins can manage members.
          </div>
        )}

        {isWorkspaceAdmin && (
          <>
            <form onSubmit={handleInvite} className="rounded-lg border bg-card p-4 space-y-3">
              <div>
                <h2 className="text-sm font-medium">Invite Member</h2>
                <p className="text-xs text-muted-foreground">Invite workspace admins and members by email.</p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="invite-email">Email</Label>
                <Input
                  id="invite-email"
                  type="email"
                  placeholder="user@example.com"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label>Role</Label>
                <Select
                  value={inviteRole}
                  onValueChange={(value) => setInviteRole(value as "workspace_admin" | "member")}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="member">Member</SelectItem>
                    <SelectItem value="workspace_admin">Workspace Admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex justify-end">
                <Button type="submit" disabled={isInviting || !inviteEmail.trim()}>
                  {isInviting ? (
                    <>
                      <Loader2 className="size-4 mr-2 animate-spin" />
                      Sending...
                    </>
                  ) : (
                    "Send Invitation"
                  )}
                </Button>
              </div>
            </form>

            <div className="rounded-lg border p-4 space-y-3">
              <h2 className="text-sm font-medium">Members</h2>
              {members === undefined ? (
                <p className="text-sm text-muted-foreground">Loading members...</p>
              ) : members.length > 0 ? (
                members.map((member) => (
                  <div key={member._id} className="flex items-center justify-between gap-3 text-sm">
                    <UserDisplay userId={member.userId} className="min-w-0 flex-1" />
                    <div className="flex items-center gap-1">
                      <Badge variant={member.role === "workspace_admin" ? "default" : "secondary"}>
                        {member.role === "workspace_admin" ? "admin" : "member"}
                      </Badge>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="size-7">
                            <MoreHorizontal className="size-4" />
                            <span className="sr-only">Member actions</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            disabled={updatingMemberId === member._id}
                            onClick={() => handleChangeMemberRole(member._id, member.role)}
                          >
                            {`Change to ${member.role === "workspace_admin" ? "member" : "admin"}`}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            disabled={updatingMemberId === member._id}
                            onClick={() => handleDeleteMember(member._id)}
                          >
                            {updatingMemberId === member._id ? "Removing..." : "Remove member"}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">No members found.</p>
              )}
            </div>

            <div className="rounded-lg border p-4 space-y-3">
              <h2 className="text-sm font-medium">Pending Invitations</h2>
              {pendingInvitations === undefined ? (
                <p className="text-sm text-muted-foreground">Loading invitations...</p>
              ) : pendingInvitations.length > 0 ? (
                pendingInvitations.map((invitation) => (
                  <div key={invitation._id} className="space-y-2 rounded-md border bg-muted/30 p-3">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <div className="min-w-0">
                        <span className="truncate">{invitation.email}</span>
                        <p className="text-xs text-muted-foreground">
                          Created {formatInvitationCreatedAt(invitation.createdAt)}
                        </p>
                        {invitation.isExpired && (
                          <p className="text-xs text-destructive">
                            Expired {formatInvitationExpiresAt(invitation.expiresAt)}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        <Badge variant="outline">
                          {invitation.role === "workspace_admin" ? "workspace admin" : "member"}
                        </Badge>
                        {invitation.isExpired && <Badge variant="destructive">expired</Badge>}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="size-7">
                              <MoreHorizontal className="size-4" />
                              <span className="sr-only">Invitation actions</span>
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              disabled={deletingInvitationId === invitation._id}
                              onClick={() => handleDeleteInvitation(invitation._id)}
                            >
                              {deletingInvitationId === invitation._id ? "Deleting..." : "Delete invitation"}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>Invited by</span>
                      <UserDisplay userId={invitation.invitedBy} mode="avatar" avatarClassName="size-5" />
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">No pending invitations.</p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function formatInvitationCreatedAt(createdAt: number): string {
  return new Date(createdAt).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatInvitationExpiresAt(expiresAt: number): string {
  return new Date(expiresAt).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
