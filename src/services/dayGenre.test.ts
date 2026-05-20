// ABOUTME: Tests for the day-genre preference service.
// ABOUTME: Covers CRUD + affinity scoring used by the scheduler.

import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../lib/db';
import {
  getDayGenres,
  getAllDayGenres,
  setDayGenres,
  scoreDayForShow,
} from './dayGenre';

describe('dayGenre service', () => {
  beforeEach(async () => {
    await prisma.dayGenrePreference.deleteMany();
  });

  describe('setDayGenres + getDayGenres', () => {
    it('persists a set of genres for a day', async () => {
      await setDayGenres(2, ['Comedy', 'Family']);
      const result = await getDayGenres(2);
      expect(result.sort()).toEqual(['Comedy', 'Family']);
    });

    it('replaces previous genres on subsequent set', async () => {
      await setDayGenres(2, ['Comedy', 'Family']);
      await setDayGenres(2, ['Drama']);
      const result = await getDayGenres(2);
      expect(result).toEqual(['Drama']);
    });

    it('clears the day when given an empty array', async () => {
      await setDayGenres(2, ['Comedy']);
      await setDayGenres(2, []);
      const result = await getDayGenres(2);
      expect(result).toEqual([]);
    });
  });

  describe('getAllDayGenres', () => {
    it('returns a 7-element array keyed by day-of-week', async () => {
      await setDayGenres(0, ['Drama']);
      await setDayGenres(2, ['Comedy', 'Family']);
      const all = await getAllDayGenres();
      expect(all).toHaveLength(7);
      expect(all[0].sort()).toEqual(['Drama']);
      expect(all[1]).toEqual([]);
      expect(all[2].sort()).toEqual(['Comedy', 'Family']);
    });
  });

  describe('scoreDayForShow', () => {
    it('adds 1000 per overlapping genre', async () => {
      await setDayGenres(2, ['Comedy', 'Family']);
      const score = await scoreDayForShow(2, ['Comedy', 'Family', 'Drama'], 60);
      // 2 overlaps * 1000 + 60 capacity = 2060
      expect(score).toBe(2060);
    });

    it('returns just remaining capacity when no genre overlaps', async () => {
      await setDayGenres(2, ['Drama']);
      const score = await scoreDayForShow(2, ['Comedy'], 75);
      expect(score).toBe(75);
    });

    it('returns just remaining capacity when day has no preferences', async () => {
      const score = await scoreDayForShow(3, ['Comedy', 'Drama'], 45);
      expect(score).toBe(45);
    });
  });
});
