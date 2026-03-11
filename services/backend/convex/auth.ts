import { WorkOS } from "@workos-inc/node";
import { query } from "./_generated/server";

export const whoami = query({
  handler: async (ctx) => {
    const user = await ctx.auth.getUserIdentity();
    return {
      id: user?.subject,
      email: user?.email,
      name: user?.name,
    };
  },
});

export const workos = new WorkOS({
  clientId: process.env.WORKOS_CLIENT_ID,
  apiKey: process.env.WORKOS_API_KEY,
});
