# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1 – install ALL workspace deps & build
# ---------------------------------------------------------------------------
FROM oven/bun:1.3 AS build

WORKDIR /app

# Copy workspace root manifests & lockfile first (cache-friendly layer)
COPY package.json bun.lock ./

# Copy only the package.json files for workspaces we need so bun can resolve
# the workspace graph. Order doesn't matter – bun reads them all up-front.
COPY services/executor/package.json services/executor/
COPY services/backend/package.json services/backend/
COPY packages/compiler/package.json packages/compiler/
COPY packages/sdk/package.json packages/sdk/
COPY packages/runtime-core/package.json packages/runtime-core/
COPY packages/types/package.json packages/types/
COPY packages/system-content/package.json packages/system-content/
COPY packages/config/package.json packages/config/
COPY packages/session-fs/package.json packages/session-fs/
COPY packages/durable-agents/package.json packages/durable-agents/
COPY packages/convex-local-dev/package.json packages/convex-local-dev/

RUN bun install --frozen-lockfile

# Copy source for packages that need building (dist-based)
COPY packages/types/ packages/types/
COPY packages/system-content/ packages/system-content/
COPY packages/sdk/ packages/sdk/
COPY packages/compiler/ packages/compiler/
COPY packages/runtime-core/ packages/runtime-core/
COPY packages/config/ packages/config/
COPY packages/session-fs/ packages/session-fs/

# Copy backend (needed by session-fs at build time for type imports)
COPY services/backend/ services/backend/

# Build workspace libraries in dependency order
RUN bun --cwd packages/types build \
 && bun --cwd packages/system-content build \
 && bun --cwd packages/sdk build \
 && bun --cwd packages/compiler build \
 && bun --cwd packages/runtime-core build \
 && bun --cwd packages/session-fs build

# Copy remaining source-only packages
COPY packages/durable-agents/ packages/durable-agents/
COPY packages/convex-local-dev/ packages/convex-local-dev/

# Copy and build the executor itself
COPY services/executor/ services/executor/
RUN bun --cwd services/executor build

# ---------------------------------------------------------------------------
# Stage 2 – production image (no devDependencies, no source)
# ---------------------------------------------------------------------------
FROM oven/bun:1.3-slim AS production

WORKDIR /app

# Copy workspace root manifests & lockfile
COPY package.json bun.lock ./

# Copy package.json for every workspace package in the dep tree
COPY services/executor/package.json services/executor/
COPY services/backend/package.json services/backend/
COPY packages/compiler/package.json packages/compiler/
COPY packages/sdk/package.json packages/sdk/
COPY packages/runtime-core/package.json packages/runtime-core/
COPY packages/types/package.json packages/types/
COPY packages/system-content/package.json packages/system-content/
COPY packages/config/package.json packages/config/
COPY packages/session-fs/package.json packages/session-fs/
COPY packages/durable-agents/package.json packages/durable-agents/
COPY packages/convex-local-dev/package.json packages/convex-local-dev/

RUN bun install --frozen-lockfile --production

# Copy built dist artifacts for packages that were compiled
COPY --from=build /app/packages/types/dist/ packages/types/dist/
COPY --from=build /app/packages/system-content/dist/ packages/system-content/dist/
COPY --from=build /app/packages/sdk/dist/ packages/sdk/dist/
COPY --from=build /app/packages/compiler/dist/ packages/compiler/dist/
COPY --from=build /app/packages/runtime-core/dist/ packages/runtime-core/dist/
COPY --from=build /app/packages/session-fs/dist/ packages/session-fs/dist/
COPY --from=build /app/packages/config/ packages/config/

# Copy backend generated files (runtime dependency for api references)
COPY --from=build /app/services/backend/convex/_generated/ services/backend/convex/_generated/

# Copy source for packages that are consumed as TypeScript at runtime
COPY --from=build /app/packages/durable-agents/src/ packages/durable-agents/src/

# Copy the built executor
COPY --from=build /app/services/executor/dist/ services/executor/dist/
COPY --from=build /app/services/executor/package.json services/executor/

ENV NODE_ENV=production

WORKDIR /work

ENTRYPOINT ["bun", "run", "/app/services/executor/dist/main.js"]
