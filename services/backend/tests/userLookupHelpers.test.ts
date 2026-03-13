import { describe, expect, it } from "bun:test";
import {
  normalizeUserLookupEmail,
  resolveVisibleUserByEmail,
  resolveVisibleUserById,
  serializeUserInfo,
} from "../convex/users";

type Membership = {
  workspaceId: string;
  userId: string;
  role: "member" | "workspace_admin";
};

function createCtx(memberships: Membership[]) {
  return {
    runQuery: async (_ref: unknown, args: { workspaceId: string; userId: string }) =>
      memberships.find(
        (membership) => membership.workspaceId === args.workspaceId && membership.userId === args.userId,
      ) ?? null,
  } as any;
}

const demoUser = {
  id: "user-1",
  email: "user@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  profilePictureUrl: "https://example.com/avatar.png",
};

describe("user lookup helpers", () => {
  it("normalizes lookup emails", () => {
    expect(normalizeUserLookupEmail("  USER@Example.com ")).toBe("user@example.com");
  });

  it("serializes the public user shape", () => {
    expect(serializeUserInfo(demoUser as any)).toEqual({
      id: "user-1",
      email: "user@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      profilePictureUrl: "https://example.com/avatar.png",
    });
  });

  it("restricts non-admin lookup to workspace members", async () => {
    const ctx = createCtx([
      { workspaceId: "ws-1", userId: "caller", role: "member" },
      { workspaceId: "ws-1", userId: "user-1", role: "member" },
    ]);

    const visible = await resolveVisibleUserById(
      ctx,
      {
        workspaceId: "ws-1" as any,
        callerUserId: "caller",
        targetUserId: "user-1",
      },
      {
        loadUserById: async () => demoUser as any,
      },
    );
    const hidden = await resolveVisibleUserById(
      ctx,
      {
        workspaceId: "ws-1" as any,
        callerUserId: "caller",
        targetUserId: "user-2",
      },
      {
        loadUserById: async () => ({ ...demoUser, id: "user-2" }) as any,
      },
    );

    expect(visible?.id).toBe("user-1");
    expect(hidden).toBeNull();
  });

  it("allows workspace admins to resolve users outside the workspace", async () => {
    const ctx = createCtx([{ workspaceId: "ws-1", userId: "caller", role: "workspace_admin" }]);

    const result = await resolveVisibleUserById(
      ctx,
      {
        workspaceId: "ws-1" as any,
        callerUserId: "caller",
        targetUserId: "user-2",
      },
      {
        loadUserById: async () => ({ ...demoUser, id: "user-2", email: "other@example.com" }) as any,
      },
    );

    expect(result?.id).toBe("user-2");
    expect(result?.email).toBe("other@example.com");
  });

  it("looks up by normalized email and still applies visibility rules", async () => {
    const ctx = createCtx([
      { workspaceId: "ws-1", userId: "caller", role: "member" },
      { workspaceId: "ws-1", userId: "user-1", role: "member" },
    ]);

    const visible = await resolveVisibleUserByEmail(
      ctx,
      {
        workspaceId: "ws-1" as any,
        callerUserId: "caller",
        email: " USER@example.com ",
      },
      {
        listUsersByEmail: async (email) => [{ ...demoUser, email }] as any,
        loadUserById: async () => demoUser as any,
      },
    );
    const hidden = await resolveVisibleUserByEmail(
      ctx,
      {
        workspaceId: "ws-1" as any,
        callerUserId: "caller",
        email: "hidden@example.com",
      },
      {
        listUsersByEmail: async (email) => [{ ...demoUser, id: "user-2", email }] as any,
        loadUserById: async () => ({ ...demoUser, id: "user-2", email: "hidden@example.com" }) as any,
      },
    );

    expect(visible?.email).toBe("user@example.com");
    expect(hidden).toBeNull();
  });
});
