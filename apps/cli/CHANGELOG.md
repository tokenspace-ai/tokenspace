# tokenspace

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
