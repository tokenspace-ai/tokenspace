import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  vCapabilitySummary,
  vCredentialRequirementSummary,
  vSkillSummary,
  vWorkspaceModelDefinition,
} from "./workspaceMetadata";

// Shared validators for workspace filesystem
const treeEntryValidator = v.object({
  name: v.string(),
  type: v.union(v.literal("file"), v.literal("directory")),
  blobId: v.optional(v.id("blobs")), // For files
  treeId: v.optional(v.id("trees")), // For directories
});

const chatStatusValidator = v.union(
  v.literal("streaming"),
  v.literal("awaiting_tool_results"),
  v.literal("waiting_for_approval"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("stopped"),
);

const workspaceRoleValidator = v.union(v.literal("workspace_admin"), v.literal("member"));
const workspaceInvitationStatusValidator = v.union(
  v.literal("pending"),
  v.literal("accepted"),
  v.literal("dismissed"),
  v.literal("revoked"),
);

export default defineSchema({
  // Chat threads (backed by durable-agents component threads)
  chats: defineTable({
    threadId: v.string(),
    // Session context - threads share filesystem overlays via sessions
    sessionId: v.id("sessions"), // Session this thread belongs to
    userId: v.string(),
    workspaceId: v.id("workspaces"),
    revisionId: v.id("revisions"),
    // Denormalized thread status for chat-level listing/filtering
    status: v.optional(chatStatusValidator),
    // Chat list metadata
    title: v.optional(v.string()),
    summary: v.optional(v.string()),
    messageCount: v.optional(v.number()),
    lastUserMessageAt: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
    modelId: v.optional(v.string()),
    replayState: v.optional(
      v.object({
        turnIndex: v.number(),
        streamIndex: v.number(),
        toolOutcomeIndex: v.optional(v.number()),
        currentTurnSignature: v.optional(v.string()),
        lastCompletedTurnSignature: v.optional(v.string()),
      }),
    ),
    lastProviderMetadata: v.optional(v.any()),
    // Token usage tracking (for the root thread)
    usage: v.optional(
      v.object({
        inputTokens: v.number(),
        outputTokens: v.number(),
        totalTokens: v.number(),
        reasoningTokens: v.optional(v.number()),
        cachedInputTokens: v.optional(v.number()),
        cacheWriteInputTokens: v.optional(v.number()),
      }),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_thread_id", ["threadId"])
    .index("by_session", ["sessionId"])
    .index("by_workspace_user_last_message", ["workspaceId", "userId", "lastUserMessageAt"]),

  // Recorded LLM conversations (dev/test replay fixtures)
  llmRecordings: defineTable({
    recordingId: v.string(),
    displayName: v.optional(v.string()),
    showInReplayModelPicker: v.optional(v.boolean()),
    playbackSettings: v.optional(
      v.object({
        initialDelayMs: v.optional(v.number()),
        chunkDelayMs: v.optional(v.number()),
      }),
    ),
    // Recorded outcomes for tool calls in the conversation, used by replay mode
    // to return deterministic tool results/errors without executing real tools.
    toolOutcomes: v.optional(
      v.array(
        v.object({
          toolCallId: v.string(),
          toolName: v.string(),
          args: v.optional(v.any()),
          status: v.union(v.literal("result"), v.literal("error")),
          result: v.optional(v.any()),
          error: v.optional(v.string()),
        }),
      ),
    ),
    sourceThreadId: v.optional(v.string()),
    modelId: v.optional(v.string()),
    provider: v.optional(v.string()),
    recording: v.any(),
    turnCount: v.number(),
    streamCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_recording_id", ["recordingId"])
    .index("by_source_thread_id", ["sourceThreadId"])
    .index("by_updated_at", ["updatedAt"]),

  // ============================================================================
  // Sessions - groups threads that share filesystem overlays
  // ============================================================================

  sessions: defineTable({
    userId: v.string(),
    // Single source of truth for workspace/branch/working-state context.
    revisionId: v.id("revisions"),
    chatId: v.optional(v.id("chats")),
    createdAt: v.number(),
    updatedAt: v.number(),
    status: v.union(v.literal("active"), v.literal("completed"), v.literal("failed")),
  }),

  // Tracks sub-agents (relationships + optional result collection)
  subAgents: defineTable({
    parentThreadId: v.string(),
    threadId: v.string(),
    depth: v.number(),
    toolCallId: v.string(),
    promptMessageId: v.optional(v.string()),
    sessionId: v.id("sessions"),
    rootChatId: v.optional(v.id("chats")),
    rootThreadId: v.optional(v.string()),
    userId: v.optional(v.string()),
    workspaceId: v.optional(v.id("workspaces")),
    revisionId: v.optional(v.id("revisions")),
    profile: v.optional(v.union(v.literal("default"), v.literal("web_search"))),
    modelIdOverride: v.optional(v.string()),
    systemPromptOverride: v.optional(v.string()),
    toolPolicy: v.optional(v.union(v.literal("inherit"), v.literal("web_search_only"))),
    waitForResult: v.optional(v.boolean()),
    runSeq: v.optional(v.number()),
    lastNotifiedRunSeq: v.optional(v.number()),
    waiters: v.optional(
      v.array(
        v.object({
          waiterId: v.string(),
          parentThreadId: v.string(),
          toolCallId: v.string(),
          mode: v.union(v.literal("single"), v.literal("all")),
          threadTargets: v.array(
            v.object({
              threadId: v.string(),
              runSeq: v.number(),
            }),
          ),
          storeTranscript: v.optional(v.boolean()),
          createdAt: v.number(),
        }),
      ),
    ),
    storeTranscript: v.optional(v.boolean()),
    transcriptPath: v.optional(v.string()),
    transcriptUpdatedAt: v.optional(v.number()),
    status: v.union(
      v.literal("initializing"),
      v.literal("running"),
      v.literal("awaiting_tool_results"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("stopped"),
      v.literal("detached"),
    ),
    result: v.optional(v.any()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    updatedAt: v.optional(v.number()),
  })
    .index("by_parent", ["parentThreadId"])
    .index("by_child", ["threadId"])
    .index("by_session", ["sessionId"])
    .index("by_session_tool_call", ["sessionId", "toolCallId"])
    .index("by_root_thread", ["rootThreadId"])
    .index("by_status", ["status"])
    .index("by_session_status", ["sessionId", "status"]),

  // ============================================================================
  // Workspace Filesystem Tables
  // ============================================================================

  // Workspaces - isolated environments for each org/team
  workspaces: defineTable({
    name: v.string(),
    slug: v.string(), // URL-friendly identifier
    activeCommitId: v.optional(v.id("commits")), // Current production version
    iconBlobId: v.optional(v.id("blobs")),
    iconMimeType: v.optional(v.string()),
    models: v.optional(
      v.array(
        v.object({
          id: v.optional(v.string()),
          modelId: v.string(),
          label: v.optional(v.string()),
          isDefault: v.boolean(),
          systemPrompt: v.optional(v.string()),
          providerOptions: v.optional(v.any()),
        }),
      ),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
    // unused for now:
    gitSyncEnabled: v.optional(v.boolean()),
  }).index("by_slug", ["slug"]),

  workspaceMemberships: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.string(),
    role: workspaceRoleValidator,
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_user", ["userId"])
    .index("by_workspace_user", ["workspaceId", "userId"]),

  workspaceInvitations: defineTable({
    workspaceId: v.id("workspaces"),
    email: v.string(),
    role: workspaceRoleValidator,
    status: workspaceInvitationStatusValidator,
    invitedBy: v.string(),
    invitedUserId: v.optional(v.string()),
    workosInvitationId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    acceptedAt: v.optional(v.number()),
    dismissedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
  })
    .index("by_workspace_status", ["workspaceId", "status"])
    .index("by_workspace_email_status", ["workspaceId", "email", "status"])
    .index("by_email_status", ["email", "status"])
    .index("by_invited_user_status", ["invitedUserId", "status"]),

  // Commits - immutable snapshots of workspace state
  commits: defineTable({
    workspaceId: v.id("workspaces"),
    parentId: v.optional(v.id("commits")),
    treeId: v.id("trees"),
    message: v.string(),
    authorId: v.string(),
    createdAt: v.number(),
  }).index("by_workspace", ["workspaceId"]),

  // Branches - named pointers to commits
  branches: defineTable({
    workspaceId: v.id("workspaces"),
    name: v.string(),
    commitId: v.id("commits"),
    isDefault: v.boolean(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_name", ["workspaceId", "name"]),

  // Trees - directory structure snapshots (content-addressed)
  trees: defineTable({
    workspaceId: v.id("workspaces"),
    hash: v.string(), // SHA of sorted entries
    entries: v.array(treeEntryValidator),
  }).index("by_hash", ["workspaceId", "hash"]),

  // Blobs - file contents (content-addressed, deduplicated)
  blobs: defineTable({
    workspaceId: v.id("workspaces"),
    hash: v.string(), // SHA-256 of content
    storageId: v.optional(v.id("_storage")),
    content: v.optional(v.string()),
    size: v.number(),
  }).index("by_hash", ["workspaceId", "hash"]),

  // Working directory - uncommitted changes per user/branch
  workingFiles: defineTable({
    workspaceId: v.id("workspaces"),
    branchId: v.id("branches"),
    userId: v.string(),
    path: v.string(),
    content: v.optional(v.string()), // undefined means file is deleted or stored in blob
    blobId: v.optional(v.id("blobs")),
    isDeleted: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_branch_user", ["branchId", "userId"])
    .index("by_path", ["branchId", "userId", "path"]),

  // Revisions - compiled workspace snapshots stored in file storage
  revisions: defineTable({
    workspaceId: v.id("workspaces"),
    branchId: v.id("branches"),
    commitId: v.id("commits"),
    // Hash of working files included, if any (for deduplication)
    workingStateHash: v.optional(v.string()),
    // Optional fingerprint of compiled artifact set used for this revision.
    artifactFingerprint: v.optional(v.string()),
    // File storage references for compiled artifacts
    revisionFsStorageId: v.optional(v.id("_storage")), // JSON blob with declarations, docs, memory
    // TODO: remove once migrated - legacy field renamed to revisionFsStorageId
    sandboxStorageId: v.optional(v.id("_storage")),
    bundleStorageId: v.id("_storage"), // Bundled JS for runtime execution
    depsStorageId: v.optional(v.id("_storage")), // JSON blob with package.json + lockfiles (if present)
    // Optional build-time artifacts for traceability/debugging.
    metadataStorageId: v.optional(v.id("_storage")),
    diagnosticsStorageId: v.optional(v.id("_storage")),
    manifestStorageId: v.optional(v.id("_storage")),
    compilerVersion: v.optional(v.string()),
    sourceFingerprint: v.optional(v.string()),
    compileMode: v.optional(v.union(v.literal("local"), v.literal("server"))),
    // Cached workspace metadata resolved at revision creation time
    capabilities: v.optional(v.array(vCapabilitySummary)),
    skills: v.optional(v.array(vSkillSummary)),
    tokenspaceMd: v.optional(v.string()),
    credentialRequirements: v.optional(v.array(vCredentialRequirementSummary)),
    models: v.optional(v.array(vWorkspaceModelDefinition)),
    // Metadata
    createdAt: v.number(),
  })
    .index("by_branch_commit", ["branchId", "commitId"])
    .index("by_branch_working", ["branchId", "commitId", "workingStateHash"]),

  // ============================================================================
  // Existing Tables
  // ============================================================================

  usageRecords: defineTable({
    userId: v.optional(v.string()),
    threadId: v.optional(v.string()),
    chatId: v.optional(v.id("chats")),
    sessionId: v.optional(v.id("sessions")),
    agentName: v.optional(v.string()),
    model: v.string(),
    provider: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    totalTokens: v.number(),
    reasoningTokens: v.optional(v.number()),
    cachedInputTokens: v.optional(v.number()),
    cacheWriteInputTokens: v.optional(v.number()),
    providerMetadata: v.optional(v.any()),
    cost: v.optional(v.number()),
    marketCost: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_thread", ["threadId"])
    .index("by_chat", ["chatId"])
    .index("by_session", ["sessionId"])
    .index("by_model", ["model"]),

  // Materialized revision filesystem files from a revision
  revisionFiles: defineTable({
    revisionId: v.id("revisions"),
    name: v.string(),
    parent: v.optional(v.string()),
    content: v.optional(v.string()),
    blobId: v.optional(v.id("blobs")),
    binary: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_revision_path", ["revisionId", "parent", "name"])
    .index("by_revision", ["revisionId"]),

  // Session-scoped overlay files - captures changes made during a session
  // These overlay the base revisionFiles without modifying them
  // All threads in a session share the same overlay
  sessionOverlayFiles: defineTable({
    sessionId: v.id("sessions"),
    name: v.string(),
    parent: v.optional(v.string()),
    content: v.optional(v.string()), // undefined means file is deleted or stored in blob
    blobId: v.optional(v.id("blobs")),
    binary: v.boolean(),
    isDeleted: v.boolean(), // true if file was deleted in this overlay
    updatedAt: v.number(),
  })
    .index("by_session_path", ["sessionId", "parent", "name"])
    .index("by_session", ["sessionId"]),

  // Encrypted credential values keyed by workspace + logical credential id + scope subject
  credentialValues: defineTable({
    workspaceId: v.id("workspaces"),
    credentialId: v.string(),
    scope: v.union(v.literal("workspace"), v.literal("session"), v.literal("user")),
    subject: v.string(),
    kind: v.union(v.literal("secret"), v.literal("oauth")),
    keyVersion: v.number(),
    iv: v.string(),
    ciphertext: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    updatedByUserId: v.optional(v.string()),
  })
    .index("by_workspace_credential_id_scope_subject", ["workspaceId", "credentialId", "scope", "subject"])
    .index("by_workspace", ["workspaceId"])
    .index("by_workspace_scope", ["workspaceId", "scope"])
    .index("by_workspace_scope_subject", ["workspaceId", "scope", "subject"]),

  // OAuth authorization attempts (short-lived, single-use) used for interactive connect flows
  oauthAuthorizations: defineTable({
    workspaceId: v.id("workspaces"),
    revisionId: v.id("revisions"),
    credentialId: v.string(),
    scope: v.union(v.literal("workspace"), v.literal("session"), v.literal("user")),
    subject: v.string(),
    initiatedByUserId: v.string(),
    grantType: v.union(v.literal("authorization_code"), v.literal("client_credentials"), v.literal("implicit")),
    state: v.string(),
    codeVerifier: v.optional(v.string()),
    returnPath: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    consumedAt: v.optional(v.number()),
    status: v.union(v.literal("pending"), v.literal("completed"), v.literal("failed"), v.literal("expired")),
  })
    .index("by_state", ["state"])
    .index("by_expires_at", ["expiresAt"])
    .index("by_workspace", ["workspaceId"])
    .index("by_workspace_scope_subject", ["workspaceId", "scope", "subject"]),

  jobs: defineTable({
    code: v.string(),
    language: v.optional(v.union(v.literal("typescript"), v.literal("bash"))), // Defaults to typescript
    threadId: v.optional(v.string()),
    toolCallId: v.optional(v.string()),
    promptMessageId: v.optional(v.string()),
    revisionId: v.optional(v.id("revisions")), // Revision containing the bundle to execute against
    sessionId: v.optional(v.id("sessions")), // Session for persistent filesystem access
    cwd: v.optional(v.string()), // Working directory relative to /sandbox (for bash commands)
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("canceled"),
    ),
    // Lease / ownership (for crash recovery + multi-runtime scaling)
    workerId: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    heartbeatAt: v.optional(v.number()),
    // Per-job timeout (enforced by the runtime supervisor)
    timeoutMs: v.optional(v.number()),
    stopRequestedAt: v.optional(v.number()),
    stopReason: v.optional(v.string()),
    output: v.optional(v.string()),
    error: v.optional(
      v.object({
        message: v.string(),
        stack: v.optional(v.string()),
        details: v.optional(v.string()),
        data: v.optional(v.any()),
      }),
    ),
    // Approvals to apply during execution
    approvals: v.optional(
      v.array(
        v.object({
          action: v.string(),
          data: v.optional(v.any()),
        }),
      ),
    ),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
  })
    .index("by_status", ["status"])
    .index("by_status_thread", ["status", "threadId"])
    .index("by_tool_call_id", ["threadId", "toolCallId"]),

  compileJobs: defineTable({
    workspaceId: v.id("workspaces"),
    branchId: v.id("branches"),
    commitId: v.id("commits"),
    workingStateHash: v.optional(v.string()),
    userId: v.optional(v.string()),
    snapshotStorageId: v.id("_storage"),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("canceled"),
    ),
    workerId: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    heartbeatAt: v.optional(v.number()),
    error: v.optional(
      v.object({
        message: v.string(),
        stack: v.optional(v.string()),
        details: v.optional(v.string()),
        data: v.optional(v.any()),
      }),
    ),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    revisionId: v.optional(v.id("revisions")),
    revisionFsDeclarationCount: v.optional(v.number()),
    revisionFsFileCount: v.optional(v.number()),
    revisionFsSystemCount: v.optional(v.number()),
    compilerVersion: v.optional(v.string()),
    sourceFingerprint: v.optional(v.string()),
    artifactFingerprint: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_workspace_status", ["workspaceId", "status"]),

  // Approvals - granted permissions for actions requiring human approval
  approvals: defineTable({
    sessionId: v.id("sessions"),
    // Matches ApprovalRequirement fields from @tokenspace/sdk
    action: v.string(),
    data: v.optional(v.any()),
    // Approval metadata
    grantedBy: v.string(), // User ID who granted the approval
    grantedAt: v.number(),
    expiresAt: v.optional(v.number()), // Optional expiration timestamp
  }).index("by_session", ["sessionId"]),

  // Pending approval requests - waiting for user decision
  approvalRequests: defineTable({
    sessionId: v.id("sessions"),
    threadId: v.optional(v.string()),
    toolCallId: v.string(), // Links to the tool call that triggered this
    promptMessageId: v.optional(v.string()),
    // Request details from ApprovalRequirement
    action: v.string(),
    type: v.optional(v.string()),
    resource: v.optional(v.string()),
    data: v.optional(v.any()),
    info: v.optional(v.any()),
    description: v.optional(v.string()),
    reason: v.string(), // Agent's explanation for why this is needed
    // Status tracking
    status: v.union(v.literal("pending"), v.literal("approved"), v.literal("denied")),
    createdAt: v.number(),
    resolvedAt: v.optional(v.number()),
    resolvedBy: v.optional(v.string()),
    resolverComment: v.optional(v.string()), // Optional comment from user when approving/denying
  })
    .index("by_session", ["sessionId"])
    .index("by_status", ["sessionId", "status"])
    .index("by_session_tool_call", ["sessionId", "toolCallId"]),

  // Bundled workspace code stored in file storage
  bundles: defineTable({
    workspaceId: v.id("workspaces"),
    commitId: v.optional(v.id("commits")), // Optional if includes working state
    branchName: v.string(),
    includesWorkingState: v.boolean(),
    userId: v.optional(v.string()), // User whose working state is included
    storageId: v.id("_storage"),
    size: v.number(),
    hash: v.string(), // SHA-256 of bundle content
    createdAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_commit", ["commitId"])
    .index("by_workspace_branch", ["workspaceId", "branchName"]),

  // Starred chats - per-user chat favorites
  starredChats: defineTable({
    userId: v.string(),
    chatId: v.id("chats"),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_chat", ["userId", "chatId"]),
});
