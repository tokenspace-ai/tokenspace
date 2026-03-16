# syntax=docker/dockerfile:1
FROM oven/bun:1.3

ARG EXECUTOR_VERSION
RUN test -n "$EXECUTOR_VERSION" || (echo "EXECUTOR_VERSION build arg is required" && exit 1)
RUN bun install -g @tokenspace/executor@${EXECUTOR_VERSION}
ENV NODE_ENV=production
WORKDIR /app

ENTRYPOINT ["tokenspace-executor"]
