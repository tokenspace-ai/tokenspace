# Tokenspace — Product Requirements

_Last updated: 2026-02-04_

Tokenspace is a TypeScript-driven agentic automation platform: customers define **typed, guardrailed tools** in a workspace, and AI agents generate and execute code to use those tools safely (with approvals when needed).

This document is intentionally concise. Deeper technical docs live in `docs/` (see [References](#references)).

## Problem

Teams want AI agents to investigate and take action across real systems (APIs, infra, SaaS), but:
- Agents need **reliable, typed interfaces** to those systems.
- Execution needs **guardrails** (approvals, policy, roles) to avoid unsafe actions.
- Operators need **observability** (what happened, why, and what changed).

## Target users

- **Workspace authors (admins):** platform/devops/engineering teams who build and maintain integrations and guardrails.
- **Operators (users):** engineers/support/on-call who run investigations and remediation via chat and workflows.

## Product principles

- **Code-first tools:** TypeScript is the source of truth for tool definitions and behavior.
- **Fast feedback:** the agent gets type-level feedback before execution.
- **Capability security:** agent code only accesses what the runtime explicitly provides (no ambient host powers).
- **Human-in-the-loop by default for risky actions:** approvals are first-class and ergonomic.
- **Great DX:** Git-like workflows, local sync, examples-as-tests, and linting.

## Core concepts (current naming)

- **Workspace:** a version-controlled project containing:
  - integration code (`src/capabilities/**`)
  - optional workspace-defined shell commands (`src/commands/**`, proposed)
  - documentation (`docs/`, `CAPABILITY.md`, etc.)
  - memory (`memory/`) and skills (`skills/`)
  - configuration (`TOKENSPACE.md`) and secrets/credentials
- **Revision:** a compiled snapshot of a workspace (bundle + compiled artifacts) used for execution.
- **Sandbox filesystem (compiled workspace FS):** the immutable base filesystem materialized for a revision (types + docs + memory + injected system content). _(Note: this is likely to be renamed to avoid confusion with “runtime sandboxing”.)_
- **Session:** an execution context bound to a revision + a persistent copy-on-write overlay filesystem; contains approvals and artifacts for ongoing work.
- **Thread:** a chat conversation within a session; threads share the session overlay filesystem.
- **Capability (tool):** a workspace integration under `src/capabilities/<name>/` whose exported functions become agent-callable APIs.
- **Approval:** a session-scoped permission matched by `{action, data}` that allows guarded operations to proceed (triggered via `requireApproval()`).

## What Tokenspace provides (MVP direction)

### 1) Typed tool surface area

- Workspace authors write TypeScript functions for integrations (capabilities).
- The compiler produces **global `.d.ts`** for agents (agents don’t see implementation source).
- The runtime executes the corresponding bundled implementation in the executor.

### 2) Guardrails + approvals

- Integration code gates sensitive operations by calling `requireApproval({ action, data, ... })`.
- If not approved, execution fails with an approval-required error; the agent can request approval and retry.
- MVP access control: workspace roles are `admin` and `user`; admins can modify workspace contents, users run against compiled revisions.
- Planned enhancements: in-chat approval prompts, routing rules, single-use approvals, and AI pre-approval.

### 3) Sandboxed execution

- `runCode`: executes agent-generated TypeScript/JavaScript in a restricted environment with a controlled set of globals and timeouts.
- `bash`: executes in `just-bash` on a virtual filesystem (no host binaries).
- Hardening roadmap: isolate-based sandboxing is desirable, but not the immediate focus.

### 4) Session filesystem + artifacts

- Sessions provide a persistent virtual filesystem for state, scratch work, and outputs.
- Large outputs should be stored as blobs and referenced by path to keep tool responses small.
- Planned UX: file upload/download, better truncation handling, and CLI access to the session filesystem.

### 5) Developer workflow

- Workspaces are edited like code projects (branch/working state), synced locally via CLI.
- Planned: linter and “examples-as-tests” framework for capabilities/commands so authors can validate behavior and generate high-quality examples for agents.
