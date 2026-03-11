import type { ConvexLogger, FunctionLogEntry, FunctionLogLine } from "./logger";

const initialBackoff = 500;
const maxBackoff = 16000;

function nextBackoff(prevFailures: number): number {
  const baseBackoff = initialBackoff * 2 ** prevFailures;
  const actualBackoff = Math.min(baseBackoff, maxBackoff);
  const jitter = actualBackoff * (Math.random() - 0.5);
  return actualBackoff + jitter;
}

// UDF type prefix (Q=Query, M=Mutation, A=Action, H=HttpAction)
const udfTypePrefix: Record<string, string> = {
  Query: "Q",
  Mutation: "M",
  Action: "A",
  HttpAction: "H",
};

/**
 * Format a function log entry prefix.
 */
export function formatFunctionLogPrefix(entry: FunctionLogEntry): string {
  const timestampMs = entry.timestamp * 1000;
  const localizedTimestamp = new Date(timestampMs).toLocaleString();
  const prefix = udfTypePrefix[entry.udfType] ?? "?";
  return `${localizedTimestamp} [CONVEX ${prefix}(${entry.identifier})]`;
}

/**
 * Process a function log entry and forward to the appropriate logger method.
 */
export function processFunctionLogEntry(entry: FunctionLogEntry, logger: ConvexLogger): void {
  const logPrefix = formatFunctionLogPrefix(entry);

  // Process log lines
  for (const logLine of entry.logLines) {
    let level: string;
    let message: string;

    if (typeof logLine === "string") {
      // Legacy string format: "[LEVEL] message"
      const match = logLine.match(/^\[(\w+)\]\s*/);
      if (match?.[1]) {
        level = match[1];
        message = logLine.slice(match[0].length);
      } else {
        level = "LOG";
        message = logLine;
      }
    } else {
      // Structured log line
      const structured = logLine as FunctionLogLine;
      level = structured.level;
      message = structured.messages.join(" ");
      if (structured.isTruncated) {
        message += " (truncated)";
      }
    }

    const formattedMessage = `${logPrefix} [${level}] ${message}`;

    // Route to appropriate logger method based on level
    switch (level) {
      case "ERROR":
        logger.error(formattedMessage);
        break;
      case "WARN":
        logger.warn(formattedMessage);
        break;
      case "DEBUG":
        logger.debug(formattedMessage);
        break;
      default:
        // LOG, INFO, and others go to debug (function logs are verbose)
        logger.debug(formattedMessage);
        break;
    }
  }

  // Handle errors
  if (entry.error) {
    logger.error(`${logPrefix} ${entry.error}`);
  }
}

/**
 * Watch function logs from the Convex backend and forward them to the logger.
 *
 * @param backendUrl - The URL of the Convex backend
 * @param adminKey - The admin key for authentication
 * @param logger - The logger to forward logs to
 * @param abortSignal - Signal to stop watching
 */
export async function watchFunctionLogs(
  backendUrl: string,
  adminKey: string,
  logger: ConvexLogger,
  abortSignal: AbortSignal,
): Promise<void> {
  let cursor = 0;
  let numFailures = 0;

  while (!abortSignal.aborted) {
    try {
      const response = await fetch(`${backendUrl}/api/stream_function_logs?cursor=${cursor}`, {
        method: "GET",
        headers: {
          Authorization: `Convex ${adminKey}`,
        },
        signal: abortSignal,
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch logs: ${response.status}`);
      }

      const data = (await response.json()) as {
        entries: FunctionLogEntry[];
        newCursor: number;
      };

      cursor = data.newCursor;
      numFailures = 0;

      // Forward each log entry to the logger
      for (const entry of data.entries) {
        processFunctionLogEntry(entry, logger);
      }
    } catch {
      if (abortSignal.aborted) {
        break;
      }
      numFailures++;
      const backoff = nextBackoff(numFailures);
      if (numFailures > 3) {
        logger.warn(`Failed to fetch function logs, retrying in ${Math.round(backoff)}ms...`);
      }
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
}
