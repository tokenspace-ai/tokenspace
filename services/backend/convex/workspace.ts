import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  type ActionCtx,
  action,
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from "./_generated/server";
import { workos } from "./auth";
import { requireAuthenticatedUser, requireWorkspaceAdmin, requireWorkspaceMember } from "./authz";
import { loadFileContent } from "./fs/fileBlobs";
import { RESEND_FROM_ADDRESS, renderTokenspaceEmailHtml, resend } from "./resend";
import {
  ensureValidWorkspaceModels,
  getDefaultWorkspaceModels,
  getWorkspaceModelId,
  parseWorkspaceModelsYaml,
  resolveDefaultModel,
  serializeWorkspaceModelsYaml,
  vWorkspaceModelDefinition,
  type WorkspaceModelDefinition,
} from "./workspaceMetadata";

const vWorkspaceRole = v.union(v.literal("workspace_admin"), v.literal("member"));
const vWorkspaceInvitationStatus = v.union(
  v.literal("pending"),
  v.literal("accepted"),
  v.literal("dismissed"),
  v.literal("revoked"),
);

type WorkspaceInvitationStatus = "pending" | "accepted" | "dismissed" | "revoked";
type WorkosUser = { id: string; email?: string | null };
type WorkosUserDetails = {
  id: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
};
const WORKSPACE_INVITATION_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function assertValidInviteEmail(email: string): void {
  if (!email) {
    throw new Error("Email is required");
  }
  if (!email.includes("@")) {
    throw new Error("Invalid email address");
  }
}

function getInvalidWorkspaceSlugReason(slug: string): string | null {
  if (slug.includes(":")) {
    return "Workspace slugs cannot contain ':'. Reserved delimiters ':' and '@' are used for branch and revision URLs.";
  }
  if (slug.includes("@")) {
    return "Workspace slugs cannot contain '@'. Reserved delimiters ':' and '@' are used for branch and revision URLs.";
  }
  return null;
}

function isInvitationRecipient(
  user: { subject: string; email?: string | null },
  invitation: { invitedUserId?: string; email: string },
): boolean {
  if (invitation.invitedUserId) {
    return invitation.invitedUserId === user.subject;
  }
  const normalizedUserEmail = normalizeEmail(user.email ?? "");
  return normalizedUserEmail.length > 0 && normalizedUserEmail === invitation.email;
}

function getFirstWorkosUser(result: unknown): WorkosUser | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const maybeData = (result as { data?: unknown }).data;
  if (!Array.isArray(maybeData) || maybeData.length === 0) {
    return null;
  }
  const first = maybeData[0];
  if (!first || typeof first !== "object" || typeof (first as { id?: unknown }).id !== "string") {
    return null;
  }
  return first as WorkosUser;
}

function getWorkosInvitationId(result: unknown): string | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const directId = (result as { id?: unknown }).id;
  if (typeof directId === "string") {
    return directId;
  }
  const dataId = (result as { data?: { id?: unknown } }).data?.id;
  if (typeof dataId === "string") {
    return dataId;
  }
  return null;
}

function isInvalidWorkosRoleError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("role is invalid");
}

function isWorkOSNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.name === "NotFoundException";
}

function formatUserDisplayName(user: WorkosUserDetails | null, fallback: string): string {
  if (!user) {
    return fallback;
  }
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  if (fullName) {
    return fullName;
  }
  if (user.email) {
    return user.email;
  }
  return fallback;
}

function getWorkspaceInviteUrl(): string {
  const baseUrl = process.env.TOKENSPACE_APP_URL?.trim() || "https://app.tokenspace.ai";
  return `${baseUrl.replace(/\/$/, "")}/`;
}

function getResendFromAddress(): string {
  return RESEND_FROM_ADDRESS;
}

function getInvitationExpiresAt(invitation: { createdAt: number }): number {
  return invitation.createdAt + WORKSPACE_INVITATION_EXPIRATION_MS;
}

function isInvitationExpired(invitation: { createdAt: number }, now: number = Date.now()): boolean {
  return now >= getInvitationExpiresAt(invitation);
}

async function assertNotLastWorkspaceAdmin(ctx: MutationCtx, membership: Doc<"workspaceMemberships">): Promise<void> {
  if (membership.role !== "workspace_admin") {
    return;
  }
  const workspaceMemberships = await ctx.db
    .query("workspaceMemberships")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", membership.workspaceId))
    .collect();
  const hasOtherAdmin = workspaceMemberships.some(
    (workspaceMembership) =>
      workspaceMembership._id !== membership._id && workspaceMembership.role === "workspace_admin",
  );
  if (!hasOtherAdmin) {
    throw new Error("Cannot remove or demote the last workspace admin");
  }
}

export const getMembershipByWorkspaceAndUserInternal = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("workspaceMemberships")
      .withIndex("by_workspace_user", (q) => q.eq("workspaceId", args.workspaceId).eq("userId", args.userId))
      .first();
  },
});

