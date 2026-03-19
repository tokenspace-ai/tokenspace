# @tokenspace/executor

Self-hosted executor for Tokenspace. Connects to a Tokenspace backend, registers as an executor instance, and runs AI-generated TypeScript code on behalf of workspaces.

## Quick start

```bash
bunx @tokenspace/executor@latest --api <API_URL> --token <BOOTSTRAP_TOKEN>
```

Create or assign an executor from `Workspace -> Admin -> Execution Environment`, then use the one-time bootstrap token shown in the setup flow.

## Docker

```bash
docker run \
  -e TOKENSPACE_API_URL="<API_URL>" \
  -e TOKENSPACE_TOKEN="<BOOTSTRAP_TOKEN>" \
  ghcr.io/tokenspace-ai/executor:latest
``` 

## Publishing the Docker image

The executor image is published as a multi-arch image for `linux/amd64` and `linux/arm64`.

Maintainers should use the `Publish Executor Image` GitHub Actions workflow as the primary publish path. The local fallback command uses Docker Buildx and verifies that both platforms were published:

```bash
bun run release:executor-image --version 0.2.2 --latest true
```

## CLI options

| Flag | Env var | Description |
|------|---------|-------------|
| `--api <url>` | `TOKENSPACE_API_URL` | Tokenspace API URL |
| `--token <token>` | `TOKENSPACE_TOKEN` | Bootstrap token for this executor |

CLI flags take precedence over environment variables.

## Full setup and troubleshooting

See the executor deployment guide in the docs app:

- [Executor Deployment](../../apps/docs/content/docs/admin/executor-deployment.mdx)

## Development

```bash
bun dev
```

This runs the executor in watch mode using the bootstrap token and API URL from your local `.env`.
