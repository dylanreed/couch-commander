// ABOUTME: Supertest coverage for the settings JSON API.
// ABOUTME: Currently covers PUT /api/settings/day-genres.

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../index';
import { prisma } from '../../lib/db';
import { getDayGenres } from '../../services/dayGenre';

describe('Settings API', () => {
  beforeEach(async () => {
    await prisma.dayGenrePreference.deleteMany();
  });

  describe('PUT /api/settings/day-genres', () => {
    it('replaces genres for the given day', async () => {
      const r = await request(app)
        .put('/api/settings/day-genres')
        .send({ dayOfWeek: 2, genres: ['Comedy', 'Family'] });

      expect(r.status).toBe(200);
      const stored = await getDayGenres(2);
      expect(stored.sort()).toEqual(['Comedy', 'Family']);
    });

    it('clears a day when given an empty list', async () => {
      await request(app).put('/api/settings/day-genres').send({ dayOfWeek: 1, genres: ['Drama'] });
      const r = await request(app).put('/api/settings/day-genres').send({ dayOfWeek: 1, genres: [] });
      expect(r.status).toBe(200);
      const stored = await getDayGenres(1);
      expect(stored).toEqual([]);
    });

    it('rejects an invalid dayOfWeek', async () => {
      const r = await request(app)
        .put('/api/settings/day-genres')
        .send({ dayOfWeek: 9, genres: ['Comedy'] });
      expect(r.status).toBe(400);
    });

    it('rejects a non-array genres', async () => {
      const r = await request(app)
        .put('/api/settings/day-genres')
        .send({ dayOfWeek: 0, genres: 'Comedy' });
      expect(r.status).toBe(400);
    });
  });
});
