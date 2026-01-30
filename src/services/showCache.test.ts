// ABOUTME: Tests for show caching service.
// ABOUTME: Covers caching TMDB data to local database.

import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../lib/db';
import { cacheShow, getCachedShow } from './showCache';

describe('Show Cache Service', () => {
  beforeEach(async () => {
    // Clean up test data
    await prisma.scheduledEpisode.deleteMany();
    await prisma.scheduleDay.deleteMany();
    await prisma.showDayAssignment.deleteMany();
    await prisma.watchlistEntry.deleteMany();
    await prisma.show.deleteMany();
  });

  it('caches a show from TMDB and returns it', async () => {
    // Breaking Bad
    const show = await cacheShow(1396);

    expect(show).toHaveProperty('id');
    expect(show.tmdbId).toBe(1396);
    expect(show.title).toBe('Breaking Bad');
    expect(show.totalEpisodes).toBeGreaterThan(0);
  });

  it('returns cached show without hitting API on second call', async () => {
    const show1 = await cacheShow(1396);
    const show2 = await getCachedShow(1396);

    expect(show2).not.toBeNull();
    expect(show2?.id).toBe(show1.id);
  });

  it('returns null for uncached show', async () => {
    const show = await getCachedShow(999999);
    expect(show).toBeNull();
  });
});
