// ABOUTME: End-to-end tests for container hardening features.
// ABOUTME: Tests ping, system status, and graceful shutdown behavior.

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import app from '../index';
import { getScheduleLock, shouldRegenerate, markScheduleStale, markScheduleGenerated } from '../services/scheduler';

describe('Container Hardening', () => {
  describe('GET /ping', () => {
    it('returns ok status with no DB access', async () => {
      const res = await request(app).get('/ping');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });
  });

  describe('Graceful shutdown', () => {
    it('getScheduleLock returns a promise', () => {
      const lock = getScheduleLock();
      expect(lock).toBeInstanceOf(Promise);
    });

    it('getScheduleLock reflects current lock state', async () => {
      const lock = getScheduleLock();
      await expect(lock).resolves.toBeUndefined();
    });
  });

  describe('API v1 routes', () => {
    it('serves v1 system status', async () => {
      const res = await request(app).get('/api/v1/system/status');
      expect(res.status).toBe(200);
      expect(res.body.appName).toBe('Couch Commander');
    });

    it('v1 routes reject requests when API_KEY is set and no key provided', async () => {
      vi.stubEnv('API_KEY', 'test-secret');
      const res = await request(app).get('/api/v1/watchlist/availability');
      expect(res.status).toBe(401);
      vi.unstubAllEnvs();
    });

    it('v1 routes allow requests with correct API key', async () => {
      vi.stubEnv('API_KEY', 'test-secret');
      const res = await request(app)
        .get('/api/v1/watchlist/availability')
        .set('X-Api-Key', 'test-secret');
      expect(res.status).toBe(200);
      vi.unstubAllEnvs();
    });

    it('legacy /api/* routes remain unauthenticated even with API_KEY set', async () => {
      vi.stubEnv('API_KEY', 'test-secret');
      const res = await request(app).get('/api/watchlist/availability');
      expect(res.status).toBe(200);
      vi.unstubAllEnvs();
    });
  });

  describe('Schedule generation guard', () => {
    beforeEach(() => {
      markScheduleStale(); // Reset to startup state before each test
    });

    it('shouldRegenerate returns true when schedule is stale', () => {
      expect(shouldRegenerate(7)).toBe(true);
    });

    it('shouldRegenerate returns false after generation for same window', () => {
      markScheduleGenerated(7);
      expect(shouldRegenerate(7)).toBe(false);
    });

    it('shouldRegenerate returns false for smaller window after larger generation', () => {
      markScheduleGenerated(14);
      expect(shouldRegenerate(7)).toBe(false);
    });

    it('shouldRegenerate returns true when requesting larger window', () => {
      markScheduleGenerated(7);
      expect(shouldRegenerate(14)).toBe(true);
    });

    it('markScheduleStale resets the guard', () => {
      markScheduleGenerated(14);
      expect(shouldRegenerate(7)).toBe(false);
      markScheduleStale();
      expect(shouldRegenerate(7)).toBe(true);
    });
  });
});
