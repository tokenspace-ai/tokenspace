---
"tokenspace": minor
"@tokenspace/sdk": minor
"@tokenspace/compiler": minor
"@tokenspace/runtime-core": minor
"@tokenspace/local-mcp": minor
"@tokenspace/types": minor
"@tokenspace/system-content": minor
"@tokenspace/executor": minor
"@tokenspace/backend": minor
"@tokenspace/session-fs": minor
---

Release a coordinated `0.3.0` across the public Tokenspace packages.

This release adds remote TypeScript compilation on executors, executor lifecycle management and bootstrap token rotation, improved self-hosted executor deployment support, and workspace-backed capability and credential icon support across the runtime, backend, CLI, and local MCP tooling.

It also includes follow-up fixes for executor reassignment behavior, playground execution, credential UI/state handling, and revision environment package linking so remote executors reuse the same installed SDK/runtime package instances.
