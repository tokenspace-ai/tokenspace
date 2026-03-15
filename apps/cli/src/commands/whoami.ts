import { api } from "@tokenspace/backend/convex/_generated/api";
import pc from "picocolors";
import { getStoredAuth, isTokenExpired } from "../auth";
import { getClient, getUserId } from "../client";

/**
 * Whoami command - shows current user info
 */
export async function whoami(): Promise<void> {
  const auth = getStoredAuth();

  if (!auth) {
    if (isTokenExpired()) {
      console.log(pc.yellow("Session expired. Run 'tokenspace login' to re-authenticate."));
    } else {
      console.log(pc.yellow("Not logged in. Run 'tokenspace login' to authenticate."));
    }
    return;
  }

  console.log(pc.green("✓ Authenticated"));
  console.log(pc.dim(`  Token expires: ${new Date(auth.expiresAt).toLocaleString()}`));

  const client = await getClient();
  const userId = getUserId();

  const workspaces = await client.query(api.workspace.list);
  if (workspaces.length === 0) {
    console.log(pc.green("✓ User ID "), pc.bold(userId));
    console.log(pc.dim("  No workspaces found — cannot fetch full profile."));
    return;
  }
  const firstWorkspace = workspaces[0];
  if (!firstWorkspace) {
    console.log(pc.green("✓ User ID "), pc.bold(userId));
    return;
  }

  const user = await client.action(api.users.userDetails, {
    workspaceId: firstWorkspace._id,
    userId,
  });

  if (!user) {
    console.log(pc.green("✓ User ID "), pc.bold(userId));
    return;
  }

  const name = [user.firstName, user.lastName].filter(Boolean).join(" ");
  console.log(pc.green("✓ User ID "), pc.bold(user.id));
  if (name) {
    console.log(pc.green("  Name    "), pc.bold(name));
  }
  console.log(pc.green("  Email   "), pc.bold(user.email));
}
