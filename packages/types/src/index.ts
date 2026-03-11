/**
 * @tokenspace/types - Type definitions for agent-generated code
 *
 * This package contains:
 * - LIB: Minimal TypeScript lib definitions (excludes browser/node globals)
 * - BUILTINS: Built-in types for the Tokenspace sandbox runtime
 *
 * Source files are in .d.ts format for easy editing, except BUILTINS which are sourced from
 * @tokenspace/sdk to keep a single source of truth.
 * The build step generates string exports for consumption by the compiler.
 */

export { BUILTINS, MINIMAL_LIB, SANDBOX_TYPES } from "./generated";
