// ABOUTME: Integration tests for watchlist API routes.
// ABOUTME: Tests add, remove, and promote operations.

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../index';
import { prisma } from '../../lib/db';

describe('Watchlist API', () => {
  beforeEach(async () => {
    await prisma.scheduledEpisode.deleteMany();
    await prisma.scheduleDay.deleteMany();
    await prisma.showDayAssignment.deleteMany();
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

  describe('POST /api/watchlist/:id/promote', () => {
    it('promotes a queued show to watching', async () => {
      // First add a show (it will be queued by default)
      const addRes = await request(app)
        .post('/api/watchlist')
        .send({ tmdbId: 1396 });

      expect(addRes.status).toBe(201);

      const entryId = addRes.body.id;

      // Then promote it
      const res = await request(app)
        .post(`/api/watchlist/${entryId}/promote`);

      expect(res.status).toBe(200);

      // Verify status changed
      const entry = await prisma.watchlistEntry.findUnique({
        where: { id: entryId },
      });
      expect(entry?.status).toBe('watching');
    });

    it('returns 400 for non-queued entry', async () => {
      const addRes = await request(app)
        .post('/api/watchlist')
        .send({ tmdbId: 1396 });

      const entryId = addRes.body.id;

      // Promote once
      await request(app).post(`/api/watchlist/${entryId}/promote`);

      // Try to promote again (already watching)
      const res = await request(app)
        .post(`/api/watchlist/${entryId}/promote`);

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/watchlist/:id/finish', () => {
    it('marks show as finished', async () => {
      // Add and promote a show
      const addRes = await request(app)
        .post('/api/watchlist')
        .send({ tmdbId: 1396 });
      const entryId = addRes.body.id;

      await request(app).post(`/api/watchlist/${entryId}/promote`);

      // Finish it
      const res = await request(app)
        .post(`/api/watchlist/${entryId}/finish`);

      expect(res.status).toBe(200);
      expect(res.body.finishedEntry.status).toBe('finished');
    });

    it('returns null promotedEntry (user picks manually)', async () => {
      // Add two shows
      const add1 = await request(app)
        .post('/api/watchlist')
        .send({ tmdbId: 1396 });
      await request(app)
        .post('/api/watchlist')
        .send({ tmdbId: 60059 });

      // Promote first one
      await request(app).post(`/api/watchlist/${add1.body.id}/promote`);

      // Finish it - should NOT auto-promote (user picks manually)
      const res = await request(app)
        .post(`/api/watchlist/${add1.body.id}/finish`);

      expect(res.status).toBe(200);
      expect(res.body.promotedEntry).toBeNull();
    });
  });
});
