import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalQuery, mutation, query } from "./_generated/server";
import { requireAuthenticatedUser, requireSessionOwnership, requireWorkspaceMember } from "./authz";
import { loadFileContent, resolveInlineContent } from "./fs/fileBlobs";

/**
 * Run code in the playground without requiring a thread context.
 * This is a public endpoint for standalone code execution.
 */
export const runPlaygroundCode = action({
  args: {
    code: v.string(),
    language: v.optional(v.union(v.literal("typescript"), v.literal("bash"))),
    revisionId: v.id("revisions"),
    sessionId: v.optional(v.id("sessions")),
    cwd: v.optional(v.string()),
    timeoutMs: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ success: boolean; error?: string; jobId?: string; sessionId?: Id<"sessions"> }> => {
    const user = await requireAuthenticatedUser(ctx);
    const revision = await ctx.runQuery(internal.revisions.getRevision, {
      revisionId: args.revisionId,
    });
    if (!revision) {
      throw new Error("Revision not found");
    }
    await requireWorkspaceMember(ctx, revision.workspaceId);
    let sessionId: Id<"sessions">;
    if (args.sessionId) {
      const session = await requireSessionOwnership(ctx, args.sessionId);
      if (session.revisionId !== args.revisionId) {
        throw new Error("Session revision does not match requested revision");
      }
      sessionId = args.sessionId;
    } else {
      sessionId = await ctx.runMutation(internal.sessions.createSession, {
        userId: user.subject,
        revisionId: args.revisionId,
      });
    }

    const language = args.language ?? "typescript";
    const approvals = await ctx.runQuery(internal.approvals.listApprovals, { sessionId });

    const job = await ctx.runMutation(internal.executor.createJob, {
      code: args.code,
      language,
      revisionId: args.revisionId,
      sessionId,
      cwd: language === "bash" ? args.cwd : undefined,
      timeoutMs: args.timeoutMs,
      approvals,
    });

    return { success: true, jobId: job, sessionId };
  },
});

/**
 * Create an approval request for a playground job.
 * Used by the UI when a playground run fails with an APPROVAL_REQUIRED error.
 */
