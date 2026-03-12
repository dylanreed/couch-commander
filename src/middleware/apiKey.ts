// ABOUTME: API key authentication middleware for Servarr-style API protection.
// ABOUTME: Checks X-Api-Key header or apikey query parameter against API_KEY env var.

import { Request, Response, NextFunction } from 'express';

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const configuredKey = process.env.API_KEY;

  // If no API key is configured, allow all requests
  if (!configuredKey) {
    next();
    return;
  }

  const headerKey = req.headers['x-api-key'] as string | undefined;
  const queryKey = req.query.apikey as string | undefined;
  const providedKey = headerKey || queryKey;

  if (providedKey === configuredKey) {
    next();
    return;
  }

  res.status(401).json({ error: 'Unauthorized' });
}
