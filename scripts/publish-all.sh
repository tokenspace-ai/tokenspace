#!/bin/bash

set -e

echo Running checks before publishing...

bun install
bun run release:check
bun run release:pack-smoke
echo "LOGIN TO NPM..."
npm login
bun run release:publish
bun run release:executor-image
