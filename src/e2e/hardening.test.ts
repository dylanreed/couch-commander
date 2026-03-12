// ABOUTME: End-to-end tests for container hardening features.
// ABOUTME: Tests ping, system status, and graceful shutdown behavior.

import { describe, it, expect } from 'vitest';
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
