import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  type ActionCtx,
  action,
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from "./_generated/server";
import { buildMissingCredentialPayload, WORKSPACE_CREDENTIAL_SUBJECT } from "./credentials";
import type { UserInfo } from "./users";
import { resolveCurrentUserInfo, resolveVisibleUserByEmail, resolveVisibleUserById } from "./users";

const DEFAULT_JOB_TIMEOUT_MS = 5 * 60_000;
const MIN_JOB_TIMEOUT_MS = 1_000;
const MAX_JOB_TIMEOUT_MS = 60 * 60_000;
const MAX_JOB_OUTPUT_CHARS = 20_000;

function assertExecutorToken(executorToken: string): void {
  const expected = process.env.TOKENSPACE_EXECUTOR_TOKEN;
  if (!expected || executorToken !== expected) {
    throw new Error("Unauthorized");
  }
}

type PublicCtx = QueryCtx | MutationCtx;
type InternalCtx = QueryCtx | MutationCtx | ActionCtx;

async function requireUserOrExecutorToken(ctx: PublicCtx, executorToken?: string): Promise<{ userId?: string }> {
  const user = await ctx.auth.getUserIdentity();
  if (user) {
    return { userId: user.subject };
  }
  if (executorToken) {
    assertExecutorToken(executorToken);
    return {};
  }
  throw new Error("Unauthorized");
}

async function assertUserOwnsThread(ctx: PublicCtx, userId: string, threadId: string): Promise<void> {
  const context = await ctx.runQuery(internal.ai.thread.getThreadContext, { threadId });
  if (!context || context.userId !== userId) {
    throw new Error("Unauthorized");
  }
}

async function assertUserOwnsSession(ctx: PublicCtx, userId: string, sessionId: Id<"sessions">): Promise<void> {
  const session = await ctx.db.get(sessionId);
  if (!session || session.userId !== userId) {
    throw new Error("Unauthorized");
  }
}

async function assertUserCanAccessJob(ctx: PublicCtx, userId: string, job: Doc<"jobs">): Promise<void> {
  if (job.sessionId) {
    await assertUserOwnsSession(ctx, userId, job.sessionId);
    return;
  }
  if (job.threadId) {
    await assertUserOwnsThread(ctx, userId, job.threadId);
    return;
  }
  throw new Error("Unauthorized");
}

function clampTimeoutMs(timeoutMs: number | null | undefined): number {
  if (timeoutMs == null) return DEFAULT_JOB_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs)) return DEFAULT_JOB_TIMEOUT_MS;
  return Math.max(MIN_JOB_TIMEOUT_MS, Math.min(Math.floor(timeoutMs), MAX_JOB_TIMEOUT_MS));
}

type ToolResultPayload = Record<string, unknown> & {
  output: string;
  truncated: boolean;
  fullOutputPath?: string;
};

type MissingCredentialReason = "missing" | "expired" | "revoked" | "non_interactive";

type CredentialMissingPayload = {
  errorType: "CREDENTIAL_MISSING";
  credential: {
    id: string;
    label?: string;
    kind: "secret" | "env" | "oauth";
    scope: "workspace" | "session" | "user";
    reason: MissingCredentialReason;
  };
  details?: string;
};

type UserInfoUnavailablePayload = {
  errorType: "USER_INFO_UNAVAILABLE";
  reason: "non_interactive";
  details?: string;
};

function normalizeToolResult(result: unknown): ToolResultPayload {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const base = { ...(result as Record<string, unknown>) };
    const outputValue = base.output;
    const output = typeof outputValue === "string" ? outputValue : outputValue == null ? "" : String(outputValue);
    const truncated = typeof base.truncated === "boolean" ? base.truncated : false;
    const fullOutputPath = typeof base.fullOutputPath === "string" ? base.fullOutputPath : undefined;
    return fullOutputPath ? { ...base, output, truncated, fullOutputPath } : { ...base, output, truncated };
  }
  if (typeof result === "string") {
    return { output: result, truncated: false };
  }
  if (result == null) {
    return { output: "", truncated: false };
  }
  return { output: String(result), truncated: false };
}

function buildUserInfoUnavailablePayload(details: string): UserInfoUnavailablePayload {
  return {
    errorType: "USER_INFO_UNAVAILABLE",
    reason: "non_interactive",
    details,
  };
}

