---
name: bash
description: Use Tokenspace's sandboxed bash environment (just-bash) safely and effectively
---

# Bash in Tokenspace (Virtual, Sandboxed)

This project’s `bash` tool runs in a **simulated Bash environment** powered by `just-bash`, mounted over the Tokenspace **revision filesystem**.

## How to Discover Capabilities

- Run `help` to see general help.
- Most commands support `--help` (e.g. `rg --help`, `sed --help`).
- If a command is missing, it’s better to switch approaches (e.g. use TypeScript tools) than to assume host binaries exist.

## What You Can Assume

- The filesystem you care about is mounted at **`/sandbox`**.
- Workspace files are available read-only in the base layer; writes go to a **session-scoped overlay**.
- `bash` tool calls are **isolated**: environment variables, shell functions, and `cwd` do **not** persist between calls (filesystem changes do).
- Many common Unix commands exist (e.g. `ls`, `cat`, `rg`, `grep`, `find`, `sed`, `awk`, `jq`, `diff`, `head`, `tail`, `wc`, `mkdir`, `mv`, `cp`, `rm`).

## What You Cannot Assume

- This is **not** a real machine/VM: there are **no host binaries** (don’t expect `git`, `bun`, `node`, `apt`, etc.).
- **No network by default**: `curl` is typically unavailable unless the platform explicitly enables network access.
- Tool results don’t expose an `exitCode`; **non-zero exits fail the tool call**. If you’re probing, use patterns that keep the final status `0` (see below).

## Paths & Working Directory

- Default working directory is **`/sandbox`**.
- If the bash tool supports a `cwd` parameter, it is typically **relative to `/sandbox`** (e.g. `cwd: "docs"` → `/sandbox/docs`).

Common paths inside `/sandbox`:

- `capabilities/**` — API typings + capability docs
- `docs/**` — workspace docs
- `memory/**` — session memory and artifacts (safe place to write notes)
- `skills/**` — workspace-provided skills
- `system/skills/**` — platform-provided skills (this directory)

## Shell Features You Can Use

`just-bash` supports many core shell features:

- Pipes: `cmd1 | cmd2`
- Redirections: `>`, `>>`, `2>`, `2>&1`, `<`
- Chaining: `&&`, `||`, `;`
- Variables: `$VAR`, `${VAR}`, `${VAR:-default}`
- Globs: `*`, `?`, `[...]`
- Conditionals/loops/functions (for small scripts)

## Safe, Reliable Command Patterns

Prefer small, deterministic commands.

- List + navigate:
  - `ls`
  - `ls -la`
  - `tree -L 3`
- Search code/docs:
  - `rg -n "pattern" .`
  - `rg -n "foo" docs/`
  - `grep -R "pattern" .` (if needed)
- Read files:
  - `sed -n '1,120p' path/to/file`
  - `head -n 50 file`
- Avoid failing the tool call when a command may return non-zero:
  - `rg -n "pattern" file || true`
  - `test -f somefile && echo "exists" || echo "missing"`
  - `if rg -n "x" file; then echo "found"; else echo "not found"; fi`

## When to Use Bash vs. TypeScript

Use `bash` for:
- Inspecting the filesystem quickly (searching, grepping, summarizing files)
- Simple text/data transforms and one-off reports

Use `runCode` (TypeScript) for:
- Calling workspace tools (capabilities) and structured APIs
- Multi-step workflows with state, approvals, and richer error handling
