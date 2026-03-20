# @tokenspace/runtime-core

## 0.3.0

### Minor Changes

- fc5f745: Release a coordinated `0.3.0` across the public Tokenspace packages.

  This release adds remote TypeScript compilation on executors, executor lifecycle management and bootstrap token rotation, improved self-hosted executor deployment support, and workspace-backed capability and credential icon support across the runtime, backend, CLI, and local MCP tooling.

  It also includes follow-up fixes for executor reassignment behavior, playground execution, credential UI/state handling, and revision environment package linking so remote executors reuse the same installed SDK/runtime package instances.

### Patch Changes

- Updated dependencies [fc5f745]
  - @tokenspace/sdk@0.3.0

## 0.2.2

### Patch Changes

- c19944e: Add server-only users runtime API and update dependencies
- Updated dependencies [c19944e]
  - @tokenspace/sdk@0.2.2

## 0.2.1

### Patch Changes

- c1ccfed: Add SDK access to the execution session filesystem with `getSessionFilesystem()`, and ensure runtime executions share the same filesystem facade between capability code and builtin `fs`.

  Also harden the declaration compiler host to handle environments where `ts.sys` is unavailable.

- Updated dependencies [c1ccfed]
  - @tokenspace/sdk@0.2.1

## 0.2.0

### Patch Changes

- @tokenspace/sdk@0.2.0

## 0.1.2

### Patch Changes

- @tokenspace/sdk@0.1.2

## 0.1.1

### Patch Changes

- @tokenspace/sdk@0.1.1
