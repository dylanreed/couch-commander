// ABOUTME: Prisma client singleton for database access.
// ABOUTME: Ensures single connection instance across the application.

import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

if (!globalForPrisma.prisma) {
  globalForPrisma.prisma = new PrismaClient();
}

export const prisma = globalForPrisma.prisma;
