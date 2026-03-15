FROM node:20-alpine AS base

WORKDIR /app

# Copy workspace root manifests
COPY package.json package-lock.json ./
COPY packages/cli/package.json ./packages/cli/
COPY packages/api/package.json ./packages/api/

# Install all workspace deps (links packages/cli as @nxtg/faultline)
RUN npm ci --workspace=packages/cli --workspace=packages/api

# Copy source
COPY packages/cli/ ./packages/cli/
COPY packages/api/ ./packages/api/

EXPOSE 3001

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3001

CMD ["node", "--import", "tsx/esm", "packages/api/src/index.ts"]
