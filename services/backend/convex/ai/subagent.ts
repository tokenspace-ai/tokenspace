/**
 * Sub-agent management for recursive agent spawning
 *
 * This module handles creating sub-agent threads, tracking their execution,
 * and propagating results back to parent threads.
 */

import { defineInternalAgentApi } from "@tokenspace/convex-durable-agents";
import { v } from "convex/values";
import { components, internal } from "../_generated/api";
import { internalAction, internalMutation, internalQuery, query } from "../_generated/server";
import { requireSessionOwnership } from "../authz";

const MAX_DEPTH = 5;
const vSubAgentProfile = v.union(v.literal("default"), v.literal("web_search"));
const vWaiterMode = v.union(v.literal("single"), v.literal("all"));
const vSubAgentWaiter = v.object({
  waiterId: v.string(),
  parentThreadId: v.string(),
  toolCallId: v.string(),
  mode: vWaiterMode,
  threadTargets: v.array(
    v.object({
      threadId: v.string(),
      runSeq: v.number(),
    }),
  ),
  storeTranscript: v.optional(v.boolean()),
  createdAt: v.number(),
});
const vSubAgentStatus = v.union(
  v.literal("initializing"),
  v.literal("running"),
  v.literal("awaiting_tool_results"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("stopped"),
  v.literal("detached"),
);

type Waiter = {
  waiterId: string;
  parentThreadId: string;
  toolCallId: string;
  mode: "single" | "all";
  threadTargets: Array<{ threadId: string; runSeq: number }>;
  storeTranscript?: boolean;
  createdAt: number;
};

const subAgentInternalApi = defineInternalAgentApi(
  components.durable_agents,
  internal.ai.agent.subAgentDefaultHandler,
  {
    onStatusChange: internal.ai.subagent.onSubAgentStatusChange,
  },
);
const webSearchSubAgentInternalApi = defineInternalAgentApi(
  components.durable_agents,
  internal.ai.agent.subAgentWebSearchHandler,
  {
    onStatusChange: internal.ai.subagent.onSubAgentStatusChange,
  },
);

// Export durable-agents API calls for sub-agent threads.
export const createSubAgentThread = subAgentInternalApi.createThread;
export const createWebSearchSubAgentThread = webSearchSubAgentInternalApi.createThread;
export const sendSubAgentMessage = subAgentInternalApi.sendMessage;
export const listMessagesInternal = subAgentInternalApi.listMessages;

/**
 * Create a sub-thread linked to parent's session
 */
export const createSubThread = internalMutation({
  args: {
    parentThreadId: v.string(),
    sessionId: v.id("sessions"),
    prompt: v.string(),
    contextMode: v.optional(v.union(v.literal("none"), v.literal("summary"), v.literal("full"))),
    toolCallId: v.string(),
    promptMessageId: v.optional(v.string()),
    waitForResult: v.optional(v.boolean()),
    profile: v.optional(vSubAgentProfile),
    storeTranscript: v.optional(v.boolean()),
  },
  returns: v.object({ threadId: v.string(), prompt: v.string() }),
  handler: async (ctx, args): Promise<{ threadId: string; prompt: string }> => {
    const parentContext = await ctx.runQuery(internal.ai.thread.getThreadContext, {
      threadId: args.parentThreadId,
    });
    if (!parentContext) throw new Error("Parent thread not found");

    // Get session
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error("Session not found");
    }
    if (parentContext.sessionId !== args.sessionId) {
      throw new Error("Parent thread does not belong to the provided session");
    }

    // Enforce max depth to prevent infinite recursion
    const parentDepth = parentContext.kind === "subagent" ? parentContext.depth : 0;
    if (parentDepth >= MAX_DEPTH) {
      throw new Error(`Maximum sub-agent depth (${MAX_DEPTH}) exceeded`);
    }

    // Build context based on contextMode
    let contextPrefix = "";
    const contextMode = args.contextMode ?? "none";

    if (contextMode === "summary" || contextMode === "full") {
      // Get messages from parent thread via internal durable-agents API (no auth required)
      const parentMessages = await ctx.runQuery(internal.ai.subagent.listMessagesInternal, {
        threadId: args.parentThreadId,
      });

      if (parentMessages && parentMessages.length > 0) {
        if (contextMode === "summary") {
          contextPrefix = `[Context from parent thread]\n${summarizeMessages(parentMessages)}\n\n`;
        } else {
          contextPrefix = `[Full context from parent thread]\n${formatFullContext(parentMessages)}\n\n`;
        }
      }
    }

    const profile = args.profile ?? "default";
    const threadId: string =
      profile === "web_search"
        ? await ctx.runMutation(internal.ai.subagent.createWebSearchSubAgentThread, {})
        : await ctx.runMutation(internal.ai.subagent.createSubAgentThread, {});

    const now = Date.now();

    const waitForResult = args.waitForResult !== false;
    const runSeq = 1;
    const waiterId = `${args.parentThreadId}:${args.toolCallId}`;
    const waiters: Waiter[] = waitForResult
      ? [
          {
            waiterId,
            parentThreadId: args.parentThreadId,
            toolCallId: args.toolCallId,
            mode: "single",
            threadTargets: [{ threadId, runSeq }],
            storeTranscript: args.storeTranscript,
            createdAt: now,
          },
        ]
      : [];

    // Track sub-agent linkage and runtime profile state. Sub-agent threads are no longer stored in chats.
    await ctx.db.insert("subAgents", {
      parentThreadId: args.parentThreadId,
      threadId: threadId,
      depth: parentDepth + 1,
      toolCallId: args.toolCallId,
      promptMessageId: args.promptMessageId,
      sessionId: args.sessionId,
      rootChatId: parentContext.rootChatId,
      rootThreadId: parentContext.rootThreadId,
      userId: parentContext.userId,
      workspaceId: parentContext.workspaceId,
      revisionId: parentContext.revisionId,
      profile,
      toolPolicy: profile === "web_search" ? "web_search_only" : "inherit",
      waitForResult,
      runSeq,
      lastNotifiedRunSeq: 0,
      waiters,
      storeTranscript: args.storeTranscript,
      status: waitForResult ? "initializing" : "detached",
      createdAt: now,
      updatedAt: now,
    });

    return { threadId, prompt: contextPrefix + args.prompt };
  },
});

