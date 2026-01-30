# ABOUTME: Dockerfile for Couch Commander - builds and runs the TV scheduler app.
# ABOUTME: Uses multi-stage build to keep the final image small.

FROM node:22-slim AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build
RUN npm run css:build

# Generate Prisma client
RUN npx prisma generate

FROM node:22-slim

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
COPY --from=builder /app/src/views ./src/views

# Create data directory for SQLite
RUN mkdir -p /data

ENV NODE_ENV=production
ENV DATABASE_URL=file:/data/couch-commander.db
ENV PORT=5055

EXPOSE 5055

# Run migrations and start
CMD ["sh", "-c", "npx prisma db push --skip-generate && node dist/index.js"]