export const upsertMembershipInternal = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    userId: v.string(),
    role: vWorkspaceRole,
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("workspaceMemberships")
      .withIndex("by_workspace_user", (q) => q.eq("workspaceId", args.workspaceId).eq("userId", args.userId))
      .first();
    const now = Date.now();
    if (existing) {
      const nextRole = existing.role === "workspace_admin" ? "workspace_admin" : args.role;
      await ctx.db.patch(existing._id, {
        role: nextRole,
        updatedAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert("workspaceMemberships", {
      workspaceId: args.workspaceId,
      userId: args.userId,
      role: args.role,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Create a new workspace
 */
export const create = mutation({
  args: {
    name: v.string(),
    slug: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireAuthenticatedUser(ctx);
    const invalidSlugReason = getInvalidWorkspaceSlugReason(args.slug);
    if (invalidSlugReason) {
      throw new Error(invalidSlugReason);
    }

    // Check if slug already exists
    const existing = await ctx.db
      .query("workspaces")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();

    if (existing) {
      throw new Error(`Workspace with slug "${args.slug}" already exists`);
    }

    const now = Date.now();
    const workspaceId = await ctx.db.insert("workspaces", {
      name: args.name,
      slug: args.slug,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.runMutation(internal.workspace.upsertMembershipInternal, {
      workspaceId,
      userId: user.subject,
      role: "workspace_admin",
    });

    return workspaceId;
  },
});

/**
 * Get a workspace by ID
 */
export const get = query({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceMember(ctx, args.workspaceId);
    return await ctx.db.get(args.workspaceId);
  },
});

/**
 * Get a workspace by ID (internal)
 */
export const getInternal = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.workspaceId);
  },
});

/**
 * Get a workspace by slug
 */
export const getBySlug = query({
  args: {
    slug: v.string(),
  },
  handler: async (ctx, args) => {
    await requireAuthenticatedUser(ctx);
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();

    if (!workspace) {
      return null;
    }

    try {
      const { membership } = await requireWorkspaceMember(ctx, workspace._id);
      return { ...workspace, role: membership.role, ...(await resolveWorkspaceIcon(ctx, workspace)) };
    } catch (e) {
      if (e instanceof Error && e.message.includes("Unauthorized")) {
        return null;
      }
      throw e;
    }
  },
});

export const refreshInvitationsAfterSignup = action({
  args: {},
  handler: async (ctx, _args) => {
    const user = await requireAuthenticatedUser(ctx);
    const workosUser = await workos.userManagement.getUser(user.subject);
    const normalizedEmail = normalizeEmail(workosUser.email ?? "");
    if (normalizedEmail) {
      const invites = await ctx.runQuery(internal.workspace.listPendingInvitationsByEmail, {
        email: normalizedEmail,
      });
      for (const invitation of invites) {
        if (invitation.workosInvitationId && !invitation.invitedUserId) {
          try {
            const workosInvitation = await workos.userManagement.getInvitation(invitation.workosInvitationId);
            if (
              workosInvitation.acceptedUserId === user.subject &&
              workosInvitation.organizationId === process.env.WORKOS_ORG_ID
            ) {
              await ctx.runMutation(internal.workspace.patchInvitationInternal, {
                invitationId: invitation._id,
                invitedUserId: user.subject,
                workosInvitationId: undefined,
              });
            }
          } catch (e) {
            console.error("Error getting workos invitation", e);
          }
        }
      }
    }
  },
});

export const listPendingInvitationsByEmail = internalQuery({
  args: {
    email: v.string(),
  },
  handler: async (ctx, args) => {
    const invitations = await ctx.db
      .query("workspaceInvitations")
      .withIndex("by_email_status", (q) => q.eq("email", args.email).eq("status", "pending"))
      .collect();
    const now = Date.now();
    return invitations.filter((invitation) => !isInvitationExpired(invitation, now));
  },
});

/**
 * List all workspaces
 */
export const list = query({
  handler: async (ctx) => {
    const user = await requireAuthenticatedUser(ctx);
    if (user.role === "admin") {
      const allWorkspaces = await ctx.db.query("workspaces").collect();
      const workspaces = await Promise.all(
        allWorkspaces.map(async (workspace) => ({
          ...workspace,
          role: "workspace_admin" as const,
          ...(await resolveWorkspaceIcon(ctx, workspace)),
        })),
      );
      return workspaces;
    }

    const memberships = await ctx.db
      .query("workspaceMemberships")
      .withIndex("by_user", (q) => q.eq("userId", user.subject))
      .collect();

    const workspaces = await Promise.all(
      memberships.map(async (membership) => {
        const workspace = await ctx.db.get(membership.workspaceId);
        if (!workspace) {
          return null;
        }
        return {
          ...workspace,
          role: membership.role,
          ...(await resolveWorkspaceIcon(ctx, workspace)),
        };
      }),
    );
    return workspaces.filter(
      (workspace): workspace is Exclude<(typeof workspaces)[number], null> => workspace !== null,
    );
  },
});

export const listPendingInvitations = query({
  handler: async (ctx) => {
    const user = await requireAuthenticatedUser(ctx);
    const invitationsById = new Map<string, Doc<"workspaceInvitations">>();
    const now = Date.now();

    const byUser = await ctx.db
      .query("workspaceInvitations")
      .withIndex("by_invited_user_status", (q) => q.eq("invitedUserId", user.subject).eq("status", "pending"))
      .collect();
    for (const invitation of byUser) {
      invitationsById.set(invitation._id, invitation);
    }

    const invitations = [...invitationsById.values()].filter((invitation) => !isInvitationExpired(invitation, now));
    const pendingInvitations = await Promise.all(
      invitations.map(async (invitation) => {
        const workspace = await ctx.db.get(invitation.workspaceId);
        if (!workspace) {
          return null;
        }
        return {
          invitationId: invitation._id,
          workspaceId: workspace._id,
          workspaceName: workspace.name,
          workspaceSlug: workspace.slug,
          role: invitation.role,
          invitedAt: invitation.createdAt,
          iconUrl: await resolveBlobDownloadUrl(ctx, workspace.iconBlobId),
        };
      }),
    );
    return pendingInvitations.filter(
      (invitation): invitation is Exclude<(typeof pendingInvitations)[number], null> => invitation !== null,
    );
  },
});

export const listWorkspaceInvitations = query({
  args: {
    workspaceId: v.id("workspaces"),
    status: v.optional(vWorkspaceInvitationStatus),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAdmin(ctx, args.workspaceId);
    const status: WorkspaceInvitationStatus = args.status ?? "pending";
    const invitations = await ctx.db
      .query("workspaceInvitations")
      .withIndex("by_workspace_status", (q) => q.eq("workspaceId", args.workspaceId).eq("status", status))
      .collect();
    const now = Date.now();
    return invitations.map(({ invitedUserId: _, ...invitation }) => ({
      ...invitation,
      isExpired: invitation.status === "pending" && isInvitationExpired(invitation, now),
      expiresAt: getInvitationExpiresAt(invitation),
    }));
  },
});

export const listWorkspaceMembers = query({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAdmin(ctx, args.workspaceId);
    const memberships = await ctx.db
      .query("workspaceMemberships")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    return memberships.sort((a, b) => {
      if (a.role !== b.role) {
        return a.role === "workspace_admin" ? -1 : 1;
      }
      return a.createdAt - b.createdAt;
    });
  },
});

export const deleteWorkspaceMember = mutation({
  args: {
    membershipId: v.id("workspaceMemberships"),
  },
  handler: async (ctx, args) => {
    const membership = await ctx.db.get(args.membershipId);
    if (!membership) {
      throw new Error("Membership not found");
    }
    await requireWorkspaceAdmin(ctx, membership.workspaceId);
    await assertNotLastWorkspaceAdmin(ctx, membership);
    await ctx.db.delete(membership._id);
  },
});

export const changeWorkspaceMemberRole = mutation({
  args: {
    membershipId: v.id("workspaceMemberships"),
    role: vWorkspaceRole,
  },
  handler: async (ctx, args) => {
    const membership = await ctx.db.get(args.membershipId);
    if (!membership) {
      throw new Error("Membership not found");
    }
    await requireWorkspaceAdmin(ctx, membership.workspaceId);
    if (membership.role === "workspace_admin" && args.role !== "workspace_admin") {
      await assertNotLastWorkspaceAdmin(ctx, membership);
    }
    await ctx.db.patch(membership._id, {
      role: args.role,
      updatedAt: Date.now(),
    });
  },
});

export const inviteUser = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    email: v.string(),
    role: vWorkspaceRole,
  },
  handler: async (ctx, args) => {
    const { user } = await requireWorkspaceAdmin(ctx, args.workspaceId);
    const email = normalizeEmail(args.email);
    assertValidInviteEmail(email);

    const existingPending = await ctx.db
      .query("workspaceInvitations")
      .withIndex("by_workspace_email_status", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("email", email).eq("status", "pending"),
      )
      .first();

    let invitationId: Id<"workspaceInvitations">;
    if (existingPending) {
      if (existingPending.role !== args.role) {
        await ctx.db.patch(existingPending._id, {
          role: args.role,
          updatedAt: Date.now(),
        });
      }
      invitationId = existingPending._id;
    } else {
      invitationId = await ctx.db.insert("workspaceInvitations", {
        workspaceId: args.workspaceId,
        email,
        role: args.role,
        status: "pending",
        invitedBy: user.subject,
        invitedUserId: undefined,
        workosInvitationId: undefined,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        acceptedAt: undefined,
        dismissedAt: undefined,
        revokedAt: undefined,
      });
    }

    await ctx.scheduler.runAfter(0, internal.workspace.sendInvitation, {
      invitationId,
    });

    return invitationId;
  },
});