export const createPlaygroundApprovalRequest = mutation({
  args: {
    sessionId: v.id("sessions"),
    jobId: v.id("jobs"),
    action: v.string(),
    data: v.optional(v.any()),
    info: v.optional(v.any()),
    description: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"approvalRequests">> => {
    await requireSessionOwnership(ctx, args.sessionId);
    const job = await ctx.db.get(args.jobId);
    if (!job) {
      throw new Error("Job not found");
    }
    if (job.sessionId !== args.sessionId) {
      throw new Error("Job does not belong to this session");
    }

    const toolCallId = `playground:${args.jobId}`;
    const existing = await ctx.db
      .query("approvalRequests")
      .withIndex("by_session_tool_call", (q) => q.eq("sessionId", args.sessionId).eq("toolCallId", toolCallId))
      .first();
    if (existing) return existing._id;

    const reason =
      args.reason ??
      `Playground requested approval for ${args.action}. Approving will add this approval to the current session. Re-run the code to continue.`;

    const result = await ctx.runMutation(internal.approvals.createApprovalRequest, {
      sessionId: args.sessionId,
      toolCallId,
      action: args.action,
      data: args.data,
      info: args.info,
      description: args.description,
      reason,
    });

    return result.requestId;
  },
});

export const getJob = query({
  args: {
    jobId: v.id("jobs"),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    success: boolean;
    error?: string;
    job?: {
      _id: string;
      code: string;
      language: string;
      threadId?: string;
      toolCallId?: string;
      status: string;
      output?: string;
      error?: {
        message: string;
        stack?: string;
        details?: string;
        data?: Record<string, unknown>;
      };
      // Timing details
      startedAt?: number;
      completedAt?: number;
      timeoutMs?: number;
      // Stop/cancel details
      stopRequestedAt?: number;
      stopReason?: string;
      // Worker details
      workerId?: string;
    };
  }> => {
    await requireAuthenticatedUser(ctx);
    const job = await ctx.db.get(args.jobId);
    if (!job) {
      return { success: false, error: "Job not found" };
    }
    if (!job.sessionId) {
      return { success: false, error: "Job has no associated session" };
    }
    await requireSessionOwnership(ctx, job.sessionId);
    return {
      success: true,
      job: {
        _id: job._id,
        code: job.code,
        language: job.language ?? "typescript",
        threadId: job.threadId,
        toolCallId: job.toolCallId,
        status: job.status,
        output: job.output,
        error: job.error,
        // Timing details
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        timeoutMs: job.timeoutMs,
        // Stop/cancel details
        stopRequestedAt: job.stopRequestedAt,
        stopReason: job.stopReason,
        // Worker details
        workerId: job.workerId,
      },
    };
  },
});

/**
 * Get type definitions from a specific revision's revisionFiles.
 * This returns .d.ts files from the capabilities/ directory of the revision.
 */

// Internal query to list revision filesystem file entries with inline/blob metadata.
export const listTypeDefinitionEntries = internalQuery({
  args: {
    revisionId: v.id("revisions"),
  },
  handler: async (ctx, args) => {
    const entries: Array<{
      name: string;
      parent: string | undefined;
      content: string | undefined;
      blobId: Id<"blobs"> | undefined;
      binary: boolean;
    }> = [];
    for await (const entry of ctx.db
      .query("revisionFiles")
      .withIndex("by_revision", (q) => q.eq("revisionId", args.revisionId))) {
      // Match .d.ts files in capabilities/ directory (e.g., capabilities/github/capability.d.ts)
      if (entry.name.endsWith(".d.ts") && entry.parent?.startsWith("capabilities")) {
        entries.push({
          name: entry.name,
          parent: entry.parent,
          content: entry.content,
          blobId: entry.blobId,
          binary: entry.binary,
        });
      }
      // Also include builtins.d.ts at root
      if (entry.name === "builtins.d.ts" && !entry.parent) {
        entries.push({
          name: entry.name,
          parent: entry.parent,
          content: entry.content,
          blobId: entry.blobId,
          binary: entry.binary,
        });
      }
    }
    return entries;
  },
});

// Action to load type definitions (can access storage for large files)
export const getTypeDefinitionsForRevision = action({
  args: {
    revisionId: v.id("revisions"),
  },
  handler: async (ctx, args): Promise<{ fileName: string; content: string }[]> => {
    await requireAuthenticatedUser(ctx);
    const revision = await ctx.runQuery(internal.revisions.getRevision, {
      revisionId: args.revisionId,
    });
    if (!revision) {
      throw new Error("Revision not found");
    }
    await requireWorkspaceMember(ctx, revision.workspaceId);

    const entries = await ctx.runQuery(internal.playground.listTypeDefinitionEntries, {
      revisionId: args.revisionId,
    });
    const result: { fileName: string; content: string }[] = [];

    for (const entry of entries) {
      // Use loadFileContent to handle both inline content and blob-stored content (for large files)
      const content = await loadFileContent(ctx, entry, { binary: false });
      if (content !== undefined) {
        const fileName = entry.parent ? `${entry.parent}/${entry.name}` : entry.name;
        result.push({ fileName, content });
      }
    }

    return result;
  },
});

type Example = {
  capabilityName: string;
  label: string;
  code: string;
};

/**
 * Get code examples from CAPABILITY.md files in a revision.
 * Parses TypeScript code blocks from markdown files.
 */
export const getExamplesForRevision = query({
  args: {
    revisionId: v.id("revisions"),
  },
  handler: async (ctx, args): Promise<Example[]> => {
    await requireAuthenticatedUser(ctx);
    const revision = await ctx.db.get(args.revisionId);
    if (!revision) {
      throw new Error("Revision not found");
    }
    await requireWorkspaceMember(ctx, revision.workspaceId);
    const examples: Example[] = [];

    for await (const entry of ctx.db
      .query("revisionFiles")
      .withIndex("by_revision", (q) => q.eq("revisionId", args.revisionId))) {
      // Match CAPABILITY.md files in capabilities/ directory
      if (entry.name === "CAPABILITY.md" && entry.parent?.startsWith("capabilities")) {
        const capabilityName = entry.parent.split("/")[1] || entry.parent;
        const content = await resolveInlineContent(entry);
        if (content !== undefined) {
          const parsedExamples = parseExamplesFromMarkdown(content, capabilityName);
          examples.push(...parsedExamples);
        }
      }
    }

    return examples;
  },
});

/**
 * Parse TypeScript code examples from markdown content.
 * Looks for ```typescript code blocks and uses preceding text as labels.
 */
function parseExamplesFromMarkdown(content: string, capabilityName: string): Example[] {
  const examples: Example[] = [];

  // Split content into lines for easier processing
  const lines = content.split("\n");
  let currentLabel = "";
  let inCodeBlock = false;
  let codeBlockContent: string[] = [];
  let codeBlockLanguage = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Check for code block start
    if (line.startsWith("```typescript") || line.startsWith("```ts")) {
      inCodeBlock = true;
      codeBlockLanguage = "typescript";
      codeBlockContent = [];

      // Look backwards for a label (non-empty line before the code block)
      for (let j = i - 1; j >= 0; j--) {
        const prevLine = lines[j]?.trim();
        if (prevLine) {
          // Skip empty lines and find the first non-empty line
          // Remove markdown formatting like headers (#) and bold (**)
          currentLabel = prevLine
            .replace(/^#+\s*/, "") // Remove header markers
            .replace(/\*\*/g, "") // Remove bold markers
            .replace(/:$/, "") // Remove trailing colon
            .trim();
          break;
        }
      }
      continue;
    }

    // Check for code block end
    if (inCodeBlock && line.startsWith("```")) {
      inCodeBlock = false;
      if (codeBlockLanguage === "typescript" && codeBlockContent.length > 0) {
        const code = codeBlockContent.join("\n").trim();
        if (code) {
          examples.push({
            capabilityName,
            label: currentLabel || `${capabilityName} example ${examples.length + 1}`,
            code,
          });
        }
      }
      currentLabel = "";
      codeBlockContent = [];
      continue;
    }

    // Collect code block content
    if (inCodeBlock) {
      codeBlockContent.push(line);
    }
  }

  return examples;
}

/**
 * List revisions for a branch, most recent first.
 */
export const listRevisions = query({
  args: {
    branchId: v.id("branches"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireAuthenticatedUser(ctx);
    const limit = args.limit ?? 10;
    return await ctx.db
      .query("revisions")
      .withIndex("by_branch_commit", (q) => q.eq("branchId", args.branchId))
      .order("desc")
      .take(limit);
  },
});

/**
 * Find or create a revision for a branch and return its ID.
 * This ensures revision filesystem files are materialized.
 */
export const ensureRevision = action({
  args: {
    workspaceId: v.id("workspaces"),
    branchId: v.id("branches"),
  },
  returns: v.object({
    compileJobId: v.optional(v.id("compileJobs")),
    existingRevisionId: v.optional(v.id("revisions")),
  }),
  handler: async (ctx, args): Promise<{ compileJobId?: Id<"compileJobs">; existingRevisionId?: Id<"revisions"> }> => {
    const { user } = await requireWorkspaceMember(ctx, args.workspaceId);
    return await ctx.runAction(internal.compile.enqueueBranchCompile, {
      workspaceId: args.workspaceId,
      branchId: args.branchId,
      includeWorkingState: false,
      userId: user.subject,
      checkExistingRevision: true,
    });
  },
});

// ============================================================================
// Playground Session Management (uses regular sessions)
// ============================================================================

/**
 * Create a new session for playground use.
 * This creates a regular session that can be used for persistent filesystem access.
 */
export const createPlaygroundSession = mutation({
  args: {
    revisionId: v.id("revisions"),
  },
  handler: async (ctx, args): Promise<Id<"sessions">> => {
    const user = await requireAuthenticatedUser(ctx);
    const now = Date.now();
    // Create a session for filesystem overlay (playground doesn't use threads).
    return await ctx.db.insert("sessions", {
      userId: user.subject,
      revisionId: args.revisionId,
      createdAt: now,
      updatedAt: now,
      status: "active",
    });
  },
});

/**
 * Get a session by ID.
 */
export const getSession = query({
  args: {
    sessionId: v.id("sessions"),
  },
  handler: async (ctx, args) => {
    return await requireSessionOwnership(ctx, args.sessionId);
  },
});

/**
 * Reset a playground session by deleting all its overlay files.
 */
export const resetPlaygroundSession = mutation({
  args: {
    sessionId: v.id("sessions"),
  },
  handler: async (ctx, args) => {
    await requireSessionOwnership(ctx, args.sessionId);
    // Delete all overlay files for this session
    const overlayFiles = await ctx.db
      .query("sessionOverlayFiles")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    for (const file of overlayFiles) {
      await ctx.db.delete(file._id);
    }

    // Update session timestamp
    await ctx.db.patch(args.sessionId, { updatedAt: Date.now() });
  },
});
