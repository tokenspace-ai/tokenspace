import { appendFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Plugin } from "vite";
import { createLogger } from "vite";

interface LogEntry {
  level: string;
  message: string;
  timestamp: Date;
  url?: string;
  userAgent?: string;
  stacks?: string[];
  extra?: any;
}

interface ClientLogRequest {
  logs: LogEntry[];
}

export interface ConsoleForwardOptions {
  /**
   * Whether to enable console forwarding (default: true in dev mode)
   */
  enabled?: boolean;
  /**
   * API endpoint path (default: '/__debug/client-logs')
   */
  endpoint?: string;

  /**
   * Path to the log file to write the logs to (default: undefined)
   * Logs will still be written to the console, but also to the file.
   */
  logFilePath?: string;

  /**
   * Patterns to ignore for logging (default: [])
   * If a log message matches any of these patterns, it will not be written to the console or log file.
   */
  ignorePatterns?: RegExp[];
}

const logger = createLogger("info", {
  prefix: "[browser]",
});

/**
 * Vite plugin that provides a server endpoint to receive forwarded browser console logs.
 *
 * The client-side script that forwards logs is injected in __root.tsx via a <script> tag
 * that only renders in dev mode (import.meta.env.DEV).
 *
 * This plugin only provides the server-side endpoint to receive and display the logs.
 */
export function consoleForwardPlugin(options: ConsoleForwardOptions = {}): Plugin {
  const { enabled = true, endpoint = "/__debug/client-logs", logFilePath, ignorePatterns = [] } = options;

  // Helper to check if a message should be ignored
  const shouldIgnore = (message: string) => {
    return ignorePatterns.some((pattern) => pattern.test(message));
  };

  // Helper to write to log file if configured
  const writeToFile = (message: string) => {
    if (logFilePath) {
      try {
        const timestamp = new Date().toISOString();
        appendFileSync(logFilePath, `${timestamp} ${message}\n`);
      } catch {
        // Silently ignore file write errors
      }
    }
  };

  return {
    name: "console-forward",

    configureServer(server) {
      if (!enabled) return;

      // Truncate log file on server start
      if (logFilePath) {
        try {
          writeFileSync(logFilePath, "");
        } catch {
          // Silently ignore file write errors
        }
      }

      // Add API endpoint to handle forwarded console logs
      server.middlewares.use(endpoint, (req, res, next) => {
        const request = req as IncomingMessage & { method?: string };
        if (request.method !== "POST") {
          return next();
        }

        let body = "";
        request.setEncoding!("utf8");

        request.on("data", (chunk: string) => {
          body += chunk;
        });

        request.on("end", () => {
          try {
            const { logs }: ClientLogRequest = JSON.parse(body);

            // Forward each log to the Vite dev server console using Vite's logger
            for (const log of logs) {
              // Skip logs that match ignore patterns
              if (shouldIgnore(log.message)) {
                continue;
              }

              const location = log.url ? ` (${log.url})` : "";
              let message = `[${log.level}] ${log.message}${location}`;

              // Add stack traces if available
              if (log.stacks && log.stacks.length > 0) {
                message +=
                  "\n" +
                  log.stacks
                    .map((stack) =>
                      stack
                        .split("\n")
                        .map((line) => `    ${line}`)
                        .join("\n"),
                    )
                    .join("\n");
              }

              // Add extra data if available
              if (log.extra && log.extra.length > 0) {
                message +=
                  "\n    Extra data: " +
                  JSON.stringify(log.extra, null, 2)
                    .split("\n")
                    .map((line) => `    ${line}`)
                    .join("\n");
              }

              // Use Vite's logger for consistent formatting
              const logOptions = { timestamp: true };
              switch (log.level) {
                case "error": {
                  const error = log.stacks && log.stacks.length > 0 ? new Error(log.stacks.join("\n")) : null;
                  logger.error(message, { ...logOptions, error });
                  break;
                }
                case "warn":
                  logger.warn(message, logOptions);
                  break;
                case "info":
                  logger.info(message, logOptions);
                  break;
                case "debug":
                  logger.info(message, logOptions);
                  break;
                default:
                  logger.info(message, logOptions);
              }

              // Write to log file if configured
              writeToFile(`[browser] ${message}`);
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true }));
          } catch (error) {
            server.config.logger.error("Error processing client logs:", {
              timestamp: true,
              error: error as Error,
            });
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON" }));
          }
        });
      });
    },
  };
}
