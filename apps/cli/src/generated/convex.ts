import { anyApi } from "convex/server";
import type { GenericId } from "convex/values";

export const api = anyApi as any;

export type Id<TableName extends string> = GenericId<TableName>;