function truncateOutput(output: string, fullOutputPath?: string): { output: string; truncated: boolean } {
  if (output.length <= MAX_JOB_OUTPUT_CHARS) {
    return { output, truncated: false };
  }
  const pointer = fullOutputPath
    ? `(output truncated; full output saved to ${fullOutputPath})\n`
    : "(output truncated)\n";
  if (pointer.length >= MAX_JOB_OUTPUT_CHARS) {
    return { output: pointer.slice(0, MAX_JOB_OUTPUT_CHARS), truncated: true };
  }
  const tailLength = MAX_JOB_OUTPUT_CHARS - pointer.length;
  return { output: `${pointer}${output.slice(-tailLength)}`, truncated: true };
}

function truncateErrorText(text: string): string {
  if (text.length <= MAX_JOB_OUTPUT_CHARS) return text;
  const suffix = "\n(error truncated)";
  const headLength = Math.max(0, MAX_JOB_OUTPUT_CHARS - suffix.length);
  return `${text.slice(0, headLength)}${suffix}`;
}

async function getJobRecordOrThrow(ctx: InternalCtx, jobId: Id<"jobs">): Promise<Doc<"jobs">> {
  const job =
    "db" in ctx
      ? await ctx.db.get(jobId)
      : await ctx.runQuery(internal.executor.getJobInternal, {
          jobId,
        });
  if (!job) {
    throw new Error("Job not found");
  }
  return job;
}

async function getJobRevisionOrThrow(ctx: InternalCtx, job: Doc<"jobs">): Promise<Doc<"revisions">> {
  if (!job.revisionId) {
    throw new Error("Job has no revision");
  }
  const revision = await ctx.runQuery(internal.revisions.getRevision, {
    revisionId: job.revisionId,
  });
  if (!revision) {
    throw new Error("Revision not found");
  }
  return revision;
}

export async function resolveJobCallerUserId(ctx: InternalCtx, job: Doc<"jobs">): Promise<string | null> {
  if (job.sessionId) {
    const session =
      "db" in ctx
        ? await ctx.db.get(job.sessionId)
        : await ctx.runQuery(internal.sessions.getSession, {
            sessionId: job.sessionId,
          });
    return session?.userId ?? null;
  }
  if (job.threadId) {
    const threadContext = await ctx.runQuery(internal.ai.thread.getThreadContext, {
      threadId: job.threadId,
    });
    return threadContext?.userId ?? null;
  }
  return null;
}

function parseCredentialMissingPayload(data: unknown): CredentialMissingPayload | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const maybe = data as Partial<CredentialMissingPayload>;
  if (maybe.errorType !== "CREDENTIAL_MISSING") return null;
  if (!maybe.credential || typeof maybe.credential !== "object" || Array.isArray(maybe.credential)) return null;

  const credential = maybe.credential as Record<string, unknown>;
  if (
    typeof credential.id !== "string" ||
    (credential.label !== undefined && typeof credential.label !== "string") ||
    (credential.kind !== "secret" && credential.kind !== "env" && credential.kind !== "oauth") ||
    (credential.scope !== "workspace" && credential.scope !== "session" && credential.scope !== "user")
  ) {
    return null;
  }

  const rawReason = credential.reason;
  const reason: MissingCredentialReason =
    rawReason === "missing" || rawReason === "expired" || rawReason === "revoked" || rawReason === "non_interactive"
      ? rawReason
      : "missing";

  return {
    errorType: "CREDENTIAL_MISSING",
    credential: {
      id: credential.id,
      label: typeof credential.label === "string" ? credential.label : undefined,
      kind: credential.kind,
      scope: credential.scope,
      reason,
    },
    details: typeof maybe.details === "string" ? maybe.details : undefined,
  };
}

function credentialDisplayName(payload: CredentialMissingPayload): string {
  return payload.credential.label ?? payload.credential.id;
}

function credentialResolutionHint(payload: CredentialMissingPayload): string {
  if (payload.credential.reason === "non_interactive") {
    return "This non-interactive run cannot resolve user/session-scoped credentials without the required context.";
  }
  if (payload.credential.reason === "missing") {
    return `Configure "${credentialDisplayName(payload)}" for scope "${payload.credential.scope}" and retry.`;
  }
  if (payload.credential.reason === "expired") {
    return `Refresh or reconnect "${credentialDisplayName(payload)}" and retry.`;
  }
  return `Reconnect or reauthorize "${credentialDisplayName(payload)}" and retry.`;
}

