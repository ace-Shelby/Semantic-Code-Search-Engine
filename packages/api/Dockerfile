FROM oven/bun:1 AS builder

WORKDIR /app

# Copy root lockfile and workspace package.json files
COPY package.json bun.lock ./
COPY packages/api/package.json ./packages/api/
COPY packages/shared/package.json ./packages/shared/
COPY packages/ingestion/package.json ./packages/ingestion/
COPY packages/frontend/package.json ./packages/frontend/

# Install dependencies for node-gyp (tree-sitter)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Install dependencies (frozen lockfile ensures reproducible builds, ignore scripts to skip tree-sitter C++ compilation)
RUN bun install --frozen-lockfile --ignore-scripts

# Copy source code for the needed workspaces
COPY packages/shared ./packages/shared
COPY packages/ingestion ./packages/ingestion
COPY packages/api ./packages/api

# Build the API (this will output to packages/api/dist)
WORKDIR /app/packages/api
RUN bun run build

# Stage 2: Runner
FROM oven/bun:1-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

# Copy built artifacts and node_modules from builder
# We copy the entire node_modules from the root for workspace symlinks to work correctly
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/api/dist ./packages/api/dist
COPY --from=builder /app/packages/api/package.json ./packages/api/

EXPOSE 3001

WORKDIR /app/packages/api

CMD ["bun", "run", "start"]
