---
name: bash
description: Use Tokenspace's local MCP bash environment safely and effectively
---

# Bash in Local MCP

This workspace runs `bash` through `just-bash` against the session sandbox materialized on disk for the current local MCP process.

- The filesystem you care about is mounted at `/sandbox`.
- Reads and writes operate on the session sandbox, not your host filesystem.
- Files persist across tool calls for as long as the local MCP process keeps using the same session.
- `readFile` and `writeFile` should be treated as virtual sandbox tools, not host filesystem tools.
