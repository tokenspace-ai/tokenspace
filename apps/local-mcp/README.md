# `@tokenspace/local-mcp`

Run a Tokenspace workspace as a local MCP server over `stdio`.

## Quickstart

```bash
bunx @tokenspace/local-mcp ./my-workspace
```

Or install it globally:

```bash
bun add -g @tokenspace/local-mcp
tokenspace-local-mcp ./my-workspace
```

## Requirements

- Bun `>=1.3.9`
- A local Tokenspace workspace directory

## Usage

```bash
tokenspace-local-mcp ./my-workspace
```

Optional flags:

```text
tokenspace-local-mcp <workspace-dir> \
  [--sessions-root-dir <dir>] \
  [--build-cache-dir <dir>] \
  [--system-dir <dir>]
```

Expected startup logs go to `stderr`:

- `Tokenspace local MCP ready on stdio`
- `Workspace: ...`
- `Fingerprint: ...`
- `Build: fresh-build` or `Build: cache-hit`
- `Startup: ...ms`
- `Session: ...`
- `Sandbox: ...`
- `Bundle: ...`
- `Control: http://127.0.0.1:...`

`stdout` is reserved for MCP JSON-RPC traffic.

## Claude Code

```bash
claude mcp add tokenspace-local-mcp --scope project -- \
  bun $(which tokenspace-local-mcp) ./my-workspace
```

An equivalent `.mcp.json` entry is:

```json
{
  "mcpServers": {
    "tokenspace-local-mcp": {
      "command": "bun",
      "args": [
        "/absolute/path/to/tokenspace-local-mcp",
        "/absolute/path/to/workspace"
      ]
    }
  }
}
```

## Discovery Resources

Clients can inspect these resources immediately after connecting:

- `tokenspace://session/manifest`
  - session metadata, control URL, and build origin
- `tokenspace://workspace/metadata`
  - compiler metadata including capabilities, skills, credentials, and models
- `tokenspace://workspace/token-space-md`
  - raw `TOKENSPACE.md` contents when the workspace defines it
- `tokenspace://approvals/pending`
  - pending approval requests plus approval URLs

## Control UI

The `Control:` startup log points at a localhost dashboard that lets you:

- inspect workspace and session details
- approve or deny pending requests
- set and delete `secret` credentials
- see whether `env` credentials are present for the current process

Notes:

- `secret` credentials use Bun's secret store when available, with a file fallback under `~/.tokenspace/local-mcp/secrets`
- `env` credentials are never stored in the UI; they are read from the local MCP process environment
- `oauth` credentials are listed but still unsupported in local MCP
- declared `session` and `user` secret credentials are intentionally stored as workspace-local values for now

## Troubleshooting

The first run for a workspace fingerprint is a fresh build. Repeated launches of unchanged workspaces should switch to `Build: cache-hit`.

If you want an isolated cache for debugging:

```bash
bunx @tokenspace/local-mcp ./my-workspace --build-cache-dir /tmp/tokenspace-local-mcp-cache
```

### No TOKENSPACE resource

`tokenspace://workspace/token-space-md` is only exposed when the workspace actually has a `TOKENSPACE.md`.
