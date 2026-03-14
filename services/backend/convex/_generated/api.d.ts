/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as ai_agent from "../ai/agent.js";
import type * as ai_chat from "../ai/chat.js";
import type * as ai_mockModel from "../ai/mockModel.js";
import type * as ai_modelResolver from "../ai/modelResolver.js";
import type * as ai_provider from "../ai/provider.js";
import type * as ai_recorder from "../ai/recorder.js";
import type * as ai_replay from "../ai/replay.js";
import type * as ai_replaySchema from "../ai/replaySchema.js";
import type * as ai_replayUtils from "../ai/replayUtils.js";
import type * as ai_subagent from "../ai/subagent.js";
import type * as ai_thread from "../ai/thread.js";
import type * as ai_tools from "../ai/tools.js";
import type * as approvals from "../approvals.js";
import type * as auth from "../auth.js";
import type * as authz from "../authz.js";
import type * as compile from "../compile.js";
import type * as compileJobs from "../compileJobs.js";
import type * as content from "../content.js";
import type * as credentials from "../credentials.js";
import type * as credentialsCrypto from "../credentialsCrypto.js";
import type * as crons from "../crons.js";
import type * as executor from "../executor.js";
import type * as executorAuth from "../executorAuth.js";
import type * as executors from "../executors.js";
import type * as fs_fileBlobs from "../fs/fileBlobs.js";
import type * as fs_index from "../fs/index.js";
import type * as fs_operations from "../fs/operations.js";
import type * as fs_overlay from "../fs/overlay.js";
import type * as fs_revision from "../fs/revision.js";
import type * as fs_working from "../fs/working.js";
import type * as health from "../health.js";
import type * as playground from "../playground.js";
import type * as resend from "../resend.js";
import type * as revisionBuild from "../revisionBuild.js";
import type * as revisions from "../revisions.js";
import type * as seed from "../seed.js";
import type * as sessions from "../sessions.js";
import type * as trees from "../trees.js";
import type * as users from "../users.js";
import type * as vcs from "../vcs.js";
import type * as workingStateHash from "../workingStateHash.js";
import type * as workspace from "../workspace.js";
import type * as workspaceMetadata from "../workspaceMetadata.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "ai/agent": typeof ai_agent;
  "ai/chat": typeof ai_chat;
  "ai/mockModel": typeof ai_mockModel;
  "ai/modelResolver": typeof ai_modelResolver;
  "ai/provider": typeof ai_provider;
  "ai/recorder": typeof ai_recorder;
  "ai/replay": typeof ai_replay;
  "ai/replaySchema": typeof ai_replaySchema;
  "ai/replayUtils": typeof ai_replayUtils;
  "ai/subagent": typeof ai_subagent;
  "ai/thread": typeof ai_thread;
  "ai/tools": typeof ai_tools;
  approvals: typeof approvals;
  auth: typeof auth;
  authz: typeof authz;
  compile: typeof compile;
  compileJobs: typeof compileJobs;
  content: typeof content;
  credentials: typeof credentials;
  credentialsCrypto: typeof credentialsCrypto;
  crons: typeof crons;
  executor: typeof executor;
  executorAuth: typeof executorAuth;
  executors: typeof executors;
  "fs/fileBlobs": typeof fs_fileBlobs;
  "fs/index": typeof fs_index;
  "fs/operations": typeof fs_operations;
  "fs/overlay": typeof fs_overlay;
  "fs/revision": typeof fs_revision;
  "fs/working": typeof fs_working;
  health: typeof health;
  playground: typeof playground;
  resend: typeof resend;
  revisionBuild: typeof revisionBuild;
  revisions: typeof revisions;
  seed: typeof seed;
  sessions: typeof sessions;
  trees: typeof trees;
  users: typeof users;
  vcs: typeof vcs;
  workingStateHash: typeof workingStateHash;
  workspace: typeof workspace;
  workspaceMetadata: typeof workspaceMetadata;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  durable_agents: {
    agent: {
      continueStream: FunctionReference<
        "mutation",
        "internal",
        { threadId: string },
        null
      >;
      tryContinueAllThreads: FunctionReference<"action", "internal", {}, null>;
    };
    messages: {
      add: FunctionReference<
        "mutation",
        "internal",
        {
          committedSeq?: number;
          msg: {
            id?: string;
            metadata?: any;
            parts: Array<any>;
            role: "system" | "user" | "assistant";
          };
          overwrite?: boolean;
          streaming?: boolean;
          threadId: string;
        },
        string
      >;
      applyToolOutcomes: FunctionReference<
        "mutation",
        "internal",
        { threadId: string },
        Array<{
          _creationTime: number;
          _id: string;
          committedSeq?: number;
          id: string;
          metadata?: any;
          parts: Array<any>;
          role: "system" | "user" | "assistant";
          threadId: string;
        }>
      >;
      list: FunctionReference<
        "query",
        "internal",
        { excludeSystemMessages?: boolean; threadId: string },
        Array<{
          _creationTime: number;
          _id: string;
          committedSeq?: number;
          id: string;
          metadata?: any;
          parts: Array<any>;
          role: "system" | "user" | "assistant";
          threadId: string;
        }>
      >;
    };
    streams: {
      abort: FunctionReference<
        "mutation",
        "internal",
        { reason: string; streamId: string },
        boolean
      >;
      addDelta: FunctionReference<
        "mutation",
        "internal",
        {
          lockId: string;
          msgId: string;
          parts: Array<any>;
          seq: number;
          streamId: string;
        },
        boolean
      >;
      cancelInactiveStreams: FunctionReference<
        "mutation",
        "internal",
        { activeStreamId: string; threadId: string },
        null
      >;
      create: FunctionReference<
        "mutation",
        "internal",
        { threadId: string },
        string
      >;
      deleteStreamAsync: FunctionReference<
        "mutation",
        "internal",
        { cursor?: string; streamId: string },
        null
      >;
      finish: FunctionReference<
        "mutation",
        "internal",
        { streamId: string },
        null
      >;
      heartbeat: FunctionReference<
        "mutation",
        "internal",
        { lockId: string; streamId: string },
        boolean
      >;
      queryStreamingMessageUpdates: FunctionReference<
        "query",
        "internal",
        { fromSeq?: number; threadId: string },
        { messages: Array<{ msgId: string; parts: Array<any> }> }
      >;
      take: FunctionReference<
        "mutation",
        "internal",
        { lockId: string; streamId: string; threadId: string },
        any
      >;
    };
    threads: {
      clearRetryState: FunctionReference<
        "mutation",
        "internal",
        { threadId: string },
        null
      >;
      clearStreamId: FunctionReference<
        "mutation",
        "internal",
        { streamId?: string; threadId: string },
        boolean
      >;
      create: FunctionReference<
        "mutation",
        "internal",
        {
          onStatusChangeHandle?: string;
          streamFnHandle: string;
          toolExecutionWorkpoolEnqueueAction?: string;
          workpoolEnqueueAction?: string;
        },
        {
          _creationTime: number;
          _id: string;
          retryState?: {
            attempt: number;
            error: string;
            kind?: string;
            maxAttempts: number;
            nextRetryAt: number;
            requiresExplicitHandling: boolean;
            retryFnId?: string;
            retryable: boolean;
            scope: "stream";
          };
          status:
            | "streaming"
            | "awaiting_tool_results"
            | "completed"
            | "failed"
            | "stopped";
          stopSignal: boolean;
          streamFnHandle: string;
          streamId?: string | null;
          toolExecutionWorkpoolEnqueueAction?: string;
          workpoolEnqueueAction?: string;
        }
      >;
      finalizeStreamTurn: FunctionReference<
        "mutation",
        "internal",
        {
          expectedSeq?: number;
          status?:
            | "streaming"
            | "awaiting_tool_results"
            | "completed"
            | "failed"
            | "stopped";
          streamId: string;
          threadId: string;
        },
        boolean
      >;
      get: FunctionReference<
        "query",
        "internal",
        { threadId: string },
        {
          _creationTime: number;
          _id: string;
          retryState?: {
            attempt: number;
            error: string;
            kind?: string;
            maxAttempts: number;
            nextRetryAt: number;
            requiresExplicitHandling: boolean;
            retryFnId?: string;
            retryable: boolean;
            scope: "stream";
          };
          status:
            | "streaming"
            | "awaiting_tool_results"
            | "completed"
            | "failed"
            | "stopped";
          stopSignal: boolean;
          streamFnHandle: string;
          streamId?: string | null;
          toolExecutionWorkpoolEnqueueAction?: string;
          workpoolEnqueueAction?: string;
        } | null
      >;
      list: FunctionReference<
        "query",
        "internal",
        { limit?: number },
        Array<{
          _creationTime: number;
          _id: string;
          retryState?: {
            attempt: number;
            error: string;
            kind?: string;
            maxAttempts: number;
            nextRetryAt: number;
            requiresExplicitHandling: boolean;
            retryFnId?: string;
            retryable: boolean;
            scope: "stream";
          };
          status:
            | "streaming"
            | "awaiting_tool_results"
            | "completed"
            | "failed"
            | "stopped";
          stopSignal: boolean;
          streamFnHandle: string;
          streamId?: string | null;
          toolExecutionWorkpoolEnqueueAction?: string;
          workpoolEnqueueAction?: string;
        }>
      >;
      listIncomplete: FunctionReference<"query", "internal", {}, Array<string>>;
      remove: FunctionReference<
        "mutation",
        "internal",
        { threadId: string },
        null
      >;
      resume: FunctionReference<
        "mutation",
        "internal",
        { threadId: string },
        null
      >;
      scheduleRetry: FunctionReference<
        "mutation",
        "internal",
        {
          attempt: number;
          error: string;
          kind?: string;
          maxAttempts: number;
          nextRetryAt: number;
          requiresExplicitHandling: boolean;
          retryable: boolean;
          scope: "stream";
          threadId: string;
        },
        null
      >;
      setStatus: FunctionReference<
        "mutation",
        "internal",
        {
          status:
            | "streaming"
            | "awaiting_tool_results"
            | "completed"
            | "failed"
            | "stopped";
          streamId?: string;
          threadId: string;
        },
        null
      >;
      setStopSignal: FunctionReference<
        "mutation",
        "internal",
        { stopSignal: boolean; threadId: string },
        null
      >;
    };
    tool_calls: {
      addToolError: FunctionReference<
        "mutation",
        "internal",
        { error: string; threadId: string; toolCallId: string },
        null
      >;
      addToolResult: FunctionReference<
        "mutation",
        "internal",
        { result: any; threadId: string; toolCallId: string },
        null
      >;
      create: FunctionReference<
        "mutation",
        "internal",
        {
          args: any;
          callback?: string;
          handler?: string;
          msgId: string;
          retry?: any;
          saveDelta: boolean;
          threadId: string;
          toolCallId: string;
          toolName: string;
        },
        {
          _creationTime: number;
          _id: string;
          args: any;
          callbackAttempt?: number;
          callbackLastError?: string;
          error?: string;
          executionAttempt?: number;
          executionLastError?: string;
          executionMaxAttempts?: number;
          executionRetryPolicy?: any;
          handler?: string;
          msgId: string;
          nextRetryAt?: number;
          result?: any;
          status: "pending" | "completed" | "failed";
          threadId: string;
          toolCallId: string;
          toolName: string;
        }
      >;
      getByToolCallId: FunctionReference<
        "query",
        "internal",
        { threadId: string; toolCallId: string },
        {
          _creationTime: number;
          _id: string;
          args: any;
          callbackAttempt?: number;
          callbackLastError?: string;
          error?: string;
          executionAttempt?: number;
          executionLastError?: string;
          executionMaxAttempts?: number;
          executionRetryPolicy?: any;
          handler?: string;
          msgId: string;
          nextRetryAt?: number;
          result?: any;
          status: "pending" | "completed" | "failed";
          threadId: string;
          toolCallId: string;
          toolName: string;
        } | null
      >;
      list: FunctionReference<
        "query",
        "internal",
        { threadId: string },
        Array<{
          _creationTime: number;
          _id: string;
          args: any;
          callbackAttempt?: number;
          callbackLastError?: string;
          error?: string;
          executionAttempt?: number;
          executionLastError?: string;
          executionMaxAttempts?: number;
          executionRetryPolicy?: any;
          handler?: string;
          msgId: string;
          nextRetryAt?: number;
          result?: any;
          status: "pending" | "completed" | "failed";
          threadId: string;
          toolCallId: string;
          toolName: string;
        }>
      >;
      listPending: FunctionReference<
        "query",
        "internal",
        { threadId: string },
        Array<{
          _creationTime: number;
          _id: string;
          args: any;
          callbackAttempt?: number;
          callbackLastError?: string;
          error?: string;
          executionAttempt?: number;
          executionLastError?: string;
          executionMaxAttempts?: number;
          executionRetryPolicy?: any;
          handler?: string;
          msgId: string;
          nextRetryAt?: number;
          result?: any;
          status: "pending" | "completed" | "failed";
          threadId: string;
          toolCallId: string;
          toolName: string;
        }>
      >;
      resumePendingSyncToolExecutions: FunctionReference<
        "mutation",
        "internal",
        { limit?: number },
        number
      >;
      scheduleAsyncToolCall: FunctionReference<
        "mutation",
        "internal",
        {
          args: any;
          callback: string;
          msgId: string;
          saveDelta: boolean;
          threadId: string;
          toolCallId: string;
          toolName: string;
        },
        null
      >;
      scheduleToolCall: FunctionReference<
        "mutation",
        "internal",
        {
          args: any;
          handler: string;
          msgId: string;
          retry?: any;
          saveDelta: boolean;
          threadId: string;
          toolCallId: string;
          toolName: string;
        },
        null
      >;
      setError: FunctionReference<
        "mutation",
        "internal",
        { error: string; id: string },
        boolean
      >;
      setResult: FunctionReference<
        "mutation",
        "internal",
        { id: string; result: any },
        boolean
      >;
      setToolCallTimeout: FunctionReference<
        "mutation",
        "internal",
        { threadId: string; timeout: number | null; toolCallId: string },
        null
      >;
    };
  };
  resend: {
    lib: {
      cancelEmail: FunctionReference<
        "mutation",
        "internal",
        { emailId: string },
        null
      >;
      cleanupAbandonedEmails: FunctionReference<
        "mutation",
        "internal",
        { olderThan?: number },
        null
      >;
      cleanupOldEmails: FunctionReference<
        "mutation",
        "internal",
        { olderThan?: number },
        null
      >;
      createManualEmail: FunctionReference<
        "mutation",
        "internal",
        {
          from: string;
          headers?: Array<{ name: string; value: string }>;
          replyTo?: Array<string>;
          subject: string;
          to: Array<string> | string;
        },
        string
      >;
      get: FunctionReference<
        "query",
        "internal",
        { emailId: string },
        {
          bcc?: Array<string>;
          bounced?: boolean;
          cc?: Array<string>;
          clicked?: boolean;
          complained: boolean;
          createdAt: number;
          deliveryDelayed?: boolean;
          errorMessage?: string;
          failed?: boolean;
          finalizedAt: number;
          from: string;
          headers?: Array<{ name: string; value: string }>;
          html?: string;
          opened: boolean;
          replyTo: Array<string>;
          resendId?: string;
          segment: number;
          status:
            | "waiting"
            | "queued"
            | "cancelled"
            | "sent"
            | "delivered"
            | "delivery_delayed"
            | "bounced"
            | "failed";
          subject?: string;
          template?: {
            id: string;
            variables?: Record<string, string | number>;
          };
          text?: string;
          to: Array<string>;
        } | null
      >;
      getStatus: FunctionReference<
        "query",
        "internal",
        { emailId: string },
        {
          bounced: boolean;
          clicked: boolean;
          complained: boolean;
          deliveryDelayed: boolean;
          errorMessage: string | null;
          failed: boolean;
          opened: boolean;
          status:
            | "waiting"
            | "queued"
            | "cancelled"
            | "sent"
            | "delivered"
            | "delivery_delayed"
            | "bounced"
            | "failed";
        } | null
      >;
      handleEmailEvent: FunctionReference<
        "mutation",
        "internal",
        { event: any },
        null
      >;
      sendEmail: FunctionReference<
        "mutation",
        "internal",
        {
          bcc?: Array<string>;
          cc?: Array<string>;
          from: string;
          headers?: Array<{ name: string; value: string }>;
          html?: string;
          options: {
            apiKey: string;
            initialBackoffMs: number;
            onEmailEvent?: { fnHandle: string };
            retryAttempts: number;
            testMode: boolean;
          };
          replyTo?: Array<string>;
          subject?: string;
          template?: {
            id: string;
            variables?: Record<string, string | number>;
          };
          text?: string;
          to: Array<string>;
        },
        string
      >;
      updateManualEmail: FunctionReference<
        "mutation",
        "internal",
        {
          emailId: string;
          errorMessage?: string;
          resendId?: string;
          status:
            | "waiting"
            | "queued"
            | "cancelled"
            | "sent"
            | "delivered"
            | "delivery_delayed"
            | "bounced"
            | "failed";
        },
        null
      >;
    };
  };
};
