/**
 * Library entrypoint for convex-vite-plugin.
 *
 * This module exports the core ConvexBackend functionality without the Vite plugin,
 * for use in test suites, scripts, or other Node.js environments.
 *
 * @example
 * ```ts
 * import { ConvexBackend } from "convex-vite-plugin/lib";
 *
 * const backend = new ConvexBackend({});
 * await backend.startBackend("/tmp/convex-test");
 *
 * // Run your tests...
 *
 * await backend.stop();
 * ```
 */

// Backend exports
export { ConvexBackend, type ConvexBackendOptions, launchConvexBackend } from "./backend";
// Dashboard exports
export { type ConvexDashboard, type ConvexDashboardOptions, launchConvexDashboard } from "./dashboard";
// Auto deployer exports
export { AutoDeployer } from "./deploy";
// Key generation utilities
export { generateAdminKey, generateInstanceSecret, generateKeyPair } from "./keys";
// Logger exports
export {
  type ConvexLogger,
  createConvexLogger,
  type FunctionLogEntry,
  type FunctionLogLevel,
  type FunctionLogLine,
  type LogLevel,
  normalizeLogger,
  type UdfType,
} from "./logger";
// Function log watcher exports
export { formatFunctionLogPrefix, processFunctionLogEntry, watchFunctionLogs } from "./logs";
// Utility exports
export { getConvexBackendVersion, loadPersistedKeys, type PersistedKeys } from "./utils";
