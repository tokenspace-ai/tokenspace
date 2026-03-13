/**
 * @tokenspace/types - Type definitions for agent-generated code
 *
 * This package contains:
 * - LIB: Minimal TypeScript lib definitions (excludes browser/node globals)
 * - BUILTINS_LOCAL / BUILTINS_SERVER: Built-in types for local and server runtime modes
 *
 * Source files are in .d.ts format for easy editing, except BUILTINS which are sourced from
 * @tokenspace/sdk to keep a single source of truth.
 * The build step generates string exports for consumption by the compiler.
 */

export { BUILTINS, BUILTINS_LOCAL, BUILTINS_SERVER, MINIMAL_LIB, SANDBOX_TYPES } from "./generated";
