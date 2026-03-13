import type { User } from "@workos-inc/node";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { action } from "./_generated/server";
import { workos } from "./auth";
import { requireWorkspaceMember } from "./authz";

function isWorkOSNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.name === "NotFoundException";
}

export type UserInfo = {
  id: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  profilePictureUrl?: string | null;
};

type UserResolverCtx = Pick<ActionCtx, "runQuery">;
type UserResolverDeps = {
  loadUserById?: (userId: string) => Promise<User | null>;
  listUsersByEmail?: (email: string) => Promise<User[]>;
};

export function normalizeUserLookupEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function serializeUserInfo(
  user: Pick<User, "id" | "email" | "firstName" | "lastName" | "profilePictureUrl">,
): UserInfo {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    profilePictureUrl: user.profilePictureUrl,
  };
}

async function getWorkspaceMembership(ctx: UserResolverCtx, workspaceId: Id<"workspaces">, userId: string) {
  return await ctx.runQuery(internal.workspace.getMembershipByWorkspaceAndUserInternal, {
    workspaceId,
    userId,
  });
}

async function canLookupAcrossWorkspaceBoundary(
  ctx: UserResolverCtx,
  workspaceId: Id<"workspaces">,
  callerUserId: string,
  isOrgAdmin: boolean,
): Promise<boolean> {
  if (isOrgAdmin) {
    return true;
  }
  const membership = await getWorkspaceMembership(ctx, workspaceId, callerUserId);
  return membership?.role === "workspace_admin";
}

export async function loadUserById(userId: string): Promise<User | null> {
  try {
    return await workos.userManagement.getUser(userId);
  } catch (error) {
    if (isWorkOSNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

export async function listUsersByEmail(email: string): Promise<User[]> {
  const users = await workos.userManagement.listUsers({
    email: normalizeUserLookupEmail(email),
    limit: 100,
  });
  return users.data;
}

export async function resolveCurrentUserInfo(
  userId: string,
  deps: Pick<UserResolverDeps, "loadUserById"> = {},
): Promise<UserInfo | null> {
  const user = await (deps.loadUserById ?? loadUserById)(userId);
  return user ? serializeUserInfo(user) : null;
}

export async function resolveVisibleUserById(
  ctx: UserResolverCtx,
  args: {
    workspaceId: Id<"workspaces">;
    callerUserId: string;
    targetUserId: string;
    isOrgAdmin?: boolean;
  },
  deps: UserResolverDeps = {},
): Promise<UserInfo | null> {
  const callerMembership = await getWorkspaceMembership(ctx, args.workspaceId, args.callerUserId);
  if (!args.isOrgAdmin && !callerMembership) {
    return null;
  }

  const canLookupOutsideWorkspace = await canLookupAcrossWorkspaceBoundary(
    ctx,
    args.workspaceId,
    args.callerUserId,
    args.isOrgAdmin ?? false,
  );
  if (!canLookupOutsideWorkspace) {
    const targetMembership = await getWorkspaceMembership(ctx, args.workspaceId, args.targetUserId);
    if (!targetMembership) {
      return null;
    }
  }
  const user = await (deps.loadUserById ?? loadUserById)(args.targetUserId);
  return user ? serializeUserInfo(user) : null;
}

export async function resolveVisibleUserByEmail(
  ctx: UserResolverCtx,
  args: {
    workspaceId: Id<"workspaces">;
    callerUserId: string;
    email: string;
    isOrgAdmin?: boolean;
  },
  deps: UserResolverDeps = {},
): Promise<UserInfo | null> {
  const normalizedEmail = normalizeUserLookupEmail(args.email);
  const candidates = await (deps.listUsersByEmail ?? listUsersByEmail)(normalizedEmail);
  for (const user of candidates) {
    if ((user.email ?? "").trim().toLowerCase() !== normalizedEmail) {
      continue;
    }
    const visible = await resolveVisibleUserById(
      ctx,
      {
        workspaceId: args.workspaceId,
        callerUserId: args.callerUserId,
        targetUserId: user.id,
        isOrgAdmin: args.isOrgAdmin,
      },
      deps,
    );
    if (visible) {
      return visible;
    }
  }
  return null;
}

export const userDetails = action({
  args: {
    workspaceId: v.id("workspaces"),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const { user: caller } = await requireWorkspaceMember(ctx, args.workspaceId);
    return await resolveVisibleUserById(ctx, {
      workspaceId: args.workspaceId,
      callerUserId: caller.subject,
      targetUserId: args.userId,
      isOrgAdmin: caller.role === "admin",
    });
  },
});