export const sendExistingUserInvitationEmail = internalAction({
  args: {
    invitationId: v.id("workspaceInvitations"),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const invitation = await ctx.runQuery(internal.workspace.getInvitationInternal, {
      invitationId: args.invitationId,
    });
    if (
      !invitation ||
      invitation.status !== "pending" ||
      invitation.invitedUserId !== args.userId ||
      isInvitationExpired(invitation)
    ) {
      return;
    }

    const workspace = await ctx.runQuery(internal.workspace.getInternal, {
      workspaceId: invitation.workspaceId,
    });
    if (!workspace) {
      return;
    }

    let invitedUser: WorkosUserDetails | null = null;
    try {
      invitedUser = (await workos.userManagement.getUser(args.userId)) as WorkosUserDetails;
    } catch (error) {
      if (!isWorkOSNotFoundError(error)) {
        throw error;
      }
    }

    let inviterUser: WorkosUserDetails | null = null;
    try {
      inviterUser = (await workos.userManagement.getUser(invitation.invitedBy)) as WorkosUserDetails;
    } catch (error) {
      if (!isWorkOSNotFoundError(error)) {
        throw error;
      }
    }

    const recipientEmail = normalizeEmail(invitedUser?.email ?? invitation.email);
    assertValidInviteEmail(recipientEmail);
    const inviterName = formatUserDisplayName(inviterUser, "A workspace admin");
    const roleLabel = invitation.role === "workspace_admin" ? "workspace admin" : "member";
    const workspaceName = workspace.name;
    const inviteUrl = getWorkspaceInviteUrl();
    const subject = `${inviterName} invited you to ${workspaceName} on TokenSpace`;
    const inviteeName = formatUserDisplayName(invitedUser, recipientEmail);

    const invitationHtml = renderTokenspaceEmailHtml({
      previewText: `Set up your TokenSpace account for ${workspaceName}.`,
      headline: `${inviterName} invited you to ${workspaceName}`,
      bodyText: `You've been invited to join ${workspaceName} on TokenSpace as a ${roleLabel}.`,
      ctaText: "Open TokenSpace",
      ctaUrl: inviteUrl,
      footerText: "This invitation expires in 7 days.",
      disclaimerText: `If you didn't request to join ${workspaceName}, you can safely ignore this email. Someone else might have typed your email address by mistake.`,
    });

    await resend.sendEmail(ctx, {
      from: getResendFromAddress(),
      to: recipientEmail,
      subject,
      text: [
        `Hi ${inviteeName},`,
        "",
        `${inviterName} invited you to join "${workspaceName}" as a ${roleLabel}.`,
        "",
        "Review and accept your invitation here:",
        inviteUrl,
      ].join("\n"),
      html: invitationHtml,
    });
  },
});

export const sendInvitation = internalAction({
  args: {
    invitationId: v.id("workspaceInvitations"),
  },
  handler: async (ctx, args) => {
    const invitation = await ctx.runQuery(internal.workspace.getInvitationInternal, {
      invitationId: args.invitationId,
    });
    if (!invitation || invitation.status !== "pending") {
      return;
    }
    if (isInvitationExpired(invitation)) {
      return;
    }

    if (invitation.invitedUserId || invitation.workosInvitationId) {
      return;
    }

    const workosUsers = await workos.userManagement.listUsers({
      email: invitation.email,
      organizationId: process.env.WORKOS_ORG_ID,
    });
    const existingUser = getFirstWorkosUser(workosUsers);

    if (existingUser) {
      await ctx.runMutation(internal.workspace.patchInvitationInternal, {
        invitationId: invitation._id,
        invitedUserId: existingUser.id,
      });
      await ctx.scheduler.runAfter(0, internal.workspace.sendExistingUserInvitationEmail, {
        invitationId: invitation._id,
        userId: existingUser.id,
      });
      return;
    }

    const organizationId = process.env.WORKOS_ORG_ID?.trim();
    if (!organizationId) {
      throw new Error("WORKOS_ORG_ID is required to send organization invitations");
    }

    let workosInvitation: unknown;
    try {
      workosInvitation = await workos.userManagement.sendInvitation({
        email: invitation.email,
        organizationId,
        inviterUserId: invitation.invitedBy,
        roleSlug: "member",
      });
    } catch (error) {
      if (!isInvalidWorkosRoleError(error)) {
        throw error;
      }
      workosInvitation = await workos.userManagement.sendInvitation({
        email: invitation.email,
        organizationId,
        inviterUserId: invitation.invitedBy,
      });
    }

    const workosInvitationId = getWorkosInvitationId(workosInvitation);
    if (!workosInvitationId) {
      throw new Error("WorkOS invitation response did not include an invitation id");
    }

    await ctx.runMutation(internal.workspace.patchInvitationInternal, {
      invitationId: invitation._id,
      workosInvitationId,
    });
  },
});

export const getInvitationInternal = internalQuery({
  args: {
    invitationId: v.id("workspaceInvitations"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.invitationId);
  },
});

export const patchInvitationInternal = internalMutation({
  args: {
    invitationId: v.id("workspaceInvitations"),
    invitedUserId: v.optional(v.string()),
    workosInvitationId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.invitationId, {
      invitedUserId: args.invitedUserId,
      workosInvitationId: args.workosInvitationId,
      updatedAt: Date.now(),
    });
  },
});

export const acceptInvitation = mutation({
  args: {
    invitationId: v.id("workspaceInvitations"),
  },
  handler: async (ctx, args) => {
    const user = await requireAuthenticatedUser(ctx);
    const invitation = await ctx.db.get(args.invitationId);
    if (!invitation) {
      throw new Error("Invitation not found");
    }
    if (invitation.status !== "pending") {
      throw new Error("Invitation is no longer pending");
    }
    if (isInvitationExpired(invitation)) {
      throw new Error("Invitation has expired");
    }
    if (!isInvitationRecipient(user, invitation)) {
      throw new Error("Unauthorized");
    }

    await ctx.runMutation(internal.workspace.upsertMembershipInternal, {
      workspaceId: invitation.workspaceId,
      userId: user.subject,
      role: invitation.role,
    });

    const now = Date.now();
    await ctx.db.patch(invitation._id, {
      status: "accepted",
      invitedUserId: user.subject,
      acceptedAt: now,
      updatedAt: now,
    });

    return {
      workspaceId: invitation.workspaceId,
    };
  },
});