export const getSubAgentsByThreadIds = internalQuery({
  args: {
    threadIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const byId = new Map<string, any>();
    for (const threadId of args.threadIds) {
      if (byId.has(threadId)) continue;
      const subAgent = await ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) => q.eq("threadId", threadId))
        .first();
      if (subAgent) {
        byId.set(threadId, subAgent);
      }
    }
    return args.threadIds.map((threadId) => byId.get(threadId) ?? null);
  },
});

export const registerWaiters = internalMutation({
  args: {
    threadIds: v.array(v.string()),
    waiter: vSubAgentWaiter,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const uniqueThreadIds = [...new Set(args.threadIds)];
    for (const threadId of uniqueThreadIds) {
      const subAgent = await ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) => q.eq("threadId", threadId))
        .first();
      if (!subAgent) {
        throw new Error(`Sub-agent not found: ${threadId}`);
      }

      const waiters = (subAgent.waiters ?? []) as Waiter[];
      const deduped = waiters.filter((w) => w.waiterId !== args.waiter.waiterId);
      deduped.push({
        waiterId: args.waiter.waiterId,
        parentThreadId: args.waiter.parentThreadId,
        toolCallId: args.waiter.toolCallId,
        mode: args.waiter.mode,
        threadTargets: args.waiter.threadTargets.map((t) => ({ threadId: t.threadId, runSeq: t.runSeq })),
        storeTranscript: args.waiter.storeTranscript,
        createdAt: args.waiter.createdAt,
      });

      await ctx.db.patch(subAgent._id, {
        waiters: deduped,
        ...(args.waiter.storeTranscript ? { storeTranscript: true } : {}),
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});

export const continueSubThread = internalMutation({
  args: {
    threadId: v.string(),
    parentThreadId: v.string(),
    waitForResult: v.optional(v.boolean()),
    toolCallId: v.string(),
    storeTranscript: v.optional(v.boolean()),
  },
  returns: v.object({ runSeq: v.number() }),
  handler: async (ctx, args) => {
    const subThread = await ctx.db
      .query("subAgents")
      .withIndex("by_child", (q) => q.eq("threadId", args.threadId))
      .first();
    if (!subThread) {
      throw new Error("Sub-agent not found");
    }
    if (subThread.parentThreadId !== args.parentThreadId) {
      throw new Error("Sub-agent parent thread mismatch");
    }
    if (!isTerminalSubAgentStatus(subThread.status)) {
      throw new Error("Sub-agent can only be continued after it reaches a terminal status");
    }

    const now = Date.now();
    const nextRunSeq = (subThread.runSeq ?? 1) + 1;
    const waitForResult = args.waitForResult !== false;
    const waiterId = `${args.parentThreadId}:${args.toolCallId}`;
    const existingWaiters = ((subThread.waiters ?? []) as Waiter[]).filter((w) => w.waiterId !== waiterId);
    const waiters = waitForResult
      ? [
          ...existingWaiters,
          {
            waiterId,
            parentThreadId: args.parentThreadId,
            toolCallId: args.toolCallId,
            mode: "single" as const,
            threadTargets: [{ threadId: args.threadId, runSeq: nextRunSeq }],
            storeTranscript: args.storeTranscript,
            createdAt: now,
          },
        ]
      : existingWaiters;

    await ctx.db.patch(subThread._id, {
      waitForResult,
      toolCallId: args.toolCallId,
      runSeq: nextRunSeq,
      status: "initializing",
      startedAt: undefined,
      completedAt: undefined,
      result: undefined,
      error: undefined,
      waiters,
      ...(args.storeTranscript ? { storeTranscript: true } : {}),
      updatedAt: now,
    });

    return { runSeq: nextRunSeq };
  },
});

export const processTerminalSubAgent = internalAction({
  args: {
    threadId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const subAgent = await ctx.runQuery(internal.ai.subagent.getPendingSubAgent, {
      threadId: args.threadId,
    });
    if (!subAgent) {
      return null;
    }

    if (!isTerminalSubAgentStatus(subAgent.status)) {
      return null;
    }

    const runSeq = subAgent.runSeq ?? 1;
    const waitersForRun = ((subAgent.waiters ?? []) as Waiter[]).filter((waiter) =>
      waiter.threadTargets.some((target) => target.threadId === args.threadId && target.runSeq === runSeq),
    );
    const shouldStoreTranscript =
      subAgent.storeTranscript === true || waitersForRun.some((waiter) => waiter.storeTranscript);

    let transcriptPath: string | undefined = subAgent.transcriptPath;
    if (shouldStoreTranscript) {
      transcriptPath = await writeTranscriptMarkdown(ctx, {
        threadId: args.threadId,
        revisionId: subAgent.revisionId,
        sessionId: subAgent.sessionId,
        runSeq,
      });
      await ctx.runMutation(internal.ai.subagent.setTranscriptPath, {
        threadId: args.threadId,
        transcriptPath,
      });
    }

    await ctx.runMutation(internal.ai.subagent.resolveTerminalSubAgentWaiters, {
      threadId: args.threadId,
      runSeq,
      transcriptPath,
    });
    return null;
  },
});

export const setTranscriptPath = internalMutation({
  args: {
    threadId: v.string(),
    transcriptPath: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const subAgent = await ctx.db
      .query("subAgents")
      .withIndex("by_child", (q) => q.eq("threadId", args.threadId))
      .first();
    if (!subAgent) return null;
    await ctx.db.patch(subAgent._id, {
      transcriptPath: args.transcriptPath,
      transcriptUpdatedAt: Date.now(),
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const resolveTerminalSubAgentWaiters = internalMutation({
  args: {
    threadId: v.string(),
    runSeq: v.number(),
    transcriptPath: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const subAgent = await ctx.db
      .query("subAgents")
      .withIndex("by_child", (q) => q.eq("threadId", args.threadId))
      .first();
    if (!subAgent) return null;

    const currentRunSeq = subAgent.runSeq ?? 1;
    if (currentRunSeq !== args.runSeq || !isTerminalSubAgentStatus(subAgent.status)) {
      return null;
    }

    const waiters = ((subAgent.waiters ?? []) as Waiter[]).filter((waiter) =>
      waiter.threadTargets.some((target) => target.threadId === args.threadId && target.runSeq === args.runSeq),
    );
    if (waiters.length === 0) {
      const lastNotifiedRunSeq = subAgent.lastNotifiedRunSeq ?? 0;
      if (lastNotifiedRunSeq >= args.runSeq) {
        return null;
      }
      await ctx.db.patch(subAgent._id, {
        lastNotifiedRunSeq: args.runSeq,
        updatedAt: Date.now(),
      });
      return null;
    }

    const fulfilledWaiterIds = new Set<string>();
    for (const waiter of waiters) {
      if (fulfilledWaiterIds.has(waiter.waiterId)) continue;

      const toolCall = await ctx.runQuery(components.durable_agents.tool_calls.getByToolCallId, {
        threadId: waiter.parentThreadId,
        toolCallId: waiter.toolCallId,
      });
      if (!toolCall || toolCall.result !== undefined || toolCall.error !== undefined) {
        fulfilledWaiterIds.add(waiter.waiterId);
        continue;
      }

      if (waiter.mode === "single") {
        if (subAgent.status === "completed") {
          await ctx.runMutation(internal.ai.chat.addToolResult, {
            threadId: waiter.parentThreadId,
            toolCallId: waiter.toolCallId,
            result: {
              threadId: args.threadId,
              status: "completed",
              result: subAgent.result,
              ...(waiter.storeTranscript ? { transcriptPath: args.transcriptPath ?? subAgent.transcriptPath } : {}),
            },
          });
        } else {
          await ctx.runMutation(internal.ai.chat.addToolError, {
            threadId: waiter.parentThreadId,
            toolCallId: waiter.toolCallId,
            error:
              subAgent.status === "stopped"
                ? "Sub-agent stopped before completion."
                : (subAgent.error ?? "Sub-agent failed before completion."),
          });
        }
        fulfilledWaiterIds.add(waiter.waiterId);
        continue;
      }

      const targetMap = new Map(waiter.threadTargets.map((target) => [target.threadId, target.runSeq] as const));
      const targetRows: any[] = [];
      let allComplete = true;
      for (const target of waiter.threadTargets) {
        const row = await ctx.db
          .query("subAgents")
          .withIndex("by_child", (q) => q.eq("threadId", target.threadId))
          .first();
        if (!row) {
          allComplete = false;
          break;
        }
        targetRows.push(row);
        if (!isTargetRunComplete(row, target.runSeq)) {
          allComplete = false;
        }
      }
      if (!allComplete) {
        continue;
      }
      if (waiter.storeTranscript && targetRows.some((row) => typeof row.transcriptPath !== "string")) {
        continue;
      }

      const anyFailed = targetRows.some(
        (row) => row.runSeq === targetMap.get(row.threadId) && (row.status === "failed" || row.status === "stopped"),
      );
      if (anyFailed) {
        await ctx.runMutation(internal.ai.chat.addToolError, {
          threadId: waiter.parentThreadId,
          toolCallId: waiter.toolCallId,
          error: "One or more sub-agents failed before completion.",
        });
      } else {
        await ctx.runMutation(internal.ai.chat.addToolResult, {
          threadId: waiter.parentThreadId,
          toolCallId: waiter.toolCallId,
          result: {
            status: "completed",
            threads: targetRows.map((row) => ({
              threadId: row.threadId,
              status: row.status,
              result: row.result,
              ...(waiter.storeTranscript ? { transcriptPath: row.transcriptPath } : {}),
            })),
          },
        });
      }

      fulfilledWaiterIds.add(waiter.waiterId);
    }

    if (fulfilledWaiterIds.size > 0) {
      const waiterIds = [...fulfilledWaiterIds];
      const targetThreadIds = new Set<string>();
      for (const waiter of waiters) {
        if (!fulfilledWaiterIds.has(waiter.waiterId)) continue;
        for (const target of waiter.threadTargets) {
          targetThreadIds.add(target.threadId);
        }
      }

      for (const threadId of targetThreadIds) {
        const row = await ctx.db
          .query("subAgents")
          .withIndex("by_child", (q) => q.eq("threadId", threadId))
          .first();
        if (!row) continue;
        const remaining = ((row.waiters ?? []) as Waiter[]).filter((waiter) => !waiterIds.includes(waiter.waiterId));
        await ctx.db.patch(row._id, {
          waiters: remaining,
          updatedAt: Date.now(),
        });
      }
    }

    const refreshed = await ctx.db
      .query("subAgents")
      .withIndex("by_child", (q) => q.eq("threadId", args.threadId))
      .first();
    if (refreshed) {
      await ctx.db.patch(refreshed._id, {
        lastNotifiedRunSeq: args.runSeq,
        updatedAt: Date.now(),
      });
    }

    return null;
  },
});

/**
 * Handle sub-agent status changes from durable-agents.
 */
export const onSubAgentStatusChange = internalMutation({
  args: {
    threadId: v.string(),
    status: v.string(),
    previousStatus: v.string(),
  },
  handler: async (ctx, args) => {
    const pending = await ctx.db
      .query("subAgents")
      .withIndex("by_child", (q) => q.eq("threadId", args.threadId))
      .first();
    if (!pending) {
      return;
    }

    const nextStatus = mapThreadStatusToSubAgentStatus(args.status);
    if (!nextStatus) {
      return;
    }

    const now = Date.now();
    const terminal = isTerminalSubAgentStatus(nextStatus);
    const runSeq = pending.runSeq ?? 1;
    const patch: Record<string, unknown> = {
      status: nextStatus,
      updatedAt: now,
    };
    if (!pending.startedAt && (nextStatus === "running" || nextStatus === "awaiting_tool_results")) {
      patch.startedAt = now;
    }

    if (terminal) {
      patch.completedAt = now;
      if (nextStatus === "completed") {
        const resultText = await getLatestAssistantText(ctx, args.threadId);
        patch.result = resultText;
        patch.error = undefined;
      }
      if (nextStatus === "failed") {
        patch.error = "Sub-agent failed";
      }
      if (nextStatus === "stopped") {
        patch.error = "Sub-agent stopped";
      }
    }

    await ctx.db.patch(pending._id, patch);

    if (!terminal) {
      return;
    }

    const lastNotifiedRunSeq = pending.lastNotifiedRunSeq ?? 0;
    if (lastNotifiedRunSeq >= runSeq) {
      return;
    }
    await ctx.scheduler.runAfter(0, internal.ai.subagent.processTerminalSubAgent, {
      threadId: args.threadId,
    });
  },
});

/**
 * Get pending sub-agent by child thread ID
 */
export const getPendingSubAgent = internalQuery({
  args: {
    threadId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("subAgents")
      .withIndex("by_child", (q) => q.eq("threadId", args.threadId))
      .first();
  },
});

/**
 * List all pending sub-agents for a parent thread
 */
export const listPendingSubAgents = internalQuery({
  args: {
    parentThreadId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("subAgents")
      .withIndex("by_parent", (q) => q.eq("parentThreadId", args.parentThreadId))
      .collect();
  },
});

/**
 * List sub-agents for a session (public API for UI)
 * Returns all sub-agents in the session, optionally filtered by status
 */
export const listSubAgentsForSession = query({
  args: {
    sessionId: v.id("sessions"),
    statusFilter: v.optional(v.array(vSubAgentStatus)),
  },
  handler: async (ctx, args) => {
    await requireSessionOwnership(ctx, args.sessionId);

    // Get all sub-agents for this session
    const subAgents = await ctx.db
      .query("subAgents")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();

    // Filter by status if provided
    const filtered = args.statusFilter ? subAgents.filter((sa) => args.statusFilter!.includes(sa.status)) : subAgents;
    return filtered.map((sa) => toSubAgentUiSummary(sa));
  },
});

export const getSubAgentStatus = query({
  args: {
    sessionId: v.id("sessions"),
    toolCallId: v.optional(v.string()),
    threadId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireSessionOwnership(ctx, args.sessionId);

    if (!args.toolCallId && !args.threadId) {
      return null;
    }

    let subAgent: any = null;

    if (args.threadId) {
      const byThread = await ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) => q.eq("threadId", args.threadId!))
        .first();
      if (byThread && byThread.sessionId === args.sessionId) {
        subAgent = byThread;
      }
    }

    if (!subAgent && args.toolCallId) {
      subAgent = await ctx.db
        .query("subAgents")
        .withIndex("by_session_tool_call", (q) => q.eq("sessionId", args.sessionId).eq("toolCallId", args.toolCallId!))
        .first();
    }

    if (!subAgent) {
      return null;
    }

    return toSubAgentUiSummary(subAgent);
  },
});

/**
 * Clean up subAgent record when a sub-thread is deleted
 */
export const cleanupPendingSubAgent = internalMutation({
  args: {
    threadId: v.string(),
  },
  handler: async (ctx, args) => {
    const pending = await ctx.db
      .query("subAgents")
      .withIndex("by_child", (q) => q.eq("threadId", args.threadId))
      .first();
    if (!pending) return;

    const waiters = (pending.waiters ?? []) as Waiter[];
    const fulfilledWaiterIds = new Set<string>();
    for (const waiter of waiters) {
      const toolCall = await ctx.runQuery(components.durable_agents.tool_calls.getByToolCallId, {
        threadId: waiter.parentThreadId,
        toolCallId: waiter.toolCallId,
      });
      if (!toolCall || toolCall.result !== undefined || toolCall.error !== undefined) {
        fulfilledWaiterIds.add(waiter.waiterId);
        continue;
      }

      await ctx.runMutation(internal.ai.chat.addToolError, {
        threadId: waiter.parentThreadId,
        toolCallId: waiter.toolCallId,
        error: "Sub-agent thread was deleted before completion.",
      });
      fulfilledWaiterIds.add(waiter.waiterId);
    }

    if (fulfilledWaiterIds.size > 0) {
      const threadIds = new Set<string>();
      for (const waiter of waiters) {
        if (!fulfilledWaiterIds.has(waiter.waiterId)) continue;
        for (const target of waiter.threadTargets) {
          threadIds.add(target.threadId);
        }
      }
      for (const threadId of threadIds) {
        const row = await ctx.db
          .query("subAgents")
          .withIndex("by_child", (q) => q.eq("threadId", threadId))
          .first();
        if (!row) continue;
        const remaining = ((row.waiters ?? []) as Waiter[]).filter((w) => !fulfilledWaiterIds.has(w.waiterId));
        await ctx.db.patch(row._id, { waiters: remaining, updatedAt: Date.now() });
      }
    }

    await ctx.db.delete(pending._id);
  },
});

function mapThreadStatusToSubAgentStatus(
  status: string,
): "running" | "awaiting_tool_results" | "completed" | "failed" | "stopped" | null {
  switch (status) {
    case "streaming":
      return "running";
    case "awaiting_tool_results":
      return "awaiting_tool_results";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    default:
      return null;
  }
}

function toSubAgentUiSummary(sa: any) {
  return {
    _id: sa._id,
    parentThreadId: sa.parentThreadId,
    threadId: sa.threadId,
    toolCallId: sa.toolCallId,
    depth: sa.depth,
    runSeq: sa.runSeq,
    status: sa.status,
    profile: sa.profile,
    toolPolicy: sa.toolPolicy,
    waitForResult: sa.waitForResult,
    storeTranscript: sa.storeTranscript,
    transcriptPath: sa.transcriptPath,
    waiterCount: Array.isArray(sa.waiters) ? sa.waiters.length : 0,
    result: sa.result,
    error: sa.error,
    createdAt: sa.createdAt,
    startedAt: sa.startedAt,
    completedAt: sa.completedAt,
    updatedAt: sa.updatedAt,
  };
}

function isTerminalSubAgentStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

async function getLatestAssistantText(ctx: any, threadId: string): Promise<string> {
  const messages = await ctx.runQuery(internal.ai.subagent.listMessagesInternal, { threadId });
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.parts)) {
      continue;
    }
    const text = msg.parts
      .filter((part: any) => part?.type === "text")
      .map((part: any) => String(part.text ?? ""))
      .join("\n")
      .trim();
    if (text.length > 0) {
      return text;
    }
  }
  return "";
}

function isTargetRunComplete(row: any, targetRunSeq: number): boolean {
  const rowRunSeq = row.runSeq ?? 1;
  if (rowRunSeq > targetRunSeq) return true;
  return rowRunSeq === targetRunSeq && isTerminalSubAgentStatus(row.status);
}

async function writeTranscriptMarkdown(
  ctx: any,
  args: {
    threadId: string;
    revisionId?: any;
    sessionId?: any;
    runSeq: number;
  },
): Promise<string> {
  const messages = await ctx.runQuery(internal.ai.subagent.listMessagesInternal, {
    threadId: args.threadId,
  });
  const threadContext = await ctx.runQuery(internal.ai.thread.getThreadContext, {
    threadId: args.threadId,
  });
  if (!threadContext) {
    throw new Error(`Thread context not found for sub-agent transcript: ${args.threadId}`);
  }
  const revisionId = args.revisionId ?? threadContext.revisionId;
  const sessionId = args.sessionId ?? threadContext.sessionId;
  if (!revisionId || !sessionId) {
    throw new Error(`Missing revision/session for sub-agent transcript: ${args.threadId}`);
  }

  const runPath = `memory/subagents/${args.threadId}/runs/run-${args.runSeq}.md`;
  const latestPath = `memory/subagents/${args.threadId}/transcript.md`;
  const lines: string[] = [];
  lines.push("# Sub-Agent Transcript");
  lines.push("");
  lines.push(`- Thread: \`${args.threadId}\``);
  lines.push(`- Run: ${args.runSeq}`);
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push("");

  for (const message of messages ?? []) {
    const role = String(message?.role ?? "unknown");
    lines.push(`## ${role}`);
    lines.push("");
    const parts = Array.isArray(message?.parts) ? message.parts : [];
    if (parts.length === 0) {
      lines.push("_(no content)_");
      lines.push("");
      continue;
    }

    for (const part of parts) {
      if (part?.type === "text") {
        const text = String(part?.text ?? "").trim();
        lines.push(text.length > 0 ? text : "_(empty text)_");
      } else {
        lines.push("```json");
        lines.push(JSON.stringify(part, null, 2));
        lines.push("```");
      }
      lines.push("");
    }
  }

  const content = lines.join("\n");
  await ctx.runAction(internal.fs.operations.writeFile, {
    revisionId,
    sessionId,
    path: runPath,
    content,
    append: false,
  });
  await ctx.runAction(internal.fs.operations.writeFile, {
    revisionId,
    sessionId,
    path: latestPath,
    content,
    append: false,
  });

  return runPath;
}

/**
 * Helper to summarize messages for context passing
 */
function summarizeMessages(messages: any[]): string {
  return messages
    .slice(-10)
    .map((m) => {
      const role = m.role || "unknown";
      const content = Array.isArray(m.parts)
        ? m.parts
            .map((part: any) => (part?.type === "text" ? String(part.text ?? "") : `[${String(part?.type ?? "part")}]`))
            .join(" ")
        : "";
      return `${role}: ${truncate(content, 300)}`;
    })
    .join("\n");
}

/**
 * Format full context for passing to sub-agent
 */
function formatFullContext(messages: any[]): string {
  return messages
    .map((m) => {
      const role = m.role || "unknown";
      const content = Array.isArray(m.parts) ? m.parts.map((part: any) => JSON.stringify(part)).join("\n") : "";
      return `[${role}]\n${content}`;
    })
    .join("\n\n---\n\n");
}

/**
 * Truncate text to a maximum length
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}
