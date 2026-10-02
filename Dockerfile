# ── Stage 1: Build ─────────────────────────────────────────────────────────────
#
# Installs all deps (including devDeps) and transpiles TypeScript via tsx.
# tsx is a zero-config ts-node replacement that handles ESM natively in Node 20+.
#
FROM node:20-alpine AS builder

WORKDIR /build

# Copy manifests first for layer caching
COPY package.json package-lock.json ./
COPY packages/api/package.json ./packages/api/
COPY packages/cli/package.json ./packages/cli/

# Install all workspace deps (including devDeps for tsx)
RUN npm ci --ignore-scripts

# Copy source
COPY packages/ ./packages/

# Verify TypeScript compiles (non-blocking for runtime, but catches errors early)
# tsx does not require a build step — we use it directly in the runtime stage.
# We still run a type-check here to catch issues during image build.
RUN cd packages/api && npx tsc --noEmit --skipLibCheck 2>/dev/null || true


# ── Stage 2: Runtime ───────────────────────────────────────────────────────────
#
# Slimmer image — only production deps + the tsx runner.
# tsx is kept in runtime because we run TypeScript source directly
# (no separate compile step keeps the image minimal and avoids stale JS).
#
FROM node:20-alpine AS runtime

WORKDIR /app

# Create a non-root user for security
RUN addgroup -S faultline && adduser -S faultline -G faultline

# Copy manifests and install production deps only
COPY package.json package-lock.json ./
COPY packages/api/package.json ./packages/api/
COPY packages/cli/package.json ./packages/cli/

RUN npm ci --omit=dev --ignore-scripts && \
    # Re-install tsx (devDep, needed at runtime since we run TS source directly)
    npm install --ignore-scripts tsx@^4.21.0

# Copy source from builder (no node_modules — already installed above)
COPY --from=builder /build/packages ./packages

# Healthcheck — polls the /health endpoint every 30s, fails after 3 misses
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3001}/health || exit 1

# Ledger directory for the append-only provider-spend, grounding-prompt and
# scan-cost logs. /var/log is root-owned, so without this the non-root process
# cannot create it and every ledger write fails (N-230 instrument:
# GET /usage -> ledgerWriteFailures).
# On Fly this path is the `faultline_ledgers` volume (packages/api/fly.toml), which
# mounts root-owned over this chown; docker-entrypoint.sh fixes the owner at start.
RUN apk add --no-cache su-exec && \
    mkdir -p /var/log/faultline && chown faultline:faultline /var/log/faultline
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# No USER line: the entrypoint starts as root, chowns the ledger directory, then
# drops to the faultline user with su-exec before the app starts.

# The commit this image was built from, echoed by GET /health as `commit`
# (fly-deploy.yml passes --build-arg FAULTLINE_GIT_SHA=<sha>). Empty means unknown.
ARG FAULTLINE_GIT_SHA=""
ENV FAULTLINE_GIT_SHA=${FAULTLINE_GIT_SHA}

# Expose default port (override with PORT env var)
EXPOSE 3001

# Environment defaults (all overridable at run time)
ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0 \
    FAULTLINE_PROVIDER=mock

# Entry point — run the TypeScript source directly via tsx
# Semgrep wants a USER line; by design there is none (see above): the entrypoint
# chowns the Fly volume as root, then execs the app as faultline via su-exec.
# nosemgrep: dockerfile.security.missing-user-entrypoint.missing-user-entrypoint
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh", "node_modules/.bin/tsx", "packages/api/src/index.ts"]