export function formatCredentialMissingErrorForTool(error: {
  message: string;
  stack?: string;
  details?: string;
  data?: Record<string, unknown>;
}): string {
  const payload = parseCredentialMissingPayload(error.data);
  if (!payload) {
    return formatJobError(error);
  }

  const lines = [
    "CREDENTIAL_MISSING: Required credential is unavailable.",
    `Credential: ${credentialDisplayName(payload)} (${payload.credential.scope}/${payload.credential.kind})`,
    `Reason: ${payload.credential.reason}`,
    `Credential ID: ${payload.credential.id}`,
    `Resolution: ${credentialResolutionHint(payload)}`,
  ];
  const details = error.details ?? payload.details;
  if (details) {
    lines.push(`Details: ${details}`);
  }

  return truncateErrorText(lines.join("\n"));
}

export const pendingJobs = query({
  args: {
    executorToken: v.string(),
  },
  handler: async (ctx, args) => {
    assertExecutorToken(args.executorToken);
    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .collect();

    return jobs.map((job) => job._id);
  },
});

export const runnableJobs = query({
  args: {
    executorToken: v.string(),
  },
  handler: async (ctx, args) => {
    assertExecutorToken(args.executorToken);
    const now = Date.now();
    const pending = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .collect();

    const reclaimableRunning = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .filter((q) =>
        q.or(
          q.eq(q.field("leaseExpiresAt"), undefined),
          // Convex query builder doesn't guarantee lte exists; approximate with < now+1.
          q.lt(q.field("leaseExpiresAt"), now + 1),
        ),
      )
      .collect();

    return [...pending, ...reclaimableRunning].map((job) => job._id);
  },
});

export const getJob = query({
  args: {
    jobId: v.id("jobs"),
    executorToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireUserOrExecutorToken(ctx, args.executorToken);
    const job = await ctx.db.get(args.jobId);
    if (job && access.userId) {
      await assertUserCanAccessJob(ctx, access.userId, job);
    }
    return job;
  },
});

export const getJobInternal = internalQuery({
  args: {
    jobId: v.id("jobs"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.jobId);
  },
});

export const getJobByToolCallId = query({
  args: {
    threadId: v.string(),
    toolCallId: v.string(),
    executorToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireUserOrExecutorToken(ctx, args.executorToken);
    if (access.userId) {
      await assertUserOwnsThread(ctx, access.userId, args.threadId);
    }
    return await ctx.db
      .query("jobs")
      .withIndex("by_tool_call_id", (q) => q.eq("threadId", args.threadId).eq("toolCallId", args.toolCallId))
      .first();
  },
});

