// ABOUTME: Tests for the API key authentication middleware.
// ABOUTME: Covers all auth scenarios: key set, key missing, wrong key, no key configured.

import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { apiKeyAuth } from './apiKey';

function createApp(apiKey?: string) {
  if (apiKey) {
    vi.stubEnv('API_KEY', apiKey);
  } else {
    delete process.env.API_KEY;
  }

  const app = express();
  app.use('/api/v1', apiKeyAuth);
  app.get('/api/v1/test', (_req, res) => res.json({ ok: true }));
  app.get('/ping', (_req, res) => res.json({ status: 'ok' }));
  return app;
}

describe('API Key Middleware', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('allows requests when no API_KEY is configured', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/test');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('allows requests with correct X-Api-Key header', async () => {
    const app = createApp('secret123');
    const res = await request(app)
      .get('/api/v1/test')
      .set('X-Api-Key', 'secret123');
    expect(res.status).toBe(200);
  });

  it('rejects requests with wrong X-Api-Key header', async () => {
    const app = createApp('secret123');
    const res = await request(app)
      .get('/api/v1/test')
      .set('X-Api-Key', 'wrongkey');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('rejects requests with no X-Api-Key header when key is configured', async () => {
    const app = createApp('secret123');
    const res = await request(app).get('/api/v1/test');
    expect(res.status).toBe(401);
  });

  it('allows requests with key in query parameter', async () => {
    const app = createApp('secret123');
    const res = await request(app).get('/api/v1/test?apikey=secret123');
    expect(res.status).toBe(200);
  });
});
