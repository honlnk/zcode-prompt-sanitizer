# syntax=docker/dockerfile:1
#
# Multi-stage build for zcode-prompt-sanitizer.
#
# Stage 1 (builder): compile TypeScript → dist/
# Stage 2 (runtime): copy only dist/ + production deps onto a slim Node image
#
# The proxy binds to 0.0.0.0 inside the container (via ZPS_HOST env) so the
# host can reach it through port mapping. In a container, 127.0.0.1 would
# refer to the container's own loopback and be unreachable from the host.

# ---- Stage 1: build ----
FROM node:22-alpine AS builder

WORKDIR /app

# Install deps first (cached layer).
COPY package.json package-lock.json ./
RUN npm ci

# Copy sources and compile.
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Prune to production deps for the runtime image.
RUN npm ci --omit=dev && npm cache clean --force

# ---- Stage 2: runtime ----
FROM node:22-alpine AS runtime

LABEL org.opencontainers.image.title="zcode-prompt-sanitizer" \
      org.opencontainers.image.description="Local reverse proxy that sanitizes ZCode-injected prompt fragments before they reach third-party API providers." \
      org.opencontainers.image.source="https://github.com/honlnk/zcode-prompt-sanitizer" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Copy compiled output + production node_modules + package metadata.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Mount point for user config so rule edits survive container restarts.
RUN mkdir -p /data
VOLUME /data

# Bind to all interfaces inside the container.
# The host's 127.0.0.1 is reached via `docker run -p 18790:18790`.
ENV ZPS_HOST=0.0.0.0 \
    ZPS_PORT=18790 \
    ZPS_CONFIG=/data/config.yaml

# Drop privileges — no need for root in a pure-Node runtime.
USER node

EXPOSE 18790

# Healthcheck hits the dashboard status endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.ZPS_PORT+'/__zps__/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--config", "/data/config.yaml"]
