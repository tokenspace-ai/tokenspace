# Tokenspace CLI

CLI for creating, linking, syncing, and publishing Tokenspace workspaces.

## Installation

```bash
bun add -g tokenspace
```

## Requirements

- Bun `>=1.3.9`

## Authentication

The CLI uses [WorkOS Device Authorization Flow](https://workos.com/blog/cli-auth) for secure authentication. This allows you to authenticate via your browser without storing long-lived credentials.

### Login

```bash
tokenspace login
tokenspace login --url=http://localhost:31337
```

The CLI discovers the active WorkOS client ID and Convex deployment from the selected web app, then remembers that target in `~/.tokenspace/auth.json` for future commands and generated links.

### Check authentication status

```bash
tokenspace whoami
```

### Logout

```bash
tokenspace logout
```

## Usage

### Initialize a workspace

```bash
tokenspace init my-workspace --name "My Workspace"
```

`tokenspace init` now scaffolds the workspace first, then offers to:

- install the `capability-authoring` skill for Claude Code plus standards-compatible agents with `bunx skills add https://github.com/tokenspace-ai/skills --skill capability-authoring --agent claude-code -y`
- run `git init && git add . && git commit -m "init tokenspace"`
- run `bun install`

Use `--yes` to accept all three by default, or control them individually:

```bash
tokenspace init my-workspace --yes
tokenspace init my-workspace --skip-install-skill --skip-git-init --skip-bun-install
tokenspace init my-workspace --install-skill --git-init --bun-install
```

### Link a local workspace

```bash
tokenspace link
tokenspace link my-workspace
tokenspace link --create --name "My Workspace" --slug my-workspace
```

This writes `.tokenspace/link.json` in the current directory and ensures `.tokenspace/` is gitignored.

### Pull workspace files

```bash
tokenspace pull
tokenspace pull --dry-run
```

### Push local files and a revision

```bash
tokenspace push
tokenspace push --dry-run
tokenspace push --open
```

`tokenspace push` syncs local source files to the linked tokenspace's default branch working state, builds `build/tokenspace`, pushes a revision, and prints the revision playground URL.

### Compile locally

```bash
tokenspace compile
tokenspace compile --out-dir build/tokenspace
```

### Chat from the CLI

Start a new chat in the linked workspace:

```bash
tokenspace chat start "Summarize the credential setup"
tokenspace chat start --stdin --follow
tokenspace chat start "Investigate the failing test" --open
```

List recent chats:

```bash
tokenspace chat list
tokenspace chat list --limit 50
tokenspace chat list --all --json
```

Inspect a chat or follow it in the terminal:

```bash
tokenspace chat get <chat-id>
tokenspace chat get <chat-id> --follow
tokenspace chat get <chat-id> --json
tokenspace chat get <chat-id> --follow --ndjson
```

Send another user message to an existing chat:

```bash
tokenspace chat send <chat-id> "Continue from the last result"
tokenspace chat send <chat-id> --stdin --follow
```

These commands require a linked workspace and an existing compiled revision. If the linked tokenspace has not been pushed yet, the CLI will ask you to run `tokenspace push` first.

## Environment

`tokenspace login` is self-configuring. To authenticate against a local web app during development, pass the app URL explicitly:

```bash
tokenspace login --url=http://localhost:31337
```
