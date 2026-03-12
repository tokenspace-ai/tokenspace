---
"@tokenspace/sdk": patch
"@tokenspace/runtime-core": patch
"@tokenspace/compiler": patch
---

Add SDK access to the execution session filesystem with `getSessionFilesystem()`, and ensure runtime executions share the same filesystem facade between capability code and builtin `fs`.

Also harden the declaration compiler host to handle environments where `ts.sys` is unavailable.
