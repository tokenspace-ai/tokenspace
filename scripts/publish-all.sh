#!/bin/bash

set -e

echo Running checks before publishing...

bun install
bun run release:check
bun run release:pack-smoke
echo "LOGIN TO NPM..."
npm login
bun run release:publish
echo "Executor image publish now runs from GitHub Actions."
echo "Trigger the 'Publish Executor Image' workflow with the package version you want to publish."
