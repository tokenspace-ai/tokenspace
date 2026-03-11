import type { UserIdentity } from "convex/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";

type AuthCtx = QueryCtx | MutationCtx | ActionCtx;
export type WorkspaceRole = "workspace_admin" | "member";

export async function requireAuthenticatedUser(ctx: AuthCtx): Promise<UserIdentity> {
  const user = await ctx.auth.getUserIdentity();
  if (!user) {
    throw new Error("Unauthorized");
  }
  const expectedOrgId = process.env.WORKOS_ORG_ID;
  if (!expectedOrgId) {
    throw new Error("Server misconfigured: WORKOS_ORG_ID is not set");
  }
  if (user.org_id !== expectedOrgId) {
    throw new Error(`Organization mismatch: expected ${expectedOrgId}, got ${user.org_id}`);
  }
  return user;
}

export async function requireSessionOwnership(ctx: AuthCtx, sessionId: Id<"sessions">): Promise<Doc<"sessions">> {
  const user = await requireAuthenticatedUser(ctx);
  const session =
    "db" in ctx ? await ctx.db.get(sessionId) : await ctx.runQuery(internal.sessions.getSession, { sessionId });
  if (!session) {
    throw new Error("Session not found");
  }
  if (session.userId !== user.subject) {
    throw new Error("Unauthorized");
  }
  return session;
}

async function getWorkspaceMembership(
  ctx: AuthCtx,
  args: { workspaceId: Id<"workspaces">; userId: string },
): Promise<Doc<"workspaceMemberships"> | null> {
  if ("db" in ctx) {
    return await ctx.db
      .query("workspaceMemberships")
      .withIndex("by_workspace_user", (q) => q.eq("workspaceId", args.workspaceId).eq("userId", args.userId))
      .first();
  }
  return await ctx.runQuery(internal.workspace.getMembershipByWorkspaceAndUserInternal, args);
}

export async function requireWorkspaceMember(
  ctx: AuthCtx,
  workspaceId: Id<"workspaces">,
): Promise<{ user: UserIdentity; membership: Doc<"workspaceMemberships"> }> {
  const user = await requireAuthenticatedUser(ctx);
  if (user.role === "admin") {
    return {
      user,
      membership: {
        _id: null as any,
        role: "workspace_admin",
        createdAt: 0,
        updatedAt: 0,
        workspaceId: workspaceId,
        userId: user.subject,
        _creationTime: 0,
      },
    };
  }
  const membership = await getWorkspaceMembership(ctx, {
    workspaceId,
    userId: user.subject,
  });
  if (!membership) {
    throw new Error("Unauthorized");
  }
  return { user, membership };
}

export async function requireWorkspaceAdmin(
  ctx: AuthCtx,
  workspaceId: Id<"workspaces">,
): Promise<{ user: UserIdentity; membership: Doc<"workspaceMemberships"> }> {
  const { user, membership } = await requireWorkspaceMember(ctx, workspaceId);
  if (user.role !== "admin" && membership.role !== "workspace_admin") {
    throw new Error("Unauthorized");
  }
  return { user, membership };
}

export async function getWorkspaceRole(ctx: AuthCtx, workspaceId: Id<"workspaces">): Promise<WorkspaceRole | null> {
  const user = await requireAuthenticatedUser(ctx);
  if (user.role === "admin") {
    return "workspace_admin";
  }
  const membership = await getWorkspaceMembership(ctx, {
    workspaceId,
    userId: user.subject,
  });
  return membership?.role ?? null;
}
