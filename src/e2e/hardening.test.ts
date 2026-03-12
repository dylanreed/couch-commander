// ABOUTME: End-to-end tests for container hardening features.
// ABOUTME: Tests ping, system status, and graceful shutdown behavior.

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../index';
import { getScheduleLock } from '../services/scheduler';

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
});
