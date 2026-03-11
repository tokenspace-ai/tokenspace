# Tokenspace

Tokenspace is a TypeScript-first platform for building guardrailed AI automations. Workspaces define typed capabilities, credentials, docs, and policies; agents generate and run TypeScript against that controlled surface instead of calling external systems directly.

This repository contains the hosted product code, local development tooling, and the public packages used to author and run Tokenspace workspaces.

## Open Source Scope

This repository is licensed under Apache-2.0.

The public npm surface is intentionally limited to these packages:

- `tokenspace`
- `@tokenspace/sdk`
- `@tokenspace/compiler`
- `@tokenspace/runtime-core`
- `@tokenspace/local-mcp`
- `@tokenspace/types`
- `@tokenspace/system-content`

All other workspaces remain private to the monorepo and are not published to npm.

## Repository Layout

```text
apps/
  cli/         Tokenspace CLI published as `tokenspace`
  docs/        Documentation site
  local-mcp/   Local MCP server published as `@tokenspace/local-mcp`
  web/         Hosted web application
services/
  backend/     Convex backend
  executor/    Code execution service
packages/
  compiler/    Workspace compiler
  sdk/         Capability authoring SDK
  runtime-core Runtime for compiled bundles
  system-content Shared system files
  types/       Type assets
```

## Getting Started

### Prerequisites

- Bun `>=1.3.9`
- Node.js `>=20`
- A local `.env` file based on `.env.example`

### Local Setup

```bash
bun install
cp .env.example .env
bun run dev:setup
bun dev
```

`bun dev` starts the local web app, Convex backend, and executor. Logs are written to `logs/`.

## Common Commands

```bash
bun typecheck
bun test:unit
bun test:integration
bun fix
bun run release:check
```

## Hosted Service Caveats

- The web app and backend expect third-party service configuration such as WorkOS, Convex, and optional email delivery.
- Some CLI flows assume a running Tokenspace web app and default to `https://app.tokenspace.ai`.
- The open-source repo includes the hosted application code, but not every production dependency or deployment secret required to run Tokenspace Cloud.

## Publishing

Release automation for the public packages is documented in [docs/PUBLISHING.md](/Users/sp/dev/tokenspace-ai/tokenspace/docs/PUBLISHING.md).

## Contributing

Contribution guidelines live in [CONTRIBUTING.md](/Users/sp/dev/tokenspace-ai/tokenspace/CONTRIBUTING.md). Security issues should be reported through GitHub private vulnerability reporting as described in [SECURITY.md](/Users/sp/dev/tokenspace-ai/tokenspace/SECURITY.md).
