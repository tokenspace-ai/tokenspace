import { cronJobs } from "convex/server";
import { components, internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

const crons = cronJobs();

export const periodicChecks = internalAction({
  args: {},
  handler: async (ctx) => {
    await ctx.runAction(components.durable_agents.agent.tryContinueAllThreads, {});
    await ctx.runMutation(internal.executors.cleanupStaleExecutorInstancesInternal, {});
    return null;
  },
});

crons.interval("periodicChecks", { minutes: 1 }, internal.crons.periodicChecks);

export default crons;
