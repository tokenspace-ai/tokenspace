# @tokenspace/executor

Self-hosted executor for Tokenspace. Connects to a Tokenspace backend, registers as an executor instance, and runs AI-generated TypeScript code on behalf of workspaces.

## Quick start

```bash
bunx @tokenspace/executor --api <API_URL> --token <BOOTSTRAP_TOKEN>
```

Both values are provided when you create an executor in the Tokenspace admin UI.

## Docker

```bash
docker run \
  -e TOKENSPACE_API_URL="<API_URL>" \
  -e TOKENSPACE_TOKEN="<BOOTSTRAP_TOKEN>" \
  ghcr.io/tokenspace-ai/executor:latest
``` 

## CLI options

| Flag | Env var | Description |
|------|---------|-------------|
| `--api <url>` | `TOKENSPACE_API_URL` | Tokenspace API URL |
| `--token <token>` | `TOKENSPACE_TOKEN` | Bootstrap token for this executor |

CLI flags take precedence over environment variables.

## Development

```bash
bun dev
```

This runs the executor in watch mode using the bootstrap token and API URL from your local `.env`.
