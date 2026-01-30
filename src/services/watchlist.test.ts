// ABOUTME: Tests for watchlist service.
// ABOUTME: Covers adding, removing, and reordering shows.

import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../lib/db';
import {
  addToWatchlist,
  removeFromWatchlist,
  getWatchlist,
  reorderWatchlist,
  updateWatchlistStatus,
} from './watchlist';
import { cacheShow } from './showCache';

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
});
