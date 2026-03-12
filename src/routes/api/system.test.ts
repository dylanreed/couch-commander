// ABOUTME: Tests for the system status and health API endpoints.
// ABOUTME: Covers Servarr-style system/status and health check responses.

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../../index';

describe('System API', () => {
  describe('GET /api/v1/system/status', () => {
    it('returns app info with version and uptime', async () => {
      const res = await request(app).get('/api/v1/system/status');
      expect(res.status).toBe(200);
      expect(res.body.appName).toBe('Couch Commander');
      expect(res.body.version).toBeDefined();
      expect(res.body.databaseType).toBe('sqlite');
      expect(typeof res.body.uptime).toBe('number');
    });
  });

  describe('GET /api/v1/health', () => {
    it('returns health check array', async () => {
      const res = await request(app).get('/api/v1/health');
      expect(res.status).toBe(200);
      expect(res.body.checks).toBeInstanceOf(Array);
      expect(res.body.checks.length).toBeGreaterThan(0);

      const dbCheck = res.body.checks.find((c: any) => c.source === 'database');
      expect(dbCheck).toBeDefined();
      expect(dbCheck.type).toBe('ok');
    });
  });
});
