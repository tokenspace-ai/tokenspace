import { defineInternalAgentApi } from "@tokenspace/convex-durable-agents";
import { v } from "convex/values";
import { components, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalQuery } from "../_generated/server";

const internalAgentApi = defineInternalAgentApi(components.durable_agents, internal.ai.agent.chatAgentHandler, {
  onStatusChange: internal.ai.chat.onStatusChange,
});

export const createThread = internalAgentApi.createThread;
export const sendMessage = internalAgentApi.sendMessage;
export const listMessages = internalAgentApi.listMessages;
export const getThread = internalAgentApi.getThread;
export const stopThread = internalAgentApi.stopThread;
export const resumeThread = internalAgentApi.resumeThread;
export const deleteThread = internalAgentApi.deleteThread;
export const addMessage = internalAgentApi.addMessage;

const vThreadContextBase = {
  threadId: v.string(),
  sessionId: v.id("sessions"),
  userId: v.string(),
  workspaceId: v.id("workspaces"),
  revisionId: v.id("revisions"),
  rootThreadId: v.string(),
  rootChatId: v.id("chats"),
};

const vChatThreadContext = v.object({
  kind: v.literal("chat"),
  ...vThreadContextBase,
  chatId: v.id("chats"),
  modelId: v.optional(v.string()),
});

const vSubAgentThreadContext = v.object({
  kind: v.literal("subagent"),
  ...vThreadContextBase,
  parentThreadId: v.string(),
  depth: v.number(),
  toolCallId: v.string(),
  waitForResult: v.optional(v.boolean()),
  status: v.union(
    v.literal("initializing"),
    v.literal("running"),
    v.literal("awaiting_tool_results"),
    v.literal("completed"),
    v.literal("failed"),
    v.literal("stopped"),
    v.literal("detached"),
  ),
  profile: v.optional(v.union(v.literal("default"), v.literal("web_search"))),
  modelIdOverride: v.optional(v.string()),
  systemPromptOverride: v.optional(v.string()),
  toolPolicy: v.optional(v.union(v.literal("inherit"), v.literal("web_search_only"))),
  rootModelId: v.optional(v.string()),
});

type RootContext = {
  rootThreadId: string;
  rootChatId: Id<"chats">;
  userId: string;
  workspaceId: Id<"workspaces">;
  revisionId: Id<"revisions">;
  rootModelId?: string;
};

function rootContextFromChat(chat: any): RootContext {
  return {
    rootThreadId: chat.threadId,
    rootChatId: chat._id,
    userId: chat.userId,
    workspaceId: chat.workspaceId,
    revisionId: chat.revisionId,
    rootModelId: chat.modelId,
  };
}

async function resolveRootContextFromSubAgentRecord(
  ctx: any,
  subAgent: any,
  visited: Set<string>,
): Promise<RootContext | null> {
  const rootChatId = subAgent.rootChatId as Id<"chats"> | undefined;
  if (rootChatId) {
    const rootChat = await ctx.db.get(rootChatId);
    if (rootChat) {
      return rootContextFromChat(rootChat);
    }
  }

  if (typeof subAgent.rootThreadId === "string") {
    const rootChat = await ctx.db
      .query("chats")
      .withIndex("by_thread_id", (q: any) => q.eq("threadId", subAgent.rootThreadId))
      .first();
    if (rootChat) {
      return rootContextFromChat(rootChat);
    }
  }

  if (typeof subAgent.parentThreadId === "string") {
    return await resolveRootContextByThreadId(ctx, subAgent.parentThreadId, visited);
  }

  return null;
}

async function resolveRootContextByThreadId(
  ctx: any,
  threadId: string,
  visited: Set<string>,
): Promise<RootContext | null> {
  if (visited.has(threadId)) {
    return null;
  }
  visited.add(threadId);

  const chat = await ctx.db
    .query("chats")
    .withIndex("by_thread_id", (q: any) => q.eq("threadId", threadId))
    .first();
  if (chat) {
    return rootContextFromChat(chat);
  }

  const parentSubAgent = await ctx.db
    .query("subAgents")
    .withIndex("by_child", (q: any) => q.eq("threadId", threadId))
    .first();
  if (!parentSubAgent) {
    return null;
  }

  return await resolveRootContextFromSubAgentRecord(ctx, parentSubAgent, visited);
}

export const getThreadContext = internalQuery({
  args: {
    threadId: v.string(),
  },
  returns: v.union(vChatThreadContext, vSubAgentThreadContext, v.null()),
  handler: async (ctx, args) => {
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_thread_id", (q) => q.eq("threadId", args.threadId))
      .first();
    if (chat) {
      return {
        kind: "chat" as const,
        threadId: chat.threadId,
        chatId: chat._id,
        sessionId: chat.sessionId,
        userId: chat.userId,
        workspaceId: chat.workspaceId,
        revisionId: chat.revisionId,
        rootThreadId: chat.threadId,
        rootChatId: chat._id,
        modelId: chat.modelId,
      };
    }

    const subAgent = await ctx.db
      .query("subAgents")
      .withIndex("by_child", (q) => q.eq("threadId", args.threadId))
      .first();
    if (!subAgent) {
      return null;
    }

    const rootContext = await resolveRootContextFromSubAgentRecord(ctx, subAgent, new Set([args.threadId]));
    if (!rootContext) {
      return null;
    }

    return {
      kind: "subagent" as const,
      threadId: subAgent.threadId,
      parentThreadId: subAgent.parentThreadId,
      depth: subAgent.depth,
      toolCallId: subAgent.toolCallId,
      waitForResult: subAgent.waitForResult,
      status: subAgent.status,
      profile: subAgent.profile,
      modelIdOverride: subAgent.modelIdOverride,
      systemPromptOverride: subAgent.systemPromptOverride,
      toolPolicy: subAgent.toolPolicy,
      sessionId: subAgent.sessionId,
      userId: (subAgent.userId as string | undefined) ?? rootContext.userId,
      workspaceId: (subAgent.workspaceId as Id<"workspaces"> | undefined) ?? rootContext.workspaceId,
      revisionId: (subAgent.revisionId as Id<"revisions"> | undefined) ?? rootContext.revisionId,
      rootThreadId: rootContext.rootThreadId,
      rootChatId: rootContext.rootChatId,
      rootModelId: rootContext.rootModelId,
    };
  },
});
