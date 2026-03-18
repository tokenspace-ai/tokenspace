# Tokenspace Project

Tokenspace is a TypeScript-driven agentic automation platform. AI generates and executes TypeScript code to invoke customer-defined tools (integrations with external systems). Workspaces define available tools, guardrails (what AI can do autonomously vs. requiring approval), documentation and skills. Features include serverless execution, reusable workflows/apps, and background execution via webhooks/schedules.

## Important instructions

- DO NOT commit with `--no-verify` unless explicitly instructed to do so. Fix format and linter errors by first running `bun fix` and then fixing all linter errors that weren't fixed automatically.

## Commands

- `bun typecheck`: Check TypeScript types across all apps
- `bun fix`: Run Biome formatting and linting
- `bun test:unit`: Run unit tests
- `bun test:integration`: Run integration tests
