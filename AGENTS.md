# Tokenspace Project

Tokenspace is a TypeScript-driven agentic automation platform. AI generates and executes TypeScript code to invoke customer-defined tools (integrations with external systems). Workspaces define available tools, guardrails (what AI can do autonomously vs. requiring approval), documentation and skills. Features include serverless execution, reusable workflows/apps, and background execution via webhooks/schedules.

Directory structure:

- apps/web - frontend application (React + TanStack Start)
- services/backend - Convex backend functions and schema
- services/executor - Code execution environment
- packages/sdk - SDK for developing integrations
- packages/compiler - TypeScript compiler to generate type declarations from workspace source code
- packages/durable-agents - Durable Agents library for Convex
- scripts - scripts for the project (CI and dev tooling)
- example - this is an example workspace configuration for dev and testing purposes
- docs - technical documentation for the project

## Commands

- `bun dev:setup`: Setup and configure the project
- `bun dev`: Start dev server. Logs of the different processes are in the `logs/` directory.
- `bun typecheck`: Check TypeScript types across all apps
- `bun fix`: Run Biome formatting and linting
- `bun test:unit`: Run unit tests
- `bun test:integration`: Run integration tests
