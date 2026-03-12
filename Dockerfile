# ABOUTME: Dockerfile for Couch Commander - builds and runs the TV scheduler app.
# ABOUTME: Uses multi-stage build to keep the final image small.

FROM node:22-slim AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source
COPY . .

# Generate Prisma client BEFORE TypeScript build (types needed)
RUN npx prisma generate

# Now build
RUN npm run build
RUN npm run css:build

FROM node:22-slim

LABEL org.opencontainers.image.title="Couch Commander"
LABEL org.opencontainers.image.description="TV viewing schedule manager for your *arr stack"
LABEL org.opencontainers.image.url="https://github.com/dylanreed/couch-commander"
LABEL org.opencontainers.image.source="https://github.com/dylanreed/couch-commander"
LABEL org.opencontainers.image.licenses="MIT"

# Install OpenSSL for Prisma
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install production deps only
COPY package*.json ./
RUN npm ci --only=production

# Copy Prisma schema and generate client
COPY prisma ./prisma
RUN npx prisma generate

# Copy built files from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/src/views ./dist/views

# Create data directory for SQLite
RUN mkdir -p /data

ENV NODE_ENV=production
ENV DATABASE_URL="file:/data/couch-commander.db?socket_timeout=30&connection_limit=1"
ENV PORT=4242

EXPOSE 4242

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=15s \
  CMD node -e "require('http').get('http://localhost:4242/ping', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Run migrations and start
CMD ["sh", "-c", "npx prisma db push --skip-generate || { echo 'DB migration failed'; exit 1; } && node dist/index.js"]
