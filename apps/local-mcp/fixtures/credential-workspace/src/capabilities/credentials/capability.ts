import { action, getCredential } from "@tokenspace/sdk";
import z from "zod";
import { sessionSecret, userSecret, workspaceEnv, workspaceOauth, workspaceSecret } from "../../credentials";

const emptyStrictSchema = z.strictObject({});

export const readSecret = action(emptyStrictSchema, async () => {
  return await getCredential(workspaceSecret);
});

export const readSessionSecret = action(emptyStrictSchema, async () => {
  return await getCredential(sessionSecret);
});

export const readUserSecret = action(emptyStrictSchema, async () => {
  return await getCredential(userSecret);
});

export const readEnv = action(emptyStrictSchema, async () => {
  return await getCredential(workspaceEnv);
});

export const readOauth = action(emptyStrictSchema, async () => {
  const token = await getCredential(workspaceOauth);
  return token.accessToken;
});
