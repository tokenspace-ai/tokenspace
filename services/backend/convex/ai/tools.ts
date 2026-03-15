/**
 * Tool action handlers for convex-durable-agents
 *
 * These actions are invoked by the durable-agents component when tools are called.
 * Sync tools (createActionTool) return results directly.
 * Async tools (createAsyncTool) return null and provide results later via addToolResult.
 */

import { v } from "convex/values";
import { components, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction } from "../_generated/server";

const vSubAgentProfile = v.union(v.literal("default"), v.literal("web_search"));

// ============================================================================
// Sync Tools - Return results directly
// ============================================================================

export const readFile = internalAction({
  args: {
    args: v.object({
      path: v.string(),
      startLine: v.optional(v.number()),
      lineCount: v.optional(v.number()),
    }),
    threadId: v.string(),
    toolCallId: v.string(),
    toolName: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { args, threadId, toolCallId }) => {
    try {
      const { revisionId, sessionId } = await getThreadContext(ctx, threadId);
      const result = await ctx.runAction(internal.fs.operations.readFile, {
        revisionId,
        path: args.path,
        startLine: args.startLine,
        lineCount: args.lineCount,
        sessionId,
      });
      await ctx.runMutation(internal.ai.chat.addToolResult, {
        threadId,
        toolCallId: toolCallId,
        result: result,
      });
    } catch (e: any) {
      await ctx.runMutation(internal.ai.chat.addToolError, {
        threadId,
        toolCallId: toolCallId,
        error: e.message,
      });
    }
  },
});

export const writeFile = internalAction({
  args: {
    args: v.object({
      path: v.string(),
      content: v.string(),
      append: v.optional(v.boolean()),
    }),
    threadId: v.string(),
    toolCallId: v.string(),
    toolName: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { args, threadId, toolCallId }) => {
    try {
      const { revisionId, sessionId } = await getThreadContext(ctx, threadId);
      await ctx.runAction(internal.fs.operations.writeFile, {
        revisionId,
        path: args.path,
        content: args.content,
        append: args.append ?? false,
        sessionId,
      });
      await ctx.runMutation(internal.ai.chat.addToolResult, {
        threadId,
        toolCallId: toolCallId,
        result: "File written successfully",
      });
    } catch (e: any) {
      await ctx.runMutation(internal.ai.chat.addToolError, {
        threadId,
        toolCallId: toolCallId,
        error: e.message,
      });
    }
  },
});

export const bash = internalAction({
  args: {
    args: v.object({
      description: v.optional(v.string()),
      command: v.string(),
      cwd: v.optional(v.string()),
      timeoutMs: v.optional(v.number()),
    }),
    threadId: v.string(),
    toolCallId: v.string(),
    toolName: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { args, threadId, toolCallId }) => {
    try {
      const { revisionId, sessionId } = await getThreadContext(ctx, threadId);
      if (!sessionId) {
        throw new Error("Session ID required for bash execution");
      }

      // Route bash execution through the executor job pipeline so workspace-defined
      // commands (bundled TS modules + package.json deps) and approvals work consistently.
      const approvals = await ctx.runQuery(internal.approvals.listApprovals, { sessionId });
      await ctx.runMutation(internal.executor.createJob, {
        code: args.command,
        language: "bash",
        threadId,
        toolCallId,
        revisionId,
        sessionId,
        approvals,
        cwd: args.cwd,
        timeoutMs: args.timeoutMs,
      });
    } catch (e: any) {
      await ctx.runMutation(internal.ai.chat.addToolError, {
        threadId,
        toolCallId: toolCallId,
        error: e.message,
      });
    }
  },
});

// ============================================================================
// Async Tools - Return null, provide results later via addToolResult
// ============================================================================