export const dismissInvitation = mutation({
  args: {
    invitationId: v.id("workspaceInvitations"),
  },
  handler: async (ctx, args) => {
    const user = await requireAuthenticatedUser(ctx);
    const invitation = await ctx.db.get(args.invitationId);
    if (!invitation) {
      throw new Error("Invitation not found");
    }
    if (invitation.status !== "pending") {
      throw new Error("Invitation is no longer pending");
    }
    if (!isInvitationRecipient(user, invitation)) {
      throw new Error("Unauthorized");
    }

    const now = Date.now();
    await ctx.db.patch(invitation._id, {
      status: "dismissed",
      invitedUserId: invitation.invitedUserId ?? user.subject,
      dismissedAt: now,
      updatedAt: now,
    });
  },
});

export const deleteInvitation = mutation({
  args: {
    invitationId: v.id("workspaceInvitations"),
  },
  handler: async (ctx, args) => {
    const invitation = await ctx.db.get(args.invitationId);
    if (!invitation) {
      throw new Error("Invitation not found");
    }
    if (invitation.status !== "pending") {
      throw new Error("Only pending invitations can be deleted");
    }

    await requireWorkspaceAdmin(ctx, invitation.workspaceId);

    const now = Date.now();
    await ctx.db.patch(invitation._id, {
      status: "revoked",
      revokedAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Update workspace settings
 */
export const update = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAdmin(ctx, args.workspaceId);
    const workspace = await ctx.db.get(args.workspaceId);
    if (!workspace) {
      throw new Error("Workspace not found");
    }

    const updates: Partial<{
      name: string;
      updatedAt: number;
    }> = {
      updatedAt: Date.now(),
    };

    if (args.name !== undefined) updates.name = args.name;

    await ctx.db.patch(args.workspaceId, updates);
  },
});

const vWorkspaceIconMimeType = v.union(v.literal("image/png"), v.literal("image/svg+xml"));

export const setWorkspaceIconInternal = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    iconBlobId: v.id("blobs"),
    iconMimeType: vWorkspaceIconMimeType,
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.workspaceId, {
      iconBlobId: args.iconBlobId,
      iconMimeType: args.iconMimeType,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Resolve upload strategy for a workspace icon.
 */
export const getIconUploadMetadata = action({
  args: {
    workspaceId: v.id("workspaces"),
    hash: v.string(),
    size: v.number(),
    mimeType: v.string(),
  },
  returns: v.union(
    v.object({
      kind: v.literal("existing"),
      blobId: v.id("blobs"),
    }),
    v.object({
      kind: v.literal("upload"),
      uploadUrl: v.string(),
    }),
  ),
  handler: async (
    ctx,
    args,
  ): Promise<{ kind: "existing"; blobId: Id<"blobs"> } | { kind: "upload"; uploadUrl: string }> => {
    await requireWorkspaceAdmin(ctx, args.workspaceId);

    const workspace = await ctx.runQuery(internal.workspace.getInternal, {
      workspaceId: args.workspaceId,
    });
    if (!workspace) {
      throw new Error("Workspace not found");
    }

    const hash = args.hash.trim();
    if (!hash) {
      throw new Error("Icon hash is required");
    }
    if (args.size <= 0 || args.size > WORKSPACE_ICON_MAX_BYTES) {
      throw new Error(`Icon must be between 1 byte and ${WORKSPACE_ICON_MAX_BYTES} bytes`);
    }
    if (!isSupportedWorkspaceIconMimeType(args.mimeType)) {
      throw new Error("Icon must be a PNG or SVG image");
    }

    const existing = await ctx.runQuery(internal.content.getBlobByHash, {
      workspaceId: args.workspaceId,
      hash,
    });

    if (existing) {
      return { kind: "existing" as const, blobId: existing._id };
    }

    const uploadUrl = await ctx.storage.generateUploadUrl();
    return { kind: "upload" as const, uploadUrl };
  },
});

/**
 * Save an uploaded icon for a workspace.
 */
export const setUploadedIcon = action({
  args: {
    workspaceId: v.id("workspaces"),
    mimeType: v.string(),
    blobId: v.optional(v.id("blobs")),
    storageId: v.optional(v.id("_storage")),
    hash: v.optional(v.string()),
    size: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAdmin(ctx, args.workspaceId);

    const workspace = await ctx.runQuery(internal.workspace.getInternal, {
      workspaceId: args.workspaceId,
    });
    if (!workspace) {
      throw new Error("Workspace not found");
    }
    if (!isSupportedWorkspaceIconMimeType(args.mimeType)) {
      throw new Error("Icon must be a PNG or SVG image");
    }

    let canonicalMimeType: WorkspaceIconMimeType | null = null;
    let iconBlobId: Id<"blobs">;
    if (args.blobId) {
      const existingBlob = await ctx.runQuery(internal.content.getBlob, { blobId: args.blobId });
      if (!existingBlob || existingBlob.workspaceId !== args.workspaceId) {
        throw new Error("Icon blob not found");
      }
      canonicalMimeType = await detectIconMimeTypeFromBlobId(ctx, args.blobId);
      if (!canonicalMimeType) {
        throw new Error("Icon blob must contain a PNG or SVG image");
      }
      iconBlobId = args.blobId;
    } else {
      const hash = args.hash?.trim();
      const size = args.size ?? 0;
      if (!args.storageId || !hash || size <= 0 || size > WORKSPACE_ICON_MAX_BYTES) {
        throw new Error("Uploaded icon metadata is incomplete");
      }

      canonicalMimeType = await detectIconMimeTypeFromStorageId(ctx, args.storageId);
      if (!canonicalMimeType) {
        throw new Error("Uploaded icon must be a PNG or SVG image");
      }

      const existingBlob = await ctx.runQuery(internal.content.getBlobByHash, {
        workspaceId: args.workspaceId,
        hash,
      });

      if (existingBlob) {
        await cleanupStorageObject(ctx, args.storageId);
        iconBlobId = existingBlob._id;
      } else {
        iconBlobId = await ctx.runMutation(internal.content.insertBlobRecord, {
          workspaceId: args.workspaceId,
          hash,
          storageId: args.storageId,
          size,
          content: undefined,
        });
      }
    }

    if (!canonicalMimeType) {
      throw new Error("Icon must be a PNG or SVG image");
    }

    await ctx.runMutation(internal.workspace.setWorkspaceIconInternal, {
      workspaceId: args.workspaceId,
      iconBlobId,
      iconMimeType: canonicalMimeType,
    });
  },
});

/**
 * Remove an uploaded icon from a workspace.
 */
export const clearUploadedIcon = mutation({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAdmin(ctx, args.workspaceId);

    const workspace = await ctx.db.get(args.workspaceId);
    if (!workspace) {
      throw new Error("Workspace not found");
    }

    await ctx.db.patch(args.workspaceId, {
      iconBlobId: undefined,
      iconMimeType: undefined,
      updatedAt: Date.now(),
    });
  },
});

async function setActiveRevisionHandler(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    revisionId: Id<"revisions">;
  },
): Promise<void> {
  const workspace = await ctx.db.get(args.workspaceId);
  if (!workspace) {
    throw new Error("Workspace not found");
  }

  const revision = await ctx.db.get(args.revisionId);
  if (!revision) {
    throw new Error("Revision not found");
  }

  if (revision.workspaceId !== args.workspaceId) {
    throw new Error("Revision does not belong to this workspace");
  }

  await ctx.db.patch(args.workspaceId, {
    activeRevisionId: args.revisionId,
    updatedAt: Date.now(),
  });
}

/**
 * Publish a revision for a workspace.
 */
export const setActiveRevision = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    revisionId: v.id("revisions"),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAdmin(ctx, args.workspaceId);
    await setActiveRevisionHandler(ctx, args);
  },
});

