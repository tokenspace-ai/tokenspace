import { v } from "convex/values";
import { normalizeApprovalPayload, normalizeApprovalRecord, normalizeApprovalRequestRecord } from "../approvalPayloads";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requireAuthenticatedUser, requireSessionOwnership } from "./authz";

// Validator for approval requirement fields
const approvalFieldsValidator = {
  action: v.string(),
  data: v.optional(v.any()),
  info: v.optional(v.any()),
  description: v.optional(v.string()),
};

/**
 * Create a pending approval request.
 * Called by the agent when it encounters an approval-required error.
 */
export const createApprovalRequest = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    threadId: v.optional(v.string()),
    toolCallId: v.string(),
    promptMessageId: v.optional(v.string()),
    ...approvalFieldsValidator,
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const data = normalizeApprovalPayload(args.data);
    const info = normalizeApprovalPayload(args.info);
    const requestId = await ctx.db.insert("approvalRequests", {
      sessionId: args.sessionId,
      threadId: args.threadId,
      toolCallId: args.toolCallId,
      promptMessageId: args.promptMessageId,
      action: args.action,
      data,
      info,
      description: args.description,
      reason: args.reason,
      status: "pending",
      createdAt: Date.now(),
    });

    return {
      requestId,
      status: "pending" as const,
      message: `Approval request created. Waiting for user to approve: ${args.action}`,
    };
  },
});

/**
 * Grant an approval request.
 * Called from the UI when the user clicks "Approve".
 */
export const grantApproval = mutation({
  args: {
    requestId: v.id("approvalRequests"),
    comment: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireAuthenticatedUser(ctx);

    const request = await ctx.db.get(args.requestId);
    if (!request) throw new Error("Approval request not found");
    if (request.status !== "pending") {
      throw new Error(`Approval request is already ${request.status}`);
    }

    const session = await ctx.db.get(request.sessionId);
    if (!session) throw new Error("Session not found");
    if (session.userId !== user.subject) throw new Error("Unauthorized");
    const shouldNotifyAgent = session?.chatId != null && !request.toolCallId.startsWith("playground:");

    // Update the request status
    await ctx.db.patch(args.requestId, {
      status: "approved",
      resolvedAt: Date.now(),
      resolvedBy: user.subject,
      resolverComment: args.comment,
    });

    // Create the actual approval record
    const approvalId = await ctx.db.insert("approvals", {
      sessionId: request.sessionId,
      action: request.action,
      data: normalizeApprovalPayload(request.data),
      grantedBy: user.subject,
      grantedAt: Date.now(),
    });

    // If this request came from a chat (durable agent), notify the tool call.
    // Playground sessions do not have a tool call to resume.
    if (shouldNotifyAgent) {
      if (!request.threadId) {
        throw new Error(`Missing threadId for approval request ${request._id}`);
      }
      await ctx.runMutation(internal.ai.chat.addToolResult, {
        threadId: request.threadId,
        toolCallId: request.toolCallId,
        result: { approved: true, comment: args.comment },
      });
    }

    return {
      approvalId,
      status: "approved" as const,
    };
  },
});

/**
 * Deny an approval request.
 * Called from the UI when the user clicks "Deny".
 */
export const denyApproval = mutation({
  args: {
    requestId: v.id("approvalRequests"),
    comment: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireAuthenticatedUser(ctx);

    const request = await ctx.db.get(args.requestId);
    if (!request) throw new Error("Approval request not found");
    if (request.status !== "pending") {
      throw new Error(`Approval request is already ${request.status}`);
    }

    const session = await ctx.db.get(request.sessionId);
    if (!session) throw new Error("Session not found");
    if (session.userId !== user.subject) throw new Error("Unauthorized");
    const shouldNotifyAgent = session?.chatId != null && !request.toolCallId.startsWith("playground:");

    // Update the request status
    await ctx.db.patch(args.requestId, {
      status: "denied",
      resolvedAt: Date.now(),
      resolvedBy: user.subject,
      resolverComment: args.comment,
    });

    // If this request came from a chat (durable agent), notify the tool call.
    // Playground sessions do not have a tool call to resume.
    if (shouldNotifyAgent) {
      if (!request.threadId) {
        throw new Error(`Missing threadId for approval request ${request._id}`);
      }
      const errorMsg = args.comment?.trim()
        ? `Approval request denied: ${args.comment}`
        : "Approval request denied by user";
      await ctx.runMutation(internal.ai.chat.addToolError, {
        threadId: request.threadId,
        toolCallId: request.toolCallId,
        error: errorMsg,
      });
    }

    return {
      status: "denied" as const,
    };
  },
});

