# Contributing to Tokenspace

## Development Setup

1. Install Bun `>=1.3.9` and Node.js `>=20`.
2. Install dependencies with `bun install`.
3. Copy `.env.example` to `.env` and fill in the required values.
4. Run `bun run dev:setup`.
5. Start the local stack with `bun dev`.

## Checks

Run the relevant checks before opening a pull request:

```bash
bun run check:ci
bun run typecheck
bun run test:unit
bun run test:integration
bun run release:check
```

If you change generated artifacts or codegen inputs, also run:

```bash
bun codegen
```

## Package Release Rules

- Only these packages are published to npm: `tokenspace`, `@tokenspace/sdk`, `@tokenspace/compiler`, `@tokenspace/runtime-core`, `@tokenspace/local-mcp`, `@tokenspace/types`, and `@tokenspace/system-content`.
- Do not make additional workspaces publishable without updating the public package allowlist and release checks together.
- Public package releases are managed with Changesets and move in a fixed version group.

## Changesets

Add a changeset for user-facing changes to any public package:

```bash
bunx changeset
```

Use the smallest accurate bump type. The release workflow will handle versioning and publishing after merge.

## Pull Requests

- Keep changes scoped and explain any release impact.
- Update docs when public behavior, package metadata, or release flow changes.
- Do not commit secrets, machine-local configuration, or generated output unless the repo already tracks it intentionally.
