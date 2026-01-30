// ABOUTME: Integration tests for watchlist API routes.
// ABOUTME: Tests add and remove operations.

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../index';
import { prisma } from '../../lib/db';

describe('Watchlist API', () => {
  beforeEach(async () => {
    await prisma.scheduledEpisode.deleteMany();
    await prisma.scheduleDay.deleteMany();
    await prisma.watchlistEntry.deleteMany();
    await prisma.show.deleteMany();
  });

  describe('POST /api/watchlist', () => {
    it('adds a show to watchlist', async () => {
      const res = await request(app)
        .post('/api/watchlist')
        .send({ tmdbId: 1396 }); // Breaking Bad

      expect(res.status).toBe(201);

      const entries = await prisma.watchlistEntry.findMany({
        include: { show: true },
      });
      expect(entries.length).toBe(1);
      expect(entries[0].show.title).toBe('Breaking Bad');
    });
  });

  describe('DELETE /api/watchlist/:id', () => {
    it('removes a show from watchlist', async () => {
      // First add a show
      await request(app)
        .post('/api/watchlist')
        .send({ tmdbId: 1396 });

      const entries = await prisma.watchlistEntry.findMany();
      expect(entries.length).toBe(1);

      // Then remove it
      const res = await request(app)
        .delete(`/api/watchlist/${entries[0].id}`);

      expect(res.status).toBe(200);

      const remaining = await prisma.watchlistEntry.findMany();
      expect(remaining.length).toBe(0);
    });
  });
});
