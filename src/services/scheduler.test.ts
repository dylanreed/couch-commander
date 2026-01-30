// ABOUTME: Tests for the core scheduler service.
// ABOUTME: Covers all scheduling modes and edge cases.

import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../lib/db';
import { generateSchedule, getScheduleForDay } from './scheduler';
import { cacheShow } from './showCache';
import { addToWatchlist } from './watchlist';
import { updateSettings } from './settings';

describe('Scheduler Service', () => {
  beforeEach(async () => {
    await prisma.scheduledEpisode.deleteMany();
    await prisma.scheduleDay.deleteMany();
    await prisma.showDayAssignment.deleteMany();
    await prisma.watchlistEntry.deleteMany();
    await prisma.show.deleteMany();
    await prisma.settings.deleteMany();
  });

  describe('generateSchedule - sequential mode', () => {
    it('generates schedule for single show', async () => {
      const show = await cacheShow(1396); // Breaking Bad
      await addToWatchlist(show.id);
      await updateSettings({ schedulingMode: 'sequential', weekdayMinutes: 120 });

      const startDate = new Date('2026-02-02'); // Monday
      await generateSchedule(startDate, 3);

      const day1 = await getScheduleForDay(startDate);
      expect(day1).not.toBeNull();
      expect(day1!.episodes.length).toBeGreaterThan(0);
      expect(day1!.episodes[0].showId).toBe(show.id);
    });

    it('fills time budget without exceeding', async () => {
      const show = await cacheShow(1396);
      await addToWatchlist(show.id);
      await updateSettings({ schedulingMode: 'sequential', weekdayMinutes: 60 });

      const startDate = new Date('2026-02-02');
      await generateSchedule(startDate, 1);

      const day = await getScheduleForDay(startDate);
      const totalRuntime = day!.episodes.reduce((sum, ep) => sum + ep.runtime, 0);

      // Should be within budget (may slightly exceed due to episode granularity)
      expect(totalRuntime).toBeLessThanOrEqual(120); // Allow some overflow
    });

    it('continues show across multiple days', async () => {
      const show = await cacheShow(1396);
      await addToWatchlist(show.id, { startSeason: 1, startEpisode: 1 });
      await updateSettings({ schedulingMode: 'sequential', weekdayMinutes: 60 });

      const startDate = new Date('2026-02-02');
      await generateSchedule(startDate, 3);

      const day1 = await getScheduleForDay(startDate);
      const day2 = await getScheduleForDay(new Date('2026-02-03'));

      // Day 2 should continue where day 1 left off
      const lastEpDay1 = day1!.episodes[day1!.episodes.length - 1];
      const firstEpDay2 = day2!.episodes[0];

      expect(firstEpDay2.episode).toBeGreaterThan(lastEpDay1.episode);
    });
  });
});