export const setActiveRevisionInternal = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    revisionId: v.id("revisions"),
  },
  handler: async (ctx, args) => {
    await setActiveRevisionHandler(ctx, args);
  },
});

/**
 * Get the published revision for a workspace.
 */
export const getActiveRevision = query({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceMember(ctx, args.workspaceId);
    const workspace = await ctx.db.get(args.workspaceId);
    if (!workspace) {
      throw new Error("Workspace not found");
    }

    if (!workspace.activeRevisionId) {
      return null;
    }

    return await ctx.db.get(workspace.activeRevisionId);
  },
});

/**
 * Resolve workspace context from a slug string.
 * Parses formats like:
 * - "workspace" -> workspace only (runtime resolves from active revision)
 * - "workspace:branch-state" -> workspace + specific admin branch state
 */
export const resolveWorkspaceContext = query({
  args: {
    slug: v.string(),
  },
  handler: async (ctx, args) => {
    await requireAuthenticatedUser(ctx);
    const [contextSlug, revisionId] = args.slug.split("@");
    // Parse the slug: "workspace", "workspace:branch-state", "workspace:branch-state:legacy-hash"
    const parts = (contextSlug ?? "").split(":");
    const [workspaceSlug, branchName] = parts;

    if (!workspaceSlug && !revisionId) {
      throw new Error("Workspace slug is required");
    }

    if (revisionId) {
      const revision = await ctx.db.get(revisionId as Id<"revisions">);
      if (!revision) {
        throw new Error(`Revision "${revisionId}" not found`);
      }
      const workspace = await ctx.db.get(revision.workspaceId);
      if (!workspace) {
        throw new Error("Workspace for revision not found");
      }
      if (workspaceSlug && workspace.slug !== workspaceSlug) {
        throw new Error(`Revision "${revisionId}" does not belong to workspace "${workspaceSlug}"`);
      }
      const branch = await ctx.db.get(revision.branchId);
      const branchState = branch
        ? await ctx.db
            .query("branchStates")
            .withIndex("by_backing_branch", (q) => q.eq("backingBranchId", branch._id))
            .filter((q) => q.eq(q.field("archivedAt"), undefined))
            .first()
        : null;
      const { membership } = await requireWorkspaceMember(ctx, workspace._id);

      return {
        workspace: {
          ...workspace,
          role: membership.role,
          ...(await resolveWorkspaceIcon(ctx, workspace)),
        },
        branchState,
        branch,
        revisionId: revision._id,
        effectiveSlug: buildSlug(workspace.slug, branchState?.name ?? branch?.name, revision._id),
      };
    }

    const resolvedWorkspaceSlug = workspaceSlug;
    if (!resolvedWorkspaceSlug) {
      throw new Error("Workspace slug is required");
    }

    // Get workspace by slug
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_slug", (q) => q.eq("slug", resolvedWorkspaceSlug))
      .first();

    if (!workspace) {
      throw new Error(`Workspace "${resolvedWorkspaceSlug}" not found`);
    }

    const { membership } = await requireWorkspaceMember(ctx, workspace._id);

    let branchState: Awaited<ReturnType<typeof ctx.db.get<"branchStates">>> | null = null;
    if (branchName) {
      branchState = await ctx.db
        .query("branchStates")
        .withIndex("by_name", (q) => q.eq("workspaceId", workspace._id).eq("name", branchName))
        .filter((q) => q.eq(q.field("archivedAt"), undefined))
        .first();
    } else {
      branchState = await ctx.db
        .query("branchStates")
        .withIndex("by_workspace_main", (q) => q.eq("workspaceId", workspace._id).eq("isMain", true))
        .filter((q) => q.eq(q.field("archivedAt"), undefined))
        .first();
    }

    // Get backing branch - either from branch state or legacy branch lookup.
    let branch: Awaited<ReturnType<typeof ctx.db.get<"branches">>> | null = null;
    if (branchState) {
      branch = await ctx.db.get(branchState.backingBranchId);
    } else if (branchName) {
      branch = await ctx.db
        .query("branches")
        .withIndex("by_name", (q) => q.eq("workspaceId", workspace._id).eq("name", branchName))
        .first();
      if (!branch) {
        branchState = await ctx.db
          .query("branchStates")
          .withIndex("by_workspace_main", (q) => q.eq("workspaceId", workspace._id).eq("isMain", true))
          .filter((q) => q.eq(q.field("archivedAt"), undefined))
          .first();
        branch = branchState
          ? await ctx.db.get(branchState.backingBranchId)
          : await ctx.db
              .query("branches")
              .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
              .filter((q) => q.eq(q.field("isDefault"), true))
              .first();
      }
    } else {
      // Get default branch
      branch = await ctx.db
        .query("branches")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
        .filter((q) => q.eq(q.field("isDefault"), true))
        .first();
    }

    return {
      workspace: {
        ...workspace,
        role: membership.role,
        ...(await resolveWorkspaceIcon(ctx, workspace)),
      },
      branchState,
      branch,
      revisionId: workspace.activeRevisionId,
      // Computed slug for URL building
      effectiveSlug: buildSlug(resolvedWorkspaceSlug, branchState?.name ?? branch?.name),
    };
  },
});

/**
 * Build a slug string from components
 */
function buildSlug(workspaceSlug: string, branchName?: string, revisionId?: Id<"revisions">): string {
  if (revisionId) return `${workspaceSlug}@${revisionId}`;
  if (branchName && branchName !== "main") return `${workspaceSlug}:${branchName}`;
  return workspaceSlug;
}

const WORKSPACE_ICON_MAX_BYTES = 5 * 1024 * 1024;
const ROOT_WORKSPACE_ICON_PATHS = ["icon.svg", "icon.png"] as const;
const SUPPORTED_WORKSPACE_ICON_MIME_TYPES = new Set(["image/png", "image/svg+xml"]);
const MODELS_FILE_PATH = "src/models.yaml";
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

