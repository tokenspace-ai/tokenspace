import type { SerializableApproval } from "@tokenspace/sdk";
import { TokenspaceError } from "@tokenspace/sdk";
import { ConvexClient } from "convex/browser";
import { executeCode } from "./exec";
import type { ChildToParentMessage, ParentToChildMessage } from "./worker-protocol";

type WorkerState = {
  revisionId: string | null;
  bundleUrl: string | null;
  bundlePath: string | null;
  instanceToken: string | null;
};

function writeMessage(message: ChildToParentMessage) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function toErrorPayload(error: unknown): {
  message: string;
  stack?: string;
  details?: string;
  data?: Record<string, unknown>;
} {
  if (error instanceof TokenspaceError) {
    return {
      message: error.message,
      stack: error.stack,
      details: error.details,
      data: error.data as Record<string, unknown> | undefined,
    };
  }
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

async function main() {
  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    throw new Error("CONVEX_URL is required");
  }

  const convex = new ConvexClient(convexUrl);
  const state: WorkerState = { revisionId: null, bundleUrl: null, bundlePath: null, instanceToken: null };

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      void handleLine(line).catch((error) => {
        const payload = toErrorPayload(error);
        // Best-effort: emit a generic error without a jobId/requestId.
        // Parent will treat this as worker failure.
        process.stderr.write(`[worker] fatal handler error: ${payload.message}\n`);
      });
      idx = buffer.indexOf("\n");
    }
  });

  async function handleLine(line: string) {
    const message = JSON.parse(line) as ParentToChildMessage;
    if (message.type === "init") {
      state.revisionId = message.revisionId;
      writeMessage({ type: "ready", requestId: message.requestId, revisionId: message.revisionId });
      return;
    }

    if (message.type === "token_update") {
      state.instanceToken = message.instanceToken;
      return;
    }

    if (message.type === "exec") {
      if (state.revisionId && state.revisionId !== message.revisionId) {
        writeMessage({
          type: "error",
          requestId: message.requestId,
          jobId: message.jobId,
          error: {
            message: `Worker revision mismatch: expected ${state.revisionId} got ${message.revisionId}`,
          },
        });
        return;
      }

      if (message.bundleUrl) {
        state.bundleUrl = message.bundleUrl;
      }
      if (message.bundlePath) {
        state.bundlePath = message.bundlePath;
      }

      const approvals = (message.approvals ?? []) as SerializableApproval[];
      state.instanceToken = message.instanceToken;

      try {
        const result = await executeCode(message.code, convex, {
          approvals,
          bundleUrl: state.bundleUrl,
          bundlePath: state.bundlePath,
          getInstanceToken: () => state.instanceToken ?? undefined,
          language: message.language,
          jobId: message.jobId,
          sessionId: message.sessionId,
          cwd: message.cwd,
          timeoutMs: message.timeoutMs,
        });
        writeMessage({ type: "result", requestId: message.requestId, jobId: message.jobId, result });
      } catch (error) {
        writeMessage({
          type: "error",
          requestId: message.requestId,
          jobId: message.jobId,
          error: toErrorPayload(error),
        });
      }
      return;
    }
  }
}

main().catch((error) => {
  const payload = toErrorPayload(error);
  process.stderr.write(`[worker] fatal: ${payload.message}\n`);
  process.exit(1);
});
