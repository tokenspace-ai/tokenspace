import type { User } from "@workos-inc/node";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import { workos } from "./auth";
import { requireWorkspaceMember } from "./authz";

function isWorkOSNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.name === "NotFoundException";
}

export const userDetails = action({
  args: {
    workspaceId: v.id("workspaces"),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const { user: caller } = await requireWorkspaceMember(ctx, args.workspaceId);
    if (caller.role !== "admin") {
      const targetMembership = await ctx.runQuery(internal.workspace.getMembershipByWorkspaceAndUserInternal, {
        workspaceId: args.workspaceId,
        userId: args.userId,
      });
      if (!targetMembership) {
        return null;
      }
    }
    let user: User;
    try {
      user = await workos.userManagement.getUser(args.userId);
    } catch (error) {
      if (isWorkOSNotFoundError(error)) {
        return null;
      }
      throw error;
    }
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      profilePictureUrl: user.profilePictureUrl,
    };
  },
});