export const resolveCredentialForJob = query({
  args: {
    jobId: v.id("jobs"),
    credentialId: v.string(),
    executorToken: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    string | { accessToken: string; tokenType?: string; expiresAt?: number; scope?: string[] } | undefined
  > => {
    assertExecutorToken(args.executorToken);
    const job = await ctx.db.get(args.jobId);
    if (!job) {
      throw new Error("Job not found");
    }
    if (!job.revisionId) {
      throw new Error("Job has no revision");
    }

    const revision = await ctx.db.get(job.revisionId);
    if (!revision) {
      throw new Error("Revision not found");
    }

    const requirements = revision.credentialRequirements ?? [];
    const requirement = requirements.find((entry) => entry.id === args.credentialId);
    if (!requirement) {
      throw new ConvexError(
        buildMissingCredentialPayload({
          credentialId: args.credentialId,
          scope: "workspace",
          kind: "secret",
          details: "Credential id not found in revision metadata",
        }),
      );
    }

    let subject: string;
    if (requirement.scope === "workspace") {
      subject = WORKSPACE_CREDENTIAL_SUBJECT;
    } else if (requirement.scope === "session") {
      if (!job.sessionId) {
        if (requirement.optional) {
          return undefined;
        }
        throw new ConvexError(
          buildMissingCredentialPayload({
            credentialId: requirement.id,
            credentialLabel: requirement.label,
            kind: requirement.kind,
            scope: requirement.scope,
            reason: "non_interactive",
            details: "Session-scoped credential requires a job session context",
          }),
        );
      }
      subject = String(job.sessionId);
    } else {
      if (job.sessionId) {
        const session = await ctx.db.get(job.sessionId);
        if (session?.userId) {
          subject = session.userId;
        } else {
          if (requirement.optional) {
            return undefined;
          }
          throw new ConvexError(
            buildMissingCredentialPayload({
              credentialId: requirement.id,
              credentialLabel: requirement.label,
              kind: requirement.kind,
              scope: requirement.scope,
              reason: "non_interactive",
              details: "User-scoped credential could not resolve user from session",
            }),
          );
        }
      } else if (job.threadId) {
        const threadContext = await ctx.runQuery(internal.ai.thread.getThreadContext, {
          threadId: job.threadId,
        });
        if (threadContext?.userId) {
          subject = threadContext.userId;
        } else {
          if (requirement.optional) {
            return undefined;
          }
          throw new ConvexError(
            buildMissingCredentialPayload({
              credentialId: requirement.id,
              credentialLabel: requirement.label,
              kind: requirement.kind,
              scope: requirement.scope,
              reason: "non_interactive",
              details: "User-scoped credential could not resolve user from thread context",
            }),
          );
        }
      } else {
        if (requirement.optional) {
          return undefined;
        }
        throw new ConvexError(
          buildMissingCredentialPayload({
            credentialId: requirement.id,
            credentialLabel: requirement.label,
            kind: requirement.kind,
            scope: requirement.scope,
            reason: "non_interactive",
            details: "User-scoped credential requires a session or thread context",
          }),
        );
      }
    }

    const envConfig =
      requirement.kind === "env" &&
      requirement.config &&
      typeof requirement.config === "object" &&
      !Array.isArray(requirement.config) &&
      typeof (requirement.config as any).variableName === "string"
        ? { variableName: (requirement.config as any).variableName as string }
        : undefined;

    const resolved = await ctx.runQuery(internal.credentials.resolveCredentialForExecution, {
      workspaceId: revision.workspaceId,
      credentialId: requirement.id,
      scope: requirement.scope,
      subject,
      expectedKind: requirement.kind,
      optional: requirement.optional,
      credentialLabel: requirement.label,
      envConfig,
    });
    return resolved ?? undefined;
  },
});

export const resolveCurrentUserInfoForJob = action({
  args: {
    jobId: v.id("jobs"),
    executorToken: v.string(),
  },
  handler: async (ctx, args): Promise<UserInfo> => {
    assertExecutorToken(args.executorToken);
    const job = await getJobRecordOrThrow(ctx, args.jobId);
    const callerUserId = await resolveJobCallerUserId(ctx, job);
    if (!callerUserId) {
      throw new ConvexError(
        buildUserInfoUnavailablePayload("Current user info requires a session or thread context with a user."),
      );
    }

    const userInfo = await resolveCurrentUserInfo(callerUserId);
    if (!userInfo) {
      throw new Error("Current user could not be resolved");
    }
    return userInfo;
  },
});

export const resolveUserInfoForJob = action({
  args: {
    jobId: v.id("jobs"),
    executorToken: v.string(),
    id: v.optional(v.string()),
    email: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<UserInfo | null> => {
    assertExecutorToken(args.executorToken);
    const hasId = typeof args.id === "string" && args.id.trim().length > 0;
    const hasEmail = typeof args.email === "string" && args.email.trim().length > 0;
    if (hasId === hasEmail) {
      throw new Error("Exactly one of id or email is required");
    }

    const job = await getJobRecordOrThrow(ctx, args.jobId);
    const revision = await getJobRevisionOrThrow(ctx, job);
    const callerUserId = await resolveJobCallerUserId(ctx, job);
    if (!callerUserId) {
      throw new ConvexError(
        buildUserInfoUnavailablePayload("User lookup requires a session or thread context with a user."),
      );
    }

    if (hasId) {
      return await resolveVisibleUserById(ctx, {
        workspaceId: revision.workspaceId,
        callerUserId,
        targetUserId: args.id!.trim(),
      });
    }

    return await resolveVisibleUserByEmail(ctx, {
      workspaceId: revision.workspaceId,
      callerUserId,
      email: args.email!,
    });
  },
});

export const requestStopJob = mutation({
  args: {
    jobId: v.id("jobs"),
    reason: v.optional(v.string()),
    executorToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireUserOrExecutorToken(ctx, args.executorToken);
    const job = await ctx.db.get(args.jobId);
    if (!job) {
      throw new Error("Job not found");
    }
    if (access.userId) {
      await assertUserCanAccessJob(ctx, access.userId, job);
    }

    if (job.status === "completed" || job.status === "failed" || job.status === "canceled") {
      return job;
    }

    if (job.stopRequestedAt) {
      return job;
    }

    await ctx.db.patch(args.jobId, {
      stopRequestedAt: Date.now(),
      stopReason: args.reason,
    });

    return await ctx.db.get(args.jobId);
  },
});

export const claimJob = mutation({
  args: {
    job: v.id("jobs"),
    workerId: v.string(),
    leaseMs: v.number(),
    executorToken: v.string(),
  },
  handler: async (ctx, args) => {
    assertExecutorToken(args.executorToken);
    const job = await ctx.db.get(args.job);

    if (job == null) {
      throw new Error("Job not found");
    }

    if (job.status === "completed" || job.status === "failed" || job.status === "canceled") {
      throw new Error("Job is not claimable");
    }

    // Handle cancellation request before claiming.
    if (job.stopRequestedAt) {
      const completedAt = Date.now();
      const error = {
        message: job.stopReason ?? "Job canceled",
        data: { errorType: "CANCELED" },
      };
      await ctx.db.patch(args.job, { status: "canceled", completedAt, error });
      return {
        ...job,
        language: job.language ?? "typescript",
        sessionId: job.sessionId,
        cwd: job.cwd,
        status: "canceled" as const,
        completedAt,
        error,
        approvals: job.approvals ?? [],
        bundleUrl: null,
        depsUrl: null,
        workerId: job.workerId ?? null,
        leaseExpiresAt: job.leaseExpiresAt ?? null,
        heartbeatAt: job.heartbeatAt ?? null,
      };
    }

    const now = Date.now();
    const leaseExpiresAt = now + Math.max(1_000, Math.min(args.leaseMs, 10 * 60_000));
    const heartbeatAt = now;
    const timeoutMs = clampTimeoutMs(job.timeoutMs);

    if (job.status === "pending") {
      const startedAt = now;
      await ctx.db.patch(args.job, {
        status: "running",
        startedAt,
        workerId: args.workerId,
        leaseExpiresAt,
        heartbeatAt,
        timeoutMs,
      });
    } else if (job.status === "running") {
      const existingWorkerId = job.workerId;
      const expired = job.leaseExpiresAt == null ? true : job.leaseExpiresAt < now;

      if (existingWorkerId === args.workerId) {
        await ctx.db.patch(args.job, { leaseExpiresAt, heartbeatAt, timeoutMs });
      } else if (expired) {
        await ctx.db.patch(args.job, { workerId: args.workerId, leaseExpiresAt, heartbeatAt, timeoutMs });
      } else {
        throw new Error("Job is already claimed");
      }
    } else {
      throw new Error("Job is not claimable");
    }

    // Get bundle URL if revisionId is present
    let bundleUrl: string | null = null;
    let depsUrl: string | null = null;
    if (job.revisionId) {
      const revision = await ctx.db.get(job.revisionId);
      if (revision) {
        bundleUrl = await ctx.storage.getUrl(revision.bundleStorageId);
        if (revision.depsStorageId) {
          depsUrl = await ctx.storage.getUrl(revision.depsStorageId);
        }
      }
    }

    const updated = await ctx.db.get(args.job);
    return {
      ...(updated ?? job),
      status: "running" as const,
      language: job.language ?? "typescript",
      sessionId: job.sessionId,
      cwd: job.cwd,
      approvals: job.approvals ?? [],
      bundleUrl,
      depsUrl,
      timeoutMs,
    };
  },
});

export const heartbeatJob = mutation({
  args: {
    job: v.id("jobs"),
    workerId: v.string(),
    leaseMs: v.number(),
    executorToken: v.string(),
  },
  handler: async (ctx, args) => {
    assertExecutorToken(args.executorToken);
    const job = await ctx.db.get(args.job);

    if (job == null) {
      throw new Error("Job not found");
    }

    if (job.status !== "running") {
      throw new Error("Job is not running");
    }

    if (job.workerId !== args.workerId) {
      throw new Error("Job is not owned by this worker");
    }

    const now = Date.now();
    const leaseExpiresAt = now + Math.max(1_000, Math.min(args.leaseMs, 10 * 60_000));
    await ctx.db.patch(args.job, { heartbeatAt: now, leaseExpiresAt });
    return { heartbeatAt: now, leaseExpiresAt };
  },
});

// Validator for serializable approval format
const serializableApprovalValidator = v.object({
  action: v.string(),
  data: v.optional(v.any()),
});

export const createJob = internalMutation({
  args: {
    code: v.string(),
    language: v.optional(v.union(v.literal("typescript"), v.literal("bash"))),
    threadId: v.optional(v.string()),
    toolCallId: v.optional(v.string()),
    promptMessageId: v.optional(v.string()),
    revisionId: v.id("revisions"),
    sessionId: v.optional(v.id("sessions")),
    cwd: v.optional(v.string()),
    timeoutMs: v.optional(v.number()),
    approvals: v.optional(v.array(serializableApprovalValidator)),
  },
  handler: async (ctx, args) => {
    const timeoutMs = clampTimeoutMs(args.timeoutMs);
    const job = await ctx.db.insert("jobs", {
      code: args.code,
      language: args.language ?? "typescript",
      status: "pending",
      threadId: args.threadId,
      toolCallId: args.toolCallId,
      promptMessageId: args.promptMessageId,
      revisionId: args.revisionId,
      sessionId: args.sessionId,
      cwd: args.cwd,
      timeoutMs,
      approvals: args.approvals,
    });

    return job;
  },
});

export const startJob = mutation({
  args: {
    job: v.id("jobs"),
    executorToken: v.string(),
  },
  handler: async (ctx, args) => {
    assertExecutorToken(args.executorToken);
    const job = await ctx.db.get(args.job);

    if (job == null) {
      throw new Error("Job not found");
    }

    if (job.status !== "pending") {
      throw new Error("Job is not pending");
    }

    if (job.stopRequestedAt) {
      const completedAt = Date.now();
      const error = {
        message: job.stopReason ?? "Job canceled",
        data: { errorType: "CANCELED" },
      };
      await ctx.db.patch(args.job, { status: "canceled", completedAt, error });
      return {
        ...job,
        language: job.language ?? "typescript",
        sessionId: job.sessionId,
        cwd: job.cwd,
        status: "canceled" as const,
        completedAt,
        error,
        approvals: job.approvals ?? [],
        bundleUrl: null,
        depsUrl: null,
      };
    }

    const startedAt = Date.now();
    const timeoutMs = clampTimeoutMs(job.timeoutMs);
    await ctx.db.patch(args.job, {
      status: "running",
      startedAt,
      workerId: "legacy",
      heartbeatAt: startedAt,
      leaseExpiresAt: startedAt + 30_000,
      timeoutMs,
    });

    // Get bundle URL if revisionId is present
    let bundleUrl: string | null = null;
    let depsUrl: string | null = null;
    if (job.revisionId) {
      const revision = await ctx.db.get(job.revisionId);
      if (revision) {
        bundleUrl = await ctx.storage.getUrl(revision.bundleStorageId);
        if (revision.depsStorageId) {
          depsUrl = await ctx.storage.getUrl(revision.depsStorageId);
        }
      }
    }

    return {
      ...job,
      startedAt,
      status: "running" as const,
      language: job.language ?? "typescript",
      sessionId: job.sessionId,
      cwd: job.cwd,
      approvals: job.approvals ?? [],
      bundleUrl,
      depsUrl,
      workerId: "legacy",
      heartbeatAt: startedAt,
      leaseExpiresAt: startedAt + 30_000,
      timeoutMs,
    };
  },
});

export const completeJob = mutation({
  args: {
    job: v.id("jobs"),
    output: v.optional(v.string()),
    result: v.optional(v.any()),
    workerId: v.string(),
    executorToken: v.string(),
  },
  handler: async (ctx, args) => {
    assertExecutorToken(args.executorToken);
    const job = await ctx.db.get(args.job);

    if (job == null) {
      throw new Error("Job not found");
    }

    if (job.status !== "running") {
      throw new Error("Job is not running");
    }

    if (job.workerId !== args.workerId) {
      throw new Error("Job is not owned by this worker");
    }

    if (args.result === undefined && args.output === undefined) {
      throw new Error("Job completion requires output or result payload");
    }

    const rawResult = args.result ?? args.output ?? "";
    const normalizedResult = normalizeToolResult(rawResult);
    const truncatedOutput = truncateOutput(normalizedResult.output, normalizedResult.fullOutputPath);
    const toolResult: ToolResultPayload = {
      ...normalizedResult,
      output: truncatedOutput.output,
      truncated: normalizedResult.truncated || truncatedOutput.truncated,
    };

    const completedAt = Date.now();
    await ctx.db.patch(args.job, { status: "completed", completedAt, output: truncatedOutput.output });

    // Add tool result via durable-agents API
    if (job.toolCallId && job.threadId) {
      await ctx.runMutation(internal.ai.chat.addToolResult, {
        threadId: job.threadId,
        toolCallId: job.toolCallId,
        result: toolResult,
      });
    }

    return {
      ...job,
      completedAt,
      status: "completed",
      output: truncatedOutput.output,
    };
  },
});

export const cancelJob = mutation({
  args: {
    job: v.id("jobs"),
    workerId: v.optional(v.string()),
    executorToken: v.string(),
    error: v.optional(
      v.object({
        message: v.string(),
        stack: v.optional(v.string()),
        details: v.optional(v.string()),
        data: v.optional(v.any()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    assertExecutorToken(args.executorToken);
    const job = await ctx.db.get(args.job);

    if (job == null) {
      throw new Error("Job not found");
    }

    if (job.status !== "running" && job.status !== "pending") {
      throw new Error("Job is not cancelable");
    }

    if (args.workerId && job.workerId !== args.workerId) {
      throw new Error("Job is not owned by this worker");
    }

    const canceledAt = Date.now();
    const error = args.error ?? {
      message: job.stopReason ?? "Job canceled",
      data: { errorType: "CANCELED" },
    };

    await ctx.db.patch(args.job, { status: "canceled", completedAt: canceledAt, error });

    // Add tool error via durable-agents API
    if (job.toolCallId && job.threadId) {
      await ctx.runMutation(internal.ai.chat.addToolError, {
        threadId: job.threadId,
        toolCallId: job.toolCallId,
        error: `Code execution canceled:\n${error.message}`,
      });
    }

    return {
      ...job,
      completedAt: canceledAt,
      status: "canceled",
      error,
    };
  },
});

export const failJob = mutation({
  args: {
    job: v.id("jobs"),
    workerId: v.string(),
    executorToken: v.string(),
    error: v.object({
      message: v.string(),
      stack: v.optional(v.string()),
      details: v.optional(v.string()),
      data: v.optional(v.any()),
    }),
  },
  handler: async (ctx, args) => {
    assertExecutorToken(args.executorToken);
    const job = await ctx.db.get(args.job);

    if (job == null) {
      throw new Error("Job not found");
    }

    if (job.status !== "running") {
      throw new Error("Job is not running");
    }

    if (job.workerId !== args.workerId) {
      throw new Error("Job is not owned by this worker");
    }

    await ctx.db.patch(args.job, { status: "failed", completedAt: Date.now(), error: args.error });

    // Check if this is an approval-required error
    const isApprovalRequired =
      args.error.data &&
      typeof args.error.data === "object" &&
      (args.error.data as any).errorType === "APPROVAL_REQUIRED";

    console.log(
      `Job failed thread=${job.threadId} toolCallId=${job.toolCallId} promptMessageId=${job.promptMessageId}`,
      { job: args.job, error: args.error.message, isApprovalRequired },
    );

    // Add tool error via durable-agents API
    if (job.toolCallId && job.threadId) {
      const errorMessage = isApprovalRequired
        ? formatApprovalRequiredError(args.error)
        : formatCredentialMissingErrorForTool(args.error);
      await ctx.runMutation(internal.ai.chat.addToolError, {
        threadId: job.threadId,
        toolCallId: job.toolCallId,
        error: errorMessage,
      });
    }
  },
});

function formatApprovalRequiredError(error: {
  message: string;
  stack?: string;
  details?: string;
  data?: Record<string, unknown>;
}) {
  const approval = (error.data as any)?.approval;
  if (!approval) {
    return truncateErrorText(`Approval required: ${error.message}`);
  }
  return truncateErrorText(`APPROVAL_REQUIRED: Action requires human approval.
Action: ${approval.action}
${approval.data ? `Data: ${JSON.stringify(approval.data)}` : ""}
${approval.description ? `Description: ${approval.description}` : ""}
${approval.info ? `Info: ${JSON.stringify(approval.info)}` : ""}

Use the requestApproval tool to request approval from the user.`);
}

function formatJobError(error: { message: string; stack?: string; details?: string; data?: Record<string, unknown> }) {
  return truncateErrorText(
    `Code execution failed:\n${error.message}${error.stack ? `\n${error.stack}` : ""}${
      error.details ? `\n${error.details}` : ""
    }${error.data ? `\n${JSON.stringify(error.data)}` : ""}`,
  );
}
