---
"tokenspace": patch
"@tokenspace/sdk": patch
"@tokenspace/compiler": patch
"@tokenspace/runtime-core": patch
"@tokenspace/local-mcp": patch
"@tokenspace/types": patch
"@tokenspace/system-content": patch
"@tokenspace/executor": patch
"@tokenspace/backend": patch
"@tokenspace/session-fs": patch
---

Release a coordinated patch across the public Tokenspace packages.

This update adds CLI chat workflow commands for starting, listing, inspecting, following, and continuing chats, plus default workspace selection with `tokenspace use` and `--workspace` support outside linked workspace directories.

It also improves CLI chat transcript rendering so terminal output follows the same step order as the web UI, with compact role-based styling, simplified tool labels, and machine-readable snapshot and follow formats for automation.
