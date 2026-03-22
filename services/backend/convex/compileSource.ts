import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

export const vCompileSource = v.union(
  v.object({
    kind: v.literal("branch"),
    includeWorkingState: v.optional(v.boolean()),
    workingStateHash: v.optional(v.string()),
    userId: v.optional(v.string()),
  }),
  v.object({
    kind: v.literal("branchState"),
    branchStateId: v.id("branchStates"),
  }),
);

export type CompileSource =
  | {
      kind: "branch";
      includeWorkingState?: boolean;
      workingStateHash?: string;
      userId?: string;
    }
  | {
      kind: "branchState";
      branchStateId: Id<"branchStates">;
    };
