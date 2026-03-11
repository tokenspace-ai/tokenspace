import { action } from "@tokenspace/sdk";
import z from "zod";

export const testConnection = action(z.object({}), async (_args) => {
  await new Promise((resolve) => setTimeout(resolve, 10));
  return "it works!";
});
