// ABOUTME: Prisma client singleton for database access.
// ABOUTME: Ensures single connection instance across the application.

import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

if (!globalForPrisma.prisma) {
  globalForPrisma.prisma = new PrismaClient();

  // Set SQLite busy timeout so concurrent reads don't immediately fail
  globalForPrisma.prisma.$queryRawUnsafe('PRAGMA busy_timeout = 5000;')
    .catch((err: Error) => console.error('Failed to set busy_timeout:', err));

  // Use WAL mode for better concurrent read/write performance
  globalForPrisma.prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL;')
    .catch((err: Error) => console.error('Failed to set WAL mode:', err));

  // Safe with WAL mode, better write performance on NAS filesystems
  globalForPrisma.prisma.$queryRawUnsafe('PRAGMA synchronous = NORMAL;')
    .catch((err: Error) => console.error('Failed to set synchronous mode:', err));
}

export const prisma = globalForPrisma.prisma;
