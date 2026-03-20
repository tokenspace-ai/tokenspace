#!/bin/bash

set -e

echo Running checks before publishing...

bun install
bun run release:check
bun run release:pack-smoke
echo "LOGIN TO NPM..."
npm login
bun run release:publish
EXECUTOR_VERSION="$(node -p "require('./services/executor/package.json').version")"
echo "Triggering 'Publish Executor Image' workflow for version $EXECUTOR_VERSION..."
gh workflow run publish-executor-image.yml \
  -f version="$EXECUTOR_VERSION" \
  -f publish_latest=true
