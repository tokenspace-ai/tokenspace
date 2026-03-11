#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

SOURCE_REPO="$(cd "$(git rev-parse --git-common-dir)/.." && pwd -P)"

if [ -f "$SOURCE_REPO/.env" ]; then
  echo "Copying .env from source repo: $SOURCE_REPO/.env"
  cp "$SOURCE_REPO/.env" .env
else
  echo "No .env in source repo, copying .env.example"
  cp .env.example .env
fi

bun install
bun dev:setup
bun shuffle-ports
