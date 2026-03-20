# tokenspace

## 0.3.0

### Minor Changes

- fc5f745: Release a coordinated `0.3.0` across the public Tokenspace packages.

  This release adds remote TypeScript compilation on executors, executor lifecycle management and bootstrap token rotation, improved self-hosted executor deployment support, and workspace-backed capability and credential icon support across the runtime, backend, CLI, and local MCP tooling.

  It also includes follow-up fixes for executor reassignment behavior, playground execution, credential UI/state handling, and revision environment package linking so remote executors reuse the same installed SDK/runtime package instances.

### Patch Changes

- Updated dependencies [fc5f745]
  - @tokenspace/compiler@0.3.0
  - @tokenspace/backend@0.3.0

## 0.2.2

### Patch Changes

- c19944e: Update dependencies and improve builtin discovery guidance
- Updated dependencies [c19944e]
  - @tokenspace/compiler@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [c1ccfed]
  - @tokenspace/compiler@0.2.1

## 0.2.0

### Minor Changes

- bdb1913: Refactor the CLI around linked tokenspaces instead of explicit workspace subcommands.

  - Replace `tokenspace workspace ...` and `tokenspace watch` with top-level `tokenspace link`, `tokenspace pull`, `tokenspace push`, and `tokenspace compile`.
  - Store linked workspace metadata locally in `.tokenspace/link.json` and use that link for subsequent pull and push operations.
  - Make `tokenspace push` build locally, publish a revision, and print revision playground URLs for the linked tokenspace.
  - Make `tokenspace login` discover auth configuration from the target web app and support `--url` for local or alternate deployments.

### Patch Changes

- @tokenspace/compiler@0.2.0

## 0.1.2

### Patch Changes

- 10ca479: Commit initial git repo after tokenspace initialization

## 0.1.1

### Patch Changes

- 8bb26c2: Fixed tokenspace init
