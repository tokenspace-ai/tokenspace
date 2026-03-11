/**
 * Session management for recursive agent support
 *
 * Sessions group threads that share the same filesystem overlay.
 * When a thread spawns a sub-agent, both threads belong to the same session
 * and can see each other's file modifications.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { requireSessionOwnership } from "./authz";

/**
 * Create a new session for a thread
 * Called during thread creation to establish the session
 */
export const createSession = internalMutation({
  args: {
    userId: v.string(),
    revisionId: v.id("revisions"),
  },
  handler: async (ctx, args): Promise<Id<"sessions">> => {
    const sessionId = await ctx.db.insert("sessions", {
      userId: args.userId,
      revisionId: args.revisionId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "active",
    });
    return sessionId;
  },
});

/**
 * Get a session by ID
 */
export const getSession = internalQuery({
  args: {
    sessionId: v.id("sessions"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.sessionId);
  },
});

/**
 * Get session info (public query for UI)
 */
export const getSessionInfo = query({
  args: {
    sessionId: v.id("sessions"),
  },
  handler: async (ctx, args) => {
    const session = await requireSessionOwnership(ctx, args.sessionId);
    return {
      _id: args.sessionId,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      revisionId: session.revisionId,
    };
  },
});

/**
 * Get session ID for a thread
 */
export const getSessionIdForThread = internalQuery({
  args: {
    threadId: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"sessions"> | null> => {
    const context = await ctx.runQuery(internal.ai.thread.getThreadContext, {
      threadId: args.threadId,
    });
    return context?.sessionId ?? null;
  },
});

/**
 * Update session status
 */
export const updateSessionStatus = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    status: v.union(v.literal("active"), v.literal("completed"), v.literal("failed")),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.sessionId, {
      status: args.status,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Delete a session and all its overlay files
 * Called when a chat is deleted
 */
export const deleteSession = internalMutation({
  args: {
    sessionId: v.id("sessions"),
  },
  handler: async (ctx, args) => {
    // Delete all overlay files for this session
    const overlayFiles = await ctx.db
      .query("sessionOverlayFiles")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();

    for (const file of overlayFiles) {
      await ctx.db.delete(file._id);
    }

    // Delete sub-agent tracking records for this session
    const subAgents = await ctx.db
      .query("subAgents")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();

    const subAgentThreadIds = subAgents.map((sa) => sa.threadId);
    for (const subAgent of subAgents) {
      await ctx.db.delete(subAgent._id);
    }

    for (const threadId of subAgentThreadIds) {
      try {
        await ctx.runMutation(internal.ai.thread.deleteThread, {
          threadId: threadId,
        });
      } catch (error) {
        console.warn(`Failed to delete sub-agent durable thread ${threadId}:`, error);
      }
    }

    // Delete the session itself
    await ctx.db.delete(args.sessionId);
  },
});