/**
 * List all approvals for a session.
 * Used by the runtime to check what approvals are available.
 */
export const listApprovals = internalQuery({
  args: {
    sessionId: v.id("sessions"),
  },
  handler: async (ctx, args) => {
    const approvals = await ctx.db
      .query("approvals")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();

    return approvals.map((approval) =>
      normalizeApprovalRecord({
        action: approval.action,
        data: approval.data,
      }),
    );
  },
});

export const allApprovalRequestsAnswered = internalQuery({
  args: {
    sessionId: v.id("sessions"),
  },
  handler: async (ctx, args) => {
    const requests = await ctx.db
      .query("approvalRequests")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    return requests.every((r) => r.status !== "pending");
  },
});

/**
 * Get pending approval requests for a session.
 * Used by the UI to display pending approvals.
 */
export const getPendingRequests = query({
  args: {
    sessionId: v.id("sessions"),
  },
  handler: async (ctx, args) => {
    await requireSessionOwnership(ctx, args.sessionId);
    const requests = await ctx.db
      .query("approvalRequests")
      .withIndex("by_status", (q) => q.eq("sessionId", args.sessionId).eq("status", "pending"))
      .collect();

    return requests.map((request) => normalizeApprovalRequestRecord(request));
  },
});

/**
 * Get an approval request by ID.
 */
export const getApprovalRequest = query({
  args: {
    requestId: v.id("approvalRequests"),
  },
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.requestId);
    if (!request) {
      return null;
    }
    await requireSessionOwnership(ctx, request.sessionId);
    return normalizeApprovalRequestRecord(request);
  },
});

/**
 * Get approval request by tool call ID.
 * Used to display approval status in the chat UI.
 */
export const getApprovalRequestByToolCall = query({
  args: {
    sessionId: v.id("sessions"),
    toolCallId: v.string(),
  },
  handler: async (ctx, args) => {
    await requireSessionOwnership(ctx, args.sessionId);
    const requests = await ctx.db
      .query("approvalRequests")
      .withIndex("by_session_tool_call", (q) => q.eq("sessionId", args.sessionId).eq("toolCallId", args.toolCallId))
      .first();

    return requests ? normalizeApprovalRequestRecord(requests) : null;
  },
});

/**
 * Revoke an approval (for future use).
 */
export const revokeApproval = mutation({
  args: {
    approvalId: v.id("approvals"),
  },
  handler: async (ctx, args) => {
    await requireAuthenticatedUser(ctx);

    const approval = await ctx.db.get(args.approvalId);
    if (!approval) throw new Error("Approval not found");
    await requireSessionOwnership(ctx, approval.sessionId);

    await ctx.db.delete(args.approvalId);

    return { status: "revoked" as const };
  },
});

/**
 * Delete all approvals and approval requests.
 * Used for cleanup during schema migrations.
 */
export const deleteAllApprovals = internalMutation({
  args: {},
  handler: async (ctx) => {
    const approvals = await ctx.db.query("approvals").collect();
    const approvalRequests = await ctx.db.query("approvalRequests").collect();

    let deletedApprovals = 0;
    let deletedRequests = 0;

    for (const approval of approvals) {
      await ctx.db.delete(approval._id);
      deletedApprovals++;
    }

    for (const request of approvalRequests) {
      await ctx.db.delete(request._id);
      deletedRequests++;
    }

    return { deletedApprovals, deletedRequests };
  },
});