type WorkspaceReadCtx = ActionCtx | QueryCtx | MutationCtx;
type WorkspaceWriteCtx = ActionCtx | MutationCtx;
type WorkspaceDoc = Doc<"workspaces">;
type WorkspaceIconMimeType = "image/png" | "image/svg+xml";

function isSupportedWorkspaceIconMimeType(mimeType: string): boolean {
  return SUPPORTED_WORKSPACE_ICON_MIME_TYPES.has(mimeType);
}

function isPngSignature(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) {
    return false;
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      return false;
    }
  }
  return true;
}

function looksLikeSvg(content: string): boolean {
  const normalized = content.replace(/^\uFEFF/, "").trimStart();
  if (!normalized) {
    return false;
  }
  if (/^<svg[\s>]/i.test(normalized)) {
    return true;
  }
  if (/^<\?xml/i.test(normalized)) {
    return /<svg[\s>]/i.test(normalized);
  }
  return false;
}

async function detectIconMimeTypeFromStorageId(
  ctx: ActionCtx,
  storageId: Id<"_storage">,
): Promise<WorkspaceIconMimeType | null> {
  const stored = await ctx.storage.get(storageId);
  if (!stored) {
    return null;
  }

  const bytes = new Uint8Array(await stored.arrayBuffer());
  if (isPngSignature(bytes)) {
    return "image/png";
  }

  const text = new TextDecoder().decode(bytes);
  if (looksLikeSvg(text)) {
    return "image/svg+xml";
  }

  return null;
}

async function detectIconMimeTypeFromBlobId(
  ctx: ActionCtx,
  blobId: Id<"blobs">,
): Promise<WorkspaceIconMimeType | null> {
  const blob = await ctx.runQuery(internal.content.getBlob, { blobId });
  if (!blob) {
    return null;
  }

  if (blob.content !== undefined) {
    return looksLikeSvg(blob.content) ? "image/svg+xml" : null;
  }

  if (!blob.storageId) {
    return null;
  }

  return await detectIconMimeTypeFromStorageId(ctx, blob.storageId);
}

async function cleanupStorageObject(ctx: ActionCtx, storageId: Id<"_storage">): Promise<void> {
  try {
    await ctx.storage.delete(storageId);
  } catch (error) {
    console.warn(`Failed to cleanup uploaded storage object ${storageId}`, error);
  }
}

async function resolveBlobDownloadUrl(
  ctx: WorkspaceReadCtx,
  blobId: Id<"blobs"> | undefined,
): Promise<string | undefined> {
  if (!blobId) {
    return undefined;
  }

  const blob = await ctx.runQuery(internal.content.getBlob, { blobId });
  if (!blob?.storageId) {
    return undefined;
  }

  const downloadUrl = await ctx.storage.getUrl(blob.storageId);
  return downloadUrl ?? undefined;
}

async function resolveWorkspaceCommitForIcon(
  ctx: WorkspaceReadCtx,
  workspace: WorkspaceDoc,
): Promise<Doc<"commits"> | null> {
  const defaultBranch = await ctx.runQuery(internal.vcs.getDefaultBranchInternal, {
    workspaceId: workspace._id,
  });
  if (defaultBranch) {
    const commit = await ctx.runQuery(internal.vcs.getCommitInternal, {
      commitId: defaultBranch.commitId,
    });
    if (commit) {
      return commit;
    }
  }

  if (workspace.activeCommitId) {
    return await ctx.runQuery(internal.vcs.getCommitInternal, {
      commitId: workspace.activeCommitId,
    });
  }

  return null;
}

async function resolveWorkspaceIconFromTree(
  ctx: WorkspaceReadCtx,
  treeId: Id<"trees">,
): Promise<{ iconUrl: string; iconSource: "filesystem"; iconPath: string } | null> {
  for (const iconPath of ROOT_WORKSPACE_ICON_PATHS) {
    const file = await ctx.runQuery(api.trees.getFileFromTree, { treeId, path: iconPath });
    if (!file) {
      continue;
    }

    if (iconPath.endsWith(".svg")) {
      const svgContent = await loadFileContent(ctx, { content: file.content, blobId: file.blobId }, { binary: false });
      if (svgContent !== undefined) {
        return {
          iconUrl: `data:image/svg+xml;base64,${encodeUtf8ToBase64(svgContent)}`,
          iconSource: "filesystem",
          iconPath,
        };
      }
    } else if (iconPath.endsWith(".png")) {
      const pngBase64 = await loadFileContent(ctx, { content: file.content, blobId: file.blobId }, { binary: true });
      if (pngBase64 !== undefined) {
        return {
          iconUrl: `data:image/png;base64,${pngBase64}`,
          iconSource: "filesystem",
          iconPath,
        };
      }
    }

    if (file.downloadUrl) {
      return {
        iconUrl: file.downloadUrl,
        iconSource: "filesystem",
        iconPath,
      };
    }

    const blobDownloadUrl = await resolveBlobDownloadUrl(ctx, file.blobId);
    if (blobDownloadUrl) {
      return {
        iconUrl: blobDownloadUrl,
        iconSource: "filesystem",
        iconPath,
      };
    }
  }

  return null;
}

function encodeUtf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

async function resolveWorkspaceIcon(
  ctx: WorkspaceReadCtx,
  workspace: WorkspaceDoc,
): Promise<{ iconUrl?: string; iconSource?: "uploaded" | "filesystem"; iconPath?: string }> {
  const uploadedIconUrl = await resolveBlobDownloadUrl(ctx, workspace.iconBlobId);
  if (uploadedIconUrl) {
    return {
      iconUrl: uploadedIconUrl,
      iconSource: "uploaded",
    };
  }

  const iconCommit = await resolveWorkspaceCommitForIcon(ctx, workspace);
  if (!iconCommit) {
    return {};
  }

  const iconFromTree = await resolveWorkspaceIconFromTree(ctx, iconCommit.treeId);
  if (!iconFromTree) {
    return {};
  }

  return iconFromTree;
}

function normalizeProviderOptionsForMutation(
  providerOptions: unknown,
  args: { allowNull: boolean },
): Record<string, unknown> | undefined {
  if (providerOptions === undefined) {
    return undefined;
  }
  if (providerOptions === null) {
    if (args.allowNull) {
      return undefined;
    }
    throw new Error("providerOptions must be a JSON object");
  }
  if (!providerOptions || typeof providerOptions !== "object" || Array.isArray(providerOptions)) {
    throw new Error("providerOptions must be a JSON object");
  }
  return providerOptions as Record<string, unknown>;
}