export const runCode = internalAction({
  args: {
    threadId: v.string(),
    toolCallId: v.string(),
    toolName: v.string(),
    args: v.object({
      description: v.optional(v.string()),
      code: v.string(),
      timeoutMs: v.optional(v.number()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, { threadId, toolCallId, args: toolArgs }): Promise<null> => {
    const { revisionId, sessionId } = await getThreadContext(ctx, threadId);
    if (!sessionId) {
      throw new Error("Session ID required for approvals");
    }

    const approvals = await ctx.runQuery(internal.approvals.listApprovals, { sessionId });
    await ctx.runMutation(internal.executor.createJob, {
      code: toolArgs.code,
      language: "typescript",
      threadId,
      toolCallId,
      revisionId,
      sessionId,
      approvals,
      timeoutMs: toolArgs.timeoutMs,
    });

    // Job will call addToolResult when it completes
    return null;
  },
});

export const requestApproval = internalAction({
  args: {
    threadId: v.string(),
    toolCallId: v.string(),
    toolName: v.string(),
    args: v.object({
      action: v.string(),
      data: v.optional(v.any()),
      info: v.optional(v.any()),
      description: v.optional(v.string()),
      reason: v.string(),
    }),
  },
  returns: v.null(),
  handler: async (ctx, { threadId, toolCallId, args: toolArgs }): Promise<null> => {
    await ctx.runMutation(components.durable_agents.tool_calls.setToolCallTimeout, {
      threadId,
      toolCallId,
      timeout: null,
    });

    const threadContext = await getThreadContext(ctx, threadId);
    if (!threadContext.sessionId) {
      throw new Error("Session ID required for approval requests");
    }
    // Create approval request - user will grant/deny via UI
    // grantApproval/denyApproval will call addToolResult
    await ctx.runMutation(internal.approvals.createApprovalRequest, {
      sessionId: threadContext.sessionId,
      threadId,
      toolCallId,
      action: toolArgs.action,
      data: toolArgs.data,
      info: toolArgs.info,
      description: toolArgs.description,
      reason: toolArgs.reason,
    });
    return null;
  },
});

export const spawnAgent = internalAction({
  args: {
    threadId: v.string(),
    toolCallId: v.string(),
    toolName: v.string(),
    args: v.object({
      prompt: v.optional(v.string()),
      contextMode: v.optional(v.union(v.literal("none"), v.literal("summary"), v.literal("full"))),
      threadId: v.optional(v.string()),
      threadIds: v.optional(v.array(v.string())),
      waitForResult: v.optional(v.boolean()),
      profile: v.optional(vSubAgentProfile),
      storeTranscript: v.optional(v.boolean()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, { threadId: parentThreadId, toolCallId, args: toolArgs }): Promise<null> => {
    const threadContext = await getThreadContext(ctx, parentThreadId);
    const sessionId = threadContext.sessionId;
    if (!sessionId) {
      throw new Error("Session ID required for spawning sub-agents");
    }

    const waitForResult = toolArgs.waitForResult !== false;

    const hasSingleThreadRef = typeof toolArgs.threadId === "string" && toolArgs.threadId.length > 0;
    const hasManyThreadRefs = Array.isArray(toolArgs.threadIds) && toolArgs.threadIds.length > 0;
    const hasEmptyThreadIds = Array.isArray(toolArgs.threadIds) && toolArgs.threadIds.length === 0;
    const hasPrompt = typeof toolArgs.prompt === "string" && toolArgs.prompt.length > 0;

    if (hasEmptyThreadIds) {
      await ctx.runMutation(internal.ai.chat.addToolError, {
        threadId: parentThreadId,
        toolCallId,
        error: "threadIds must contain at least one thread ID.",
      });
      return null;
    }

    if (hasSingleThreadRef && hasManyThreadRefs) {
      await ctx.runMutation(internal.ai.chat.addToolError, {
        threadId: parentThreadId,
        toolCallId,
        error: "Provide either threadId or threadIds, not both.",
      });
      return null;
    }

    if (hasManyThreadRefs && hasPrompt) {
      await ctx.runMutation(internal.ai.chat.addToolError, {
        threadId: parentThreadId,
        toolCallId,
        error: "prompt cannot be used with threadIds.",
      });
      return null;
    }

    if (hasManyThreadRefs && !waitForResult) {
      await ctx.runMutation(internal.ai.chat.addToolError, {
        threadId: parentThreadId,
        toolCallId,
        error: "threadIds can only be used with waitForResult=true.",
      });
      return null;
    }

    if ((hasSingleThreadRef || hasManyThreadRefs) && toolArgs.profile) {
      await ctx.runMutation(internal.ai.chat.addToolError, {
        threadId: parentThreadId,
        toolCallId,
        error: "profile is only supported when spawning a new sub-agent.",
      });
      return null;
    }

    if ((hasSingleThreadRef || hasManyThreadRefs) && toolArgs.contextMode) {
      await ctx.runMutation(internal.ai.chat.addToolError, {
        threadId: parentThreadId,
        toolCallId,
        error: "contextMode is only supported when spawning a new sub-agent.",
      });
      return null;
    }

    // Wait for multiple existing sub-agents to complete.
    if (hasManyThreadRefs) {
      const threadIds = [...new Set(toolArgs.threadIds!)];
      const rows = (await ctx.runQuery(internal.ai.subagent.getSubAgentsByThreadIds, {
        threadIds: threadIds,
      })) as Array<{
        threadId: string;
        sessionId: Id<"sessions">;
        runSeq?: number;
      } | null>;
      const subAgents = rows.filter((row): row is NonNullable<(typeof rows)[number]> => row != null);
      if (subAgents.length !== rows.length) {
        await ctx.runMutation(internal.ai.chat.addToolError, {
          threadId: parentThreadId,
          toolCallId,
          error: "One or more sub-agent threads were not found.",
        });
        return null;
      }
      if (subAgents.some((row) => row.sessionId !== sessionId)) {
        await ctx.runMutation(internal.ai.chat.addToolError, {
          threadId: parentThreadId,
          toolCallId,
          error: "All referenced sub-agent threads must belong to the current session.",
        });
        return null;
      }

      const now = Date.now();
      const waiterId = `${parentThreadId}:${toolCallId}`;
      const threadTargets = subAgents.map((row) => ({
        threadId: row.threadId,
        runSeq: row.runSeq ?? 1,
      }));
      await ctx.runMutation(internal.ai.subagent.registerWaiters, {
        threadIds: threadIds,
        waiter: {
          waiterId,
          parentThreadId,
          toolCallId,
          mode: "all",
          threadTargets,
          storeTranscript: toolArgs.storeTranscript,
          createdAt: now,
        },
      });

      for (const subAgentThreadId of threadIds) {
        await ctx.runAction(internal.ai.subagent.processTerminalSubAgent, {
          threadId: subAgentThreadId,
        });
      }
      return null;
    }

    // Continue or wait for one existing sub-agent.
    if (hasSingleThreadRef) {
      const subAgentThreadId = toolArgs.threadId!;
      const subThread = await ctx.runQuery(internal.ai.subagent.getPendingSubAgent, {
        threadId: subAgentThreadId,
      });
      if (!subThread) {
        await ctx.runMutation(internal.ai.chat.addToolError, {
          threadId: parentThreadId,
          toolCallId,
          error: "Sub-agent thread not found.",
        });
        return null;
      }
      if (subThread.sessionId !== sessionId) {
        await ctx.runMutation(internal.ai.chat.addToolError, {
          threadId: parentThreadId,
          toolCallId,
          error: "Sub-agent thread does not belong to the current session.",
        });
        return null;
      }

      // Continue with a follow-up prompt.
      if (hasPrompt) {
        const terminal =
          subThread.status === "completed" || subThread.status === "failed" || subThread.status === "stopped";
        if (!terminal) {
          await ctx.runMutation(internal.ai.chat.addToolError, {
            threadId: parentThreadId,
            toolCallId,
            error: "Sub-agent can only be continued after it reaches a terminal status.",
          });
          return null;
        }

        await ctx.runMutation(internal.ai.subagent.continueSubThread, {
          threadId: subAgentThreadId,
          parentThreadId,
          waitForResult,
          toolCallId,
          storeTranscript: toolArgs.storeTranscript,
        });
        await ctx.runMutation(internal.ai.subagent.sendSubAgentMessage, {
          threadId: subAgentThreadId,
          prompt: toolArgs.prompt!,
        });

        if (!waitForResult) {
          await ctx.runMutation(internal.ai.chat.addToolResult, {
            threadId: parentThreadId,
            toolCallId,
            result: { threadId: subAgentThreadId, status: "running" },
          });
        }
        return null;
      }

      // Wait for completion of an existing sub-agent.
      if (!waitForResult) {
        await ctx.runMutation(internal.ai.chat.addToolError, {
          threadId: parentThreadId,
          toolCallId,
          error: "Waiting for an existing sub-agent requires waitForResult=true.",
        });
        return null;
      }

      const now = Date.now();
      const waiterId = `${parentThreadId}:${toolCallId}`;
      await ctx.runMutation(internal.ai.subagent.registerWaiters, {
        threadIds: [subAgentThreadId],
        waiter: {
          waiterId,
          parentThreadId,
          toolCallId,
          mode: "single",
          threadTargets: [{ threadId: subAgentThreadId, runSeq: subThread.runSeq ?? 1 }],
          storeTranscript: toolArgs.storeTranscript,
          createdAt: now,
        },
      });
      await ctx.runAction(internal.ai.subagent.processTerminalSubAgent, {
        threadId: subAgentThreadId,
      });
      return null;
    }

    // Spawn a new sub-agent.
    if (!hasPrompt) {
      await ctx.runMutation(internal.ai.chat.addToolError, {
        threadId: parentThreadId,
        toolCallId,
        error: "Prompt is required when spawning a new sub-agent.",
      });
      return null;
    }

    const subThread = await ctx.runMutation(internal.ai.subagent.createSubThread, {
      parentThreadId,
      sessionId,
      prompt: toolArgs.prompt!,
      contextMode: toolArgs.contextMode,
      toolCallId,
      waitForResult,
      profile: toolArgs.profile,
      storeTranscript: toolArgs.storeTranscript,
    });

    await ctx.runMutation(internal.ai.subagent.sendSubAgentMessage, {
      threadId: subThread.threadId,
      prompt: subThread.prompt,
    });

    if (!waitForResult) {
      await ctx.runMutation(internal.ai.chat.addToolResult, {
        threadId: parentThreadId,
        toolCallId,
        result: { threadId: subThread.threadId, status: "spawned" },
      });
    }

    return null;
  },
});

export const replayToolCall = internalAction({
  args: {
    threadId: v.string(),
    toolCallId: v.string(),
    toolName: v.string(),
    args: v.optional(v.any()),
  },
  returns: v.null(),
  handler: async (ctx, { threadId, toolCallId, toolName, args: toolArgs }): Promise<null> => {
    try {
      const outcome = await ctx.runMutation(internal.ai.replay.consumeReplayToolOutcome, {
        threadId,
        toolCallId,
        toolName,
        toolArgs,
      });

      if (outcome.status === "error") {
        await ctx.runMutation(internal.ai.chat.addToolError, {
          threadId,
          toolCallId,
          error: outcome.error,
        });
      } else {
        await ctx.runMutation(internal.ai.chat.addToolResult, {
          threadId,
          toolCallId,
          result: outcome.result,
        });
      }
    } catch (e: any) {
      await ctx.runMutation(internal.ai.chat.addToolError, {
        threadId,
        toolCallId,
        error: e?.message ?? "Replay tool execution failed",
      });
    }
    return null;
  },
});

// ============================================================================
// Helpers
// ============================================================================

async function getThreadContext(
  ctx: any,
  threadId: string,
): Promise<{
  revisionId: Id<"revisions">;
  sessionId: Id<"sessions"> | undefined;
  userId: string;
}> {
  const context = await ctx.runQuery(internal.ai.thread.getThreadContext, { threadId });
  if (!context) {
    throw new Error("Thread context not found");
  }

  const sessionId = context.sessionId as Id<"sessions"> | undefined;
  const revisionId = context.revisionId as Id<"revisions"> | undefined;

  if (!revisionId) {
    throw new Error("Revision ID not found for thread");
  }

  // Ensure the base revision filesystem is materialized for this revision.
  await ctx.runAction(internal.compile.materializeRevisionFiles, {
    revisionId,
  });

  return {
    revisionId,
    sessionId,
    userId: context.userId,
  };
}
