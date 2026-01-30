// ABOUTME: Tests for watchlist service.
// ABOUTME: Covers adding, removing, reordering, and promotion blocking.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { prisma } from '../lib/db';
import {
  addToWatchlist,
  removeFromWatchlist,
  getWatchlist,
  reorderWatchlist,
  updateWatchlistStatus,
  promoteFromQueue,
  finishShow,
  checkQueueAvailability,
} from './watchlist';
import { cacheShow } from './showCache';
import { updateSettings } from './settings';
import * as tmdb from './tmdb';

vi.mock('./tmdb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tmdb')>();
  return {
    ...actual,
    isEpisodeAvailable: vi.fn(),
  };
});

describe('Watchlist Service', () => {
  let testShow: Awaited<ReturnType<typeof cacheShow>>;

  beforeEach(async () => {
    await prisma.scheduledEpisode.deleteMany();
    await prisma.scheduleDay.deleteMany();
    await prisma.showDayAssignment.deleteMany();
    await prisma.watchlistEntry.deleteMany();
    await prisma.show.deleteMany();

    // Cache a test show (Breaking Bad)
    testShow = await cacheShow(1396);
  });

  describe('addToWatchlist', () => {
    it('adds a show to the watchlist', async () => {
      const entry = await addToWatchlist(testShow.id);

      expect(entry.showId).toBe(testShow.id);
      expect(entry.priority).toBe(0);
      expect(entry.startSeason).toBe(1);
      expect(entry.startEpisode).toBe(1);
    });

    it('allows setting custom start position', async () => {
      const entry = await addToWatchlist(testShow.id, {
        startSeason: 2,
        startEpisode: 5,
      });

      expect(entry.startSeason).toBe(2);
      expect(entry.startEpisode).toBe(5);
      expect(entry.currentSeason).toBe(2);
      expect(entry.currentEpisode).toBe(5);
    });
  });

  describe('getWatchlist', () => {
    it('returns empty array when no entries', async () => {
      const list = await getWatchlist();
      expect(list).toEqual([]);
    });

    it('returns entries with show data', async () => {
      await addToWatchlist(testShow.id);

      const list = await getWatchlist();
      expect(list.length).toBe(1);
      expect(list[0].show.title).toBe('Breaking Bad');
    });

    it('returns entries sorted by priority', async () => {
      // Add a second show (Better Call Saul)
      const show2 = await cacheShow(60059);

      await addToWatchlist(testShow.id, { priority: 2 });
      await addToWatchlist(show2.id, { priority: 1 });

      const list = await getWatchlist();
      expect(list[0].showId).toBe(show2.id);
      expect(list[1].showId).toBe(testShow.id);
    });
  });

  describe('removeFromWatchlist', () => {
    it('removes a show from the watchlist', async () => {
      const entry = await addToWatchlist(testShow.id);
      await removeFromWatchlist(entry.id);

      const list = await getWatchlist();
      expect(list).toEqual([]);
    });
  });

  describe('reorderWatchlist', () => {
    it('updates priorities based on new order', async () => {
      const show2 = await cacheShow(60059);

      const entry1 = await addToWatchlist(testShow.id);
      const entry2 = await addToWatchlist(show2.id);

      // Reorder: show2 first, then testShow
      await reorderWatchlist([entry2.id, entry1.id]);

      const list = await getWatchlist();
      expect(list[0].id).toBe(entry2.id);
      expect(list[1].id).toBe(entry1.id);
    });
  });

  describe('watchlist entry status', () => {
    it('creates watchlist entry with queued status by default', async () => {
      const entry = await addToWatchlist(testShow.id);
      expect(entry.status).toBe('queued');
    });

    it('allows updating entry status', async () => {
      const entry = await addToWatchlist(testShow.id);
      const updated = await updateWatchlistStatus(entry.id, 'watching');
      expect(updated.status).toBe('watching');
    });

    it('allows setting status to finished', async () => {
      const entry = await addToWatchlist(testShow.id);
      const updated = await updateWatchlistStatus(entry.id, 'finished');
      expect(updated.status).toBe('finished');
    });

    it('allows setting status to dropped', async () => {
      const entry = await addToWatchlist(testShow.id);
      const updated = await updateWatchlistStatus(entry.id, 'dropped');
      expect(updated.status).toBe('dropped');
    });
  });

  describe('promoteFromQueue', () => {
    it('promotes show from queue to watching and assigns day', async () => {
      await updateSettings({ weekdayMinutes: 120 });

      const entry = await addToWatchlist(testShow.id);
      expect(entry.status).toBe('queued');

      const promoted = await promoteFromQueue(entry.id);

      expect(promoted.status).toBe('watching');
      expect(promoted.dayAssignments.length).toBeGreaterThan(0);
    });

    it('throws error if entry is not queued', async () => {
      const entry = await addToWatchlist(testShow.id);
      await updateWatchlistStatus(entry.id, 'watching');

      await expect(promoteFromQueue(entry.id)).rejects.toThrow('not queued');
    });

    it('throws error when episode not available for Returning Series', async () => {
      await updateSettings({ weekdayMinutes: 120 });

      // Create a returning series show directly
      const returningShow = await prisma.show.create({
        data: {
          tmdbId: 77777,
          title: 'Returning Test Show',
          genres: '["Drama"]',
          totalSeasons: 2,
          totalEpisodes: 20,
          episodeRuntime: 45,
          status: 'Returning Series',
        },
      });

      const entry = await prisma.watchlistEntry.create({
        data: {
          showId: returningShow.id,
          status: 'queued',
          currentSeason: 1,
          currentEpisode: 1,
        },
      });

      vi.mocked(tmdb.isEpisodeAvailable).mockResolvedValueOnce({
        available: false,
        airDate: '2099-12-31',
      });

      await expect(promoteFromQueue(entry.id)).rejects.toThrow(
        'No episodes available yet. Next episode airs 2099-12-31'
      );

      // Cleanup
      await prisma.watchlistEntry.delete({ where: { id: entry.id } });
      await prisma.show.delete({ where: { id: returningShow.id } });
    });

    it('throws error with TBA when no air date known', async () => {
      await updateSettings({ weekdayMinutes: 120 });

      const returningShow = await prisma.show.create({
        data: {
          tmdbId: 77778,
          title: 'TBA Test Show',
          genres: '["Sci-Fi"]',
          totalSeasons: 1,
          totalEpisodes: 10,
          episodeRuntime: 60,
          status: 'Returning Series',
        },
      });

      const entry = await prisma.watchlistEntry.create({
        data: {
          showId: returningShow.id,
          status: 'queued',
          currentSeason: 2,
          currentEpisode: 1,
        },
      });

      vi.mocked(tmdb.isEpisodeAvailable).mockResolvedValueOnce({
        available: false,
        airDate: null,
      });

      await expect(promoteFromQueue(entry.id)).rejects.toThrow(
        'No episodes available yet. Air date TBA'
      );

      // Cleanup
      await prisma.watchlistEntry.delete({ where: { id: entry.id } });
      await prisma.show.delete({ where: { id: returningShow.id } });
    });

    it('succeeds when episode is available for Returning Series', async () => {
      await updateSettings({ weekdayMinutes: 120 });

      const returningShow = await prisma.show.create({
        data: {
          tmdbId: 77779,
          title: 'Available Test Show',
          genres: '["Comedy"]',
          totalSeasons: 3,
          totalEpisodes: 30,
          episodeRuntime: 30,
          status: 'Returning Series',
        },
      });

      const entry = await prisma.watchlistEntry.create({
        data: {
          showId: returningShow.id,
          status: 'queued',
          currentSeason: 1,
          currentEpisode: 5,
        },
      });

      vi.mocked(tmdb.isEpisodeAvailable).mockResolvedValueOnce({
        available: true,
        airDate: '2020-01-01',
      });

      const result = await promoteFromQueue(entry.id);
      expect(result.status).toBe('watching');

      // Cleanup
      await prisma.showDayAssignment.deleteMany({ where: { watchlistEntryId: entry.id } });
      await prisma.watchlistEntry.delete({ where: { id: entry.id } });
      await prisma.show.delete({ where: { id: returningShow.id } });
    });

    it('does not check availability for Ended shows', async () => {
      await updateSettings({ weekdayMinutes: 120 });

      // testShow (Breaking Bad) is "Ended"
      const entry = await addToWatchlist(testShow.id);

      // Spy to verify isEpisodeAvailable is NOT called
      const spy = vi.mocked(tmdb.isEpisodeAvailable);
      spy.mockClear();

      const result = await promoteFromQueue(entry.id);

      expect(result.status).toBe('watching');
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('finishShow', () => {
    it('marks show as finished and removes day assignments', async () => {
      await updateSettings({ weekdayMinutes: 120 });

      const show = await cacheShow(1396);
      const entry = await addToWatchlist(show.id);
      await promoteFromQueue(entry.id);

      const result = await finishShow(entry.id);

      expect(result.finishedEntry.status).toBe('finished');

      // Day assignments should be removed
      const assignments = await prisma.showDayAssignment.findMany({
        where: { watchlistEntryId: entry.id },
      });
      expect(assignments.length).toBe(0);
    });

    it('returns null promotedEntry (user picks manually)', async () => {
      await updateSettings({ weekdayMinutes: 120 });

      // Watching show
      const show1 = await cacheShow(1396);
      const entry1 = await addToWatchlist(show1.id);
      await promoteFromQueue(entry1.id);

      // Queued show
      const show2 = await cacheShow(60059); // Better Call Saul
      await addToWatchlist(show2.id);

      // Finish the first show - should NOT auto-promote
      const result = await finishShow(entry1.id);

      expect(result.finishedEntry.status).toBe('finished');
      expect(result.promotedEntry).toBeNull(); // User picks manually
    });

    it('returns null promotedEntry when queue is empty', async () => {
      await updateSettings({ weekdayMinutes: 120 });

      const show = await cacheShow(1396);
      const entry = await addToWatchlist(show.id);
      await promoteFromQueue(entry.id);

      const result = await finishShow(entry.id);

      expect(result.promotedEntry).toBeNull();
    });
  });
});

describe('checkQueueAvailability', () => {
  let showId: number;
  let entryId: number;

  beforeEach(async () => {
    vi.resetAllMocks();

    await prisma.scheduledEpisode.deleteMany();
    await prisma.scheduleDay.deleteMany();
    await prisma.showDayAssignment.deleteMany();
    await prisma.watchlistEntry.deleteMany();
    await prisma.show.deleteMany();

    const show = await prisma.show.create({
      data: {
        tmdbId: 99996,
        title: 'Returning Test',
        genres: '["Drama"]',
        totalSeasons: 2,
        totalEpisodes: 20,
        episodeRuntime: 45,
        status: 'Returning Series',
      },
    });
    showId = show.id;

    const entry = await prisma.watchlistEntry.create({
      data: {
        showId: show.id,
        status: 'queued',
        currentSeason: 1,
        currentEpisode: 1,
      },
    });
    entryId = entry.id;
  });

  afterEach(async () => {
    await prisma.watchlistEntry.deleteMany({ where: { showId } });
    await prisma.show.deleteMany({ where: { id: showId } });
  });

  it('returns availability status for queued returning shows', async () => {
    vi.mocked(tmdb.isEpisodeAvailable).mockResolvedValueOnce({
      available: false,
      airDate: '2099-06-15',
    });

    const result = await checkQueueAvailability();

    expect(result[entryId]).toEqual({
      available: false,
      airDate: '2099-06-15',
    });
  });

  it('returns available true for ended shows without calling TMDB', async () => {
    // Update show to be "Ended"
    await prisma.show.update({
      where: { id: showId },
      data: { status: 'Ended' },
    });

    const result = await checkQueueAvailability();

    expect(result[entryId]).toEqual({
      available: true,
      airDate: null,
    });
    // TMDB should not have been called
    expect(tmdb.isEpisodeAvailable).not.toHaveBeenCalled();
  });
});