async function resolveBranchForWorkspace(
  ctx: WorkspaceReadCtx,
  workspaceId: Id<"workspaces">,
  branchId?: Id<"branches">,
): Promise<{ _id: Id<"branches">; workspaceId: Id<"workspaces">; commitId: Id<"commits"> }> {
  if (branchId) {
    const branch = await ctx.runQuery(internal.vcs.getBranchInternal, { branchId });
    if (!branch || branch.workspaceId !== workspaceId) {
      throw new Error("Branch not found or does not belong to workspace");
    }
    return branch;
  }

  const defaultBranch = await ctx.runQuery(internal.vcs.getDefaultBranchInternal, { workspaceId });
  if (!defaultBranch) {
    throw new Error("Default branch not found");
  }
  return defaultBranch;
}

async function loadWorkspaceModelsFromFilesystem(
  ctx: WorkspaceReadCtx,
  args: {
    workspaceId: Id<"workspaces">;
    branchId?: Id<"branches">;
    userId?: string;
  },
): Promise<WorkspaceModelDefinition[]> {
  const branch = await resolveBranchForWorkspace(ctx, args.workspaceId, args.branchId);

  if (args.userId) {
    const workingFile = await ctx.runQuery(internal.fs.working.read, {
      branchId: branch._id,
      userId: args.userId,
      path: MODELS_FILE_PATH,
    });

    if (workingFile) {
      if (workingFile.isDeleted) {
        return getDefaultWorkspaceModels();
      }
      const content = await loadFileContent(
        ctx,
        { content: workingFile.content, blobId: workingFile.blobId },
        { binary: false },
      );
      if (content === undefined) {
        return getDefaultWorkspaceModels();
      }
      return parseWorkspaceModelsYaml(content, MODELS_FILE_PATH);
    }
  }

  const commit = await ctx.runQuery(internal.vcs.getCommitInternal, {
    commitId: branch.commitId,
  });
  if (!commit) {
    throw new Error("Commit not found");
  }

  const committedFile: { content?: string; blobId?: Id<"blobs"> } | null = await ctx.runQuery(
    api.trees.getFileFromTree,
    {
      treeId: commit.treeId,
      path: MODELS_FILE_PATH,
    },
  );
  const content = await loadFileContent(
    ctx,
    { content: committedFile?.content, blobId: committedFile?.blobId },
    { binary: false },
  );

  if (content === undefined) {
    return getDefaultWorkspaceModels();
  }
  return parseWorkspaceModelsYaml(content, MODELS_FILE_PATH);
}

async function writeWorkspaceModelsToWorkingFile(
  ctx: WorkspaceWriteCtx,
  args: {
    workspaceId: Id<"workspaces">;
    branchId?: Id<"branches">;
    userId: string;
    models: WorkspaceModelDefinition[];
  },
): Promise<WorkspaceModelDefinition[]> {
  const branch = await resolveBranchForWorkspace(ctx, args.workspaceId, args.branchId);
  const models = ensureValidWorkspaceModels(args.models, MODELS_FILE_PATH);
  const content = serializeWorkspaceModelsYaml(models);

  await ctx.runMutation(internal.fs.working.write, {
    workspaceId: args.workspaceId,
    branchId: branch._id,
    userId: args.userId,
    path: MODELS_FILE_PATH,
    content,
    blobId: undefined,
  });

  return models;
}

/**
 * Read workspace models from src/models.yaml (working file first, then committed file).
 */
export const getModels = query({
  args: {
    workspaceId: v.id("workspaces"),
    branchId: v.optional(v.id("branches")),
  },
  returns: v.array(vWorkspaceModelDefinition),
  handler: async (ctx, args) => {
    const { user } = await requireWorkspaceMember(ctx, args.workspaceId);
    const workspace = await ctx.runQuery(internal.workspace.getInternal, {
      workspaceId: args.workspaceId,
    });
    if (!workspace) {
      throw new Error("Workspace not found");
    }

    return await loadWorkspaceModelsFromFilesystem(ctx, {
      workspaceId: args.workspaceId,
      branchId: args.branchId,
      userId: user.subject,
    });
  },
});

/**
 * Read models cached on a revision (used by model picker + chat runtime).
 */
export const getModelsForRevision = query({
  args: {
    revisionId: v.id("revisions"),
  },
  returns: v.array(vWorkspaceModelDefinition),
  handler: async (ctx, args) => {
    await requireAuthenticatedUser(ctx);
    const revision = await ctx.db.get(args.revisionId);
    if (!revision) {
      throw new Error("Revision not found");
    }
    await requireWorkspaceMember(ctx, revision.workspaceId);
    return revision.models ?? getDefaultWorkspaceModels();
  },
});

/**
 * Read the default model from a revision's cached model config.
 */
export const getDefaultModel = query({
  args: {
    revisionId: v.id("revisions"),
  },
  returns: v.union(vWorkspaceModelDefinition, v.null()),
  handler: async (ctx, args) => {
    await requireAuthenticatedUser(ctx);
    const revision = await ctx.db.get(args.revisionId);
    if (!revision) {
      throw new Error("Revision not found");
    }
    await requireWorkspaceMember(ctx, revision.workspaceId);
    const models = revision.models ?? getDefaultWorkspaceModels();
    return resolveDefaultModel(models);
  },
});

/**
 * Add a model and persist changes to src/models.yaml in working files.
 */
export const addModel = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    branchId: v.optional(v.id("branches")),
    modelId: v.string(),
    id: v.optional(v.string()),
    label: v.optional(v.string()),
    isDefault: v.optional(v.boolean()),
    systemPrompt: v.optional(v.string()),
    providerOptions: v.optional(v.any()),
  },
  returns: v.array(vWorkspaceModelDefinition),
  handler: async (ctx, args) => {
    const { user } = await requireWorkspaceAdmin(ctx, args.workspaceId);
    const userId = user.subject;
    const models = await loadWorkspaceModelsFromFilesystem(ctx, {
      workspaceId: args.workspaceId,
      branchId: args.branchId,
      userId,
    });
    const modelId = args.modelId.trim();
    if (!modelId) {
      throw new Error("modelId is required");
    }
    const configuredId = args.id?.trim() || modelId;
    if (!configuredId) {
      throw new Error("id is required");
    }
    if (models.some((model) => getWorkspaceModelId(model) === configuredId)) {
      throw new Error(`Model id "${configuredId}" is already configured`);
    }

    const next = models.map((model) => ({ ...model }));
    if (args.isDefault) {
      for (const model of next) {
        model.isDefault = false;
      }
    }
    next.push({
      id: configuredId,
      modelId,
      label: args.label?.trim() || undefined,
      isDefault: args.isDefault ?? false,
      systemPrompt: args.systemPrompt?.trim() || undefined,
      providerOptions: normalizeProviderOptionsForMutation(args.providerOptions, { allowNull: true }),
    });

    if (!next.some((model) => model.isDefault)) {
      const first = next[0];
      if (first) {
        first.isDefault = true;
      }
    }

    return await writeWorkspaceModelsToWorkingFile(ctx, {
      workspaceId: args.workspaceId,
      branchId: args.branchId,
      userId,
      models: next,
    });
  },
});

/**
 * Remove a model from src/models.yaml in working files.
 */
