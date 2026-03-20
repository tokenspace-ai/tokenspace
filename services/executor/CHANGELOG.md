# @tokenspace/executor

## 0.3.0

### Minor Changes

- fc5f745: Release a coordinated `0.3.0` across the public Tokenspace packages.

  This release adds remote TypeScript compilation on executors, executor lifecycle management and bootstrap token rotation, improved self-hosted executor deployment support, and workspace-backed capability and credential icon support across the runtime, backend, CLI, and local MCP tooling.

  It also includes follow-up fixes for executor reassignment behavior, playground execution, credential UI/state handling, and revision environment package linking so remote executors reuse the same installed SDK/runtime package instances.

### Patch Changes

- Updated dependencies [fc5f745]
  - @tokenspace/sdk@0.3.0
  - @tokenspace/compiler@0.3.0
  - @tokenspace/runtime-core@0.3.0
  - @tokenspace/backend@0.3.0
  - @tokenspace/session-fs@0.3.0

## 0.2.2

### Patch Changes

- c19944e: Publish executor, backend, and session-fs packages for self-hosted executor support
- Updated dependencies [c19944e]
- Updated dependencies [c19944e]
  - @tokenspace/backend@0.2.2
  - @tokenspace/session-fs@0.2.2
  - @tokenspace/sdk@0.2.2
  - @tokenspace/compiler@0.2.2
  - @tokenspace/runtime-core@0.2.2
