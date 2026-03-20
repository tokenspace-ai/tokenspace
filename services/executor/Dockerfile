# syntax=docker/dockerfile:1
FROM oven/bun:1.3

ARG EXECUTOR_VERSION
ARG VCS_REF
ARG BUILD_DATE

LABEL org.opencontainers.image.source="https://github.com/tokenspace-ai/tokenspace" \
      org.opencontainers.image.title="Tokenspace Executor" \
      org.opencontainers.image.description="Self-hosted executor for Tokenspace" \
      org.opencontainers.image.url="https://github.com/tokenspace-ai/tokenspace" \
      org.opencontainers.image.documentation="https://github.com/tokenspace-ai/tokenspace/tree/main/services/executor#readme" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${EXECUTOR_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}"

RUN test -n "$EXECUTOR_VERSION" || (echo "EXECUTOR_VERSION build arg is required" && exit 1)
RUN bun install -g @tokenspace/executor@${EXECUTOR_VERSION}
ENV NODE_ENV=production
WORKDIR /app

ENTRYPOINT ["tokenspace-executor"]