export const removeModel = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    branchId: v.optional(v.id("branches")),
    id: v.string(),
  },
  returns: v.array(vWorkspaceModelDefinition),
  handler: async (ctx, args) => {
    const { user } = await requireWorkspaceAdmin(ctx, args.workspaceId);
    const userId = user.subject;
    const models = await loadWorkspaceModelsFromFilesystem(ctx, {
      workspaceId: args.workspaceId,
      branchId: args.branchId,
      userId,
    });
    if (models.length <= 1) {
      throw new Error("At least one model must remain configured");
    }

    const modelId = args.id.trim();
    if (!modelId) {
      throw new Error("id is required");
    }

    const next = models.filter((model) => getWorkspaceModelId(model) !== modelId);
    if (next.length === models.length) {
      throw new Error(`Model "${modelId}" not found in workspace`);
    }

    if (!next.some((model) => model.isDefault)) {
      const first = next[0];
      if (first) {
        first.isDefault = true;
      }
    }

    return await writeWorkspaceModelsToWorkingFile(ctx, {
      workspaceId: args.workspaceId,
      branchId: args.branchId,
      userId,
      models: next,
    });
  },
});

/**
 * Update an existing model definition in src/models.yaml working files.
 */
export const updateModel = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    branchId: v.optional(v.id("branches")),
    id: v.string(),
    nextId: v.optional(v.string()),
    label: v.optional(v.string()),
    isDefault: v.optional(v.boolean()),
    systemPrompt: v.optional(v.string()),
    providerOptions: v.optional(v.any()),
  },
  returns: v.array(vWorkspaceModelDefinition),
  handler: async (ctx, args) => {
    const { user } = await requireWorkspaceAdmin(ctx, args.workspaceId);
    const userId = user.subject;
    const models = await loadWorkspaceModelsFromFilesystem(ctx, {
      workspaceId: args.workspaceId,
      branchId: args.branchId,
      userId,
    });
    const next = models.map((model) => ({ ...model }));
    const currentId = args.id.trim();
    if (!currentId) {
      throw new Error("id is required");
    }
    const modelIndex = next.findIndex((model) => getWorkspaceModelId(model) === currentId);

    if (modelIndex === -1) {
      throw new Error(`Model "${currentId}" not found in workspace`);
    }

    if (args.isDefault) {
      for (const model of next) {
        model.isDefault = false;
      }
    }

    const model = next[modelIndex];
    if (!model) {
      throw new Error("Model not found");
    }

    if (args.nextId !== undefined) {
      const nextId = args.nextId.trim() || model.modelId;
      if (!nextId) {
        throw new Error("id is required");
      }
      if (
        next.some(
          (candidate, candidateIndex) => candidateIndex !== modelIndex && getWorkspaceModelId(candidate) === nextId,
        )
      ) {
        throw new Error(`Model id "${nextId}" is already configured`);
      }
      model.id = nextId;
    }
    if (args.label !== undefined) {
      model.label = args.label.trim() || undefined;
    }
    if (args.isDefault !== undefined) {
      model.isDefault = args.isDefault;
    }
    if (args.systemPrompt !== undefined) {
      model.systemPrompt = args.systemPrompt.trim() || undefined;
    }
    if (args.providerOptions !== undefined) {
      model.providerOptions = normalizeProviderOptionsForMutation(args.providerOptions, { allowNull: true });
    }

    if (!next.some((candidate) => candidate.isDefault)) {
      model.isDefault = true;
    }

    return await writeWorkspaceModelsToWorkingFile(ctx, {
      workspaceId: args.workspaceId,
      branchId: args.branchId,
      userId,
      models: next,
    });
  },
});

/**
 * Set default model in src/models.yaml working files.
 */
export const setDefaultModel = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    branchId: v.optional(v.id("branches")),
    id: v.string(),
  },
  returns: v.array(vWorkspaceModelDefinition),
  handler: async (ctx, args) => {
    const { user } = await requireWorkspaceAdmin(ctx, args.workspaceId);
    const userId = user.subject;
    const models = await loadWorkspaceModelsFromFilesystem(ctx, {
      workspaceId: args.workspaceId,
      branchId: args.branchId,
      userId,
    });
    const next = models.map((model) => ({ ...model, isDefault: false }));
    const modelId = args.id.trim();
    if (!modelId) {
      throw new Error("id is required");
    }
    const target = next.find((model) => getWorkspaceModelId(model) === modelId);

    if (!target) {
      throw new Error(`Model "${modelId}" not found in workspace`);
    }

    target.isDefault = true;
    return await writeWorkspaceModelsToWorkingFile(ctx, {
      workspaceId: args.workspaceId,
      branchId: args.branchId,
      userId,
      models: next,
    });
  },
});

/**
 * Delete a workspace (and all its data)
 */
export const remove = mutation({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAdmin(ctx, args.workspaceId);
    const workspace = await ctx.db.get(args.workspaceId);
    if (!workspace) {
      throw new Error("Workspace not found");
    }

    // Delete all related data
    // Note: In production, you might want to do this in batches for large workspaces

    // Delete working files
    const workingFiles = await ctx.db
      .query("workingFiles")
      .filter((q) => q.eq(q.field("workspaceId"), args.workspaceId))
      .collect();
    for (const file of workingFiles) {
      await ctx.db.delete(file._id);
    }

    // Delete branches
    const branches = await ctx.db
      .query("branches")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    for (const branch of branches) {
      await ctx.db.delete(branch._id);
    }

    const branchStates = await ctx.db
      .query("branchStates")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    for (const branchState of branchStates) {
      await ctx.db.delete(branchState._id);
    }

    // Delete commits
    const commits = await ctx.db
      .query("commits")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    for (const commit of commits) {
      await ctx.db.delete(commit._id);
    }

    // Delete trees
    const trees = await ctx.db
      .query("trees")
      .filter((q) => q.eq(q.field("workspaceId"), args.workspaceId))
      .collect();
    for (const tree of trees) {
      await ctx.db.delete(tree._id);
    }

    // Delete blobs
    const blobs = await ctx.db
      .query("blobs")
      .filter((q) => q.eq(q.field("workspaceId"), args.workspaceId))
      .collect();
    for (const blob of blobs) {
      await ctx.db.delete(blob._id);
    }

    const revisions = await ctx.db
      .query("revisions")
      .filter((q) => q.eq(q.field("workspaceId"), args.workspaceId))
      .collect();
    for (const revision of revisions) {
      await ctx.db.delete(revision._id);
    }

    const memberships = await ctx.db
      .query("workspaceMemberships")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    for (const membership of memberships) {
      await ctx.db.delete(membership._id);
    }

    const invitations = await ctx.db
      .query("workspaceInvitations")
      .withIndex("by_workspace_status", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    for (const invitation of invitations) {
      await ctx.db.delete(invitation._id);
    }

    // Finally delete the workspace
    await ctx.db.delete(args.workspaceId);
  },
});
