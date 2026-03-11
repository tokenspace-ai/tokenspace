# Publishing

This repository publishes a limited set of npm packages from the monorepo. All other workspaces stay `private`.

## Public Packages

The current public package allowlist is:

- `tokenspace`
- `@tokenspace/sdk`
- `@tokenspace/compiler`
- `@tokenspace/runtime-core`
- `@tokenspace/local-mcp`
- `@tokenspace/types`
- `@tokenspace/system-content`

The allowlist is defined in `scripts/lib/public-packages.ts`. `scripts/check-public-packages.ts` enforces that:

- every allowlisted package is publishable
- every non-allowlisted workspace is `private: true`
- every allowlisted package declares Apache-2.0 license metadata plus repository, homepage, and bugs links

## Packaging Requirements

Public packages are published from built `dist/` artifacts. Each public package must include:

- built entrypoints in `dist/`
- `README.md`
- `LICENSE`
- npm metadata that points back to this repository

The release smoke test rejects tarballs that include source files, tests, snapshots, `workspace:*` dependencies, or `catalog:` dependencies.

## Release Commands

Use these commands when working on public package releases:

```bash
bun run build:public-packages
bun run release:check
bun run release:pack-smoke
```

- `release:check` validates package metadata and runs `npm pack --dry-run` checks
- `release:pack-smoke` builds tarballs, installs them into a temp project, and smoke-tests the CLI and library imports

## Versioning

Public packages are versioned with Changesets in one fixed version group. Add a changeset for any user-facing change to a public package:

```bash
bunx changeset
```

After merge, the GitHub release workflow creates or updates a release PR and publishes to npm once that PR is merged.

## Release Workflow

The automated release flow is:

1. Merge a changeset-backed public package change to `main`.
2. GitHub Actions runs `bun run release:check`.
3. `changesets/action` opens or updates the release PR.
4. Merge the release PR.
5. GitHub Actions publishes the packages to npm.

For local verification before merge:

```bash
bun install
bun run release:check
bun run release:pack-smoke
```

Manual local publishing should be rare and only used when intentionally bypassing the GitHub Actions flow.
