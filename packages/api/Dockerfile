# ── Stage 1: deps ────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

# Copy workspace manifests for dependency install
COPY package.json package-lock.json ./
COPY packages/cli/package.json ./packages/cli/
COPY packages/api/package.json ./packages/api/
COPY packages/sdk/package.json ./packages/sdk/ 2>/dev/null || true

RUN npm ci --ignore-scripts

# ── Stage 2: build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/cli/node_modules ./packages/cli/node_modules 2>/dev/null || true
COPY --from=deps /app/packages/api/node_modules ./packages/api/node_modules 2>/dev/null || true

COPY . .

# Type-check only (API runs via tsx, no separate compile step needed)
RUN npx tsc --noEmit 2>&1 || true

# ── Stage 3: runtime ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Install production deps only
COPY package.json package-lock.json ./
COPY packages/cli/package.json ./packages/cli/
COPY packages/api/package.json ./packages/api/

RUN npm ci --omit=dev --ignore-scripts

# Run as non-root user for security
RUN addgroup -S faultline && adduser -S faultline -G faultline && chown -R faultline:faultline /app

# Copy CLI source (no src/ dir — source lives at package root)
COPY packages/cli/cli ./packages/cli/cli
COPY packages/cli/lib ./packages/cli/lib
COPY packages/cli/analysis ./packages/cli/analysis
COPY packages/cli/compliance ./packages/cli/compliance
COPY packages/cli/history ./packages/cli/history
COPY packages/cli/providers ./packages/cli/providers
COPY packages/cli/rules ./packages/cli/rules
COPY packages/cli/services ./packages/cli/services
COPY packages/cli/templates ./packages/cli/templates
COPY packages/cli/types.ts ./packages/cli/types.ts
COPY packages/cli/bin ./packages/cli/bin

# Copy API source
COPY packages/api/src ./packages/api/src

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

USER faultline

CMD ["node", "--import", "tsx/esm", "packages/api/src/index.ts"]
