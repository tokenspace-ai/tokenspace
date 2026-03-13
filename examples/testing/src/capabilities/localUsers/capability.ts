import { action, getCurrentUserInfo } from "@tokenspace/sdk";
import z from "zod";

export const readCurrentUser = action(z.object({}), async () => {
  return await getCurrentUserInfo();
});
