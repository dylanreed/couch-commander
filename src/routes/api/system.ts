// ABOUTME: Servarr-style system status and health check endpoints.
// ABOUTME: Provides app info, version, uptime, and component health checks.

import { Router } from 'express';
import { prisma } from '../../lib/db';
import path from 'path';
import fs from 'fs';

const router = Router();
const startTime = Date.now();

router.get('/status', async (_req, res) => {
  let version = '0.0.0';
  try {
    const pkgPath = path.join(process.cwd(), 'package.json');
    version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
  } catch {
    // Fallback if package.json can't be read
  }

  res.json({
    appName: 'Couch Commander',
    version,
    startupPath: process.cwd(),
    runtimeVersion: process.version,
    databaseType: 'sqlite',
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });
});

router.get('/health', async (_req, res) => {
  const checks: Array<{ source: string; type: string; message: string }> = [];

  // Database check
  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    checks.push({ source: 'database', type: 'ok', message: 'SQLite responding' });
  } catch {
    checks.push({ source: 'database', type: 'error', message: 'SQLite not responding' });
  }

  // TMDB check
  if (process.env.TMDB_API_KEY) {
    checks.push({ source: 'tmdb', type: 'ok', message: 'TMDB_API_KEY configured' });
  } else {
    checks.push({ source: 'tmdb', type: 'warning', message: 'TMDB_API_KEY not configured' });
  }

  const hasError = checks.some((c) => c.type === 'error');
  res.status(hasError ? 503 : 200).json({ checks });
});

export default router;
