# Tokenspace Project

Tokenspace is a TypeScript-driven agentic automation platform. AI generates and executes TypeScript code to invoke customer-defined tools (integrations with external systems). Workspaces define available tools, guardrails (what AI can do autonomously vs. requiring approval), and documentation. Features include serverless execution, reusable workflows/apps, and background execution via webhooks/schedules.

Directory structure:

- apps/web - frontend application (React + TanStack Start)
- services/backend - Convex backend functions and schema
- services/executor - Code execution environment
- packages/sdk - SDK for developing integrations
- packages/compiler - TypeScript compiler to generate type declarations from workspace source code
- packages/types - TypeScript type definitions for the project
- packages/durable-agents - Durable Agents library for Convex
- packages/config - Shared config files (tsconfig, etc.)
- scripts - scripts for the project (CI and dev tooling)
- example - this is an example workspace configuration, it'll contain code that defines the tools and documents that will be compiled to determine what the agent will be able to do
- docs - technical documentation for the project

## Dev Server

You can start the dev server by running `bun dev`. It will tell you if it's already running.
You can access logs of the various services in the logs/ directory:
- webapp.log - Vite output
- convex.log - Convex output
- executor.log - Executor output
- browser.log - Browser console output

## Plan Mode

- Make the plan extremely concise. Sacrifice grammar for the sake of concision.
- At the end of each plan, give me a list of unresolved questions to answer, if any.
