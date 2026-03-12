// ABOUTME: Tests for the core scheduler service.
// ABOUTME: Covers all scheduling modes and edge cases.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../lib/db';
import { generateSchedule, getScheduleForDay } from './scheduler';
import { cacheShow } from './showCache';
import { addToWatchlist, promoteFromQueue } from './watchlist';
import { updateSettings } from './settings';
import { assignShowToDay } from './dayAssignment';
import * as tmdb from './tmdb';

// Helper to create a local date (avoids UTC parsing issues)
function localDate(year: number, month: number, day: number): Date {
  const d = new Date(year, month - 1, day); // month is 0-indexed
  d.setHours(0, 0, 0, 0);
  return d;
}

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
      const entry = await addToWatchlist(show.id);
      await promoteFromQueue(entry.id);
      // Assign to Monday (day 1) - the day we're generating
      await prisma.showDayAssignment.deleteMany({ where: { watchlistEntryId: entry.id } });
      await assignShowToDay(entry.id, 1); // Monday
      await updateSettings({ schedulingMode: 'sequential', weekdayMinutes: 120 });

      const startDate = localDate(2026, 2, 2); // Feb 2, 2026 = Monday
      await generateSchedule(startDate, 1);

      const day1 = await getScheduleForDay(startDate);
      expect(day1).not.toBeNull();
      expect(day1!.episodes.length).toBeGreaterThan(0);
      expect(day1!.episodes[0].showId).toBe(show.id);
    });

    it('fills time budget without exceeding', async () => {
      const show = await cacheShow(1396);
      const entry = await addToWatchlist(show.id);
      await promoteFromQueue(entry.id);
      await prisma.showDayAssignment.deleteMany({ where: { watchlistEntryId: entry.id } });
      await assignShowToDay(entry.id, 1); // Monday
      await updateSettings({ schedulingMode: 'sequential', weekdayMinutes: 60 });

      const startDate = localDate(2026, 2, 2); // Feb 2, 2026 = Monday
      await generateSchedule(startDate, 1);

      const day = await getScheduleForDay(startDate);
      const totalRuntime = day!.episodes.reduce((sum, ep) => sum + ep.runtime, 0);

      // Should be within budget
      expect(totalRuntime).toBeLessThanOrEqual(60);
    });

    it('continues show across multiple days when assigned to both', async () => {
      const show = await cacheShow(1396);
      const entry = await addToWatchlist(show.id, { startSeason: 1, startEpisode: 1 });
      await promoteFromQueue(entry.id);
      await prisma.showDayAssignment.deleteMany({ where: { watchlistEntryId: entry.id } });
      // Assign to both Monday and Tuesday
      await assignShowToDay(entry.id, 1); // Monday
      await assignShowToDay(entry.id, 2); // Tuesday
      await updateSettings({ schedulingMode: 'sequential', weekdayMinutes: 60 });

      const startDate = localDate(2026, 2, 2); // Feb 2, 2026 = Monday
      await generateSchedule(startDate, 2);

      const day1 = await getScheduleForDay(startDate);
      const tuesday = localDate(2026, 2, 3); // Feb 3, 2026 = Tuesday
      const day2 = await getScheduleForDay(tuesday);

      // Day 2 should continue where day 1 left off
      expect(day1!.episodes.length).toBeGreaterThan(0);
      expect(day2!.episodes.length).toBeGreaterThan(0);
      const lastEpDay1 = day1!.episodes[day1!.episodes.length - 1];
      const firstEpDay2 = day2!.episodes[0];

      expect(firstEpDay2.episode).toBeGreaterThan(lastEpDay1.episode);
    });
  });

  describe('generateSchedule - day-based assignments', () => {
    it('generates schedule based on day assignments only', async () => {
      await updateSettings({ weekdayMinutes: 120 });

      // Show 1 - promote to watching (auto-assigns to a day)
      const show1 = await cacheShow(1396); // Breaking Bad
      const entry1 = await addToWatchlist(show1.id);
      await promoteFromQueue(entry1.id);

      // Clear auto-assignment and manually assign to Monday only
      await prisma.showDayAssignment.deleteMany({ where: { watchlistEntryId: entry1.id } });
      await assignShowToDay(entry1.id, 1); // Monday only

      // Show 2 - promote and assign to Tuesday only
      const show2 = await cacheShow(60059); // Better Call Saul
      const entry2 = await addToWatchlist(show2.id);
      await promoteFromQueue(entry2.id);
      await prisma.showDayAssignment.deleteMany({ where: { watchlistEntryId: entry2.id } });
      await assignShowToDay(entry2.id, 2); // Tuesday only

      // Generate for Monday (Feb 2, 2026 is a Monday)
      const monday = localDate(2026, 2, 2);
      await generateSchedule(monday, 1);

      const mondaySchedule = await getScheduleForDay(monday);

      // Monday should only have show1 episodes (Breaking Bad)
      expect(mondaySchedule).not.toBeNull();
      const showIds = new Set(mondaySchedule!.episodes.map((ep) => ep.showId));
      expect(showIds.has(show1.id)).toBe(true);
      expect(showIds.has(show2.id)).toBe(false); // Show2 is Tuesday only
    });

    it('generates schedule for multiple days with correct assignments', async () => {
      await updateSettings({ weekdayMinutes: 120 });

      // Show 1 - assign to Monday
      const show1 = await cacheShow(1396); // Breaking Bad
      const entry1 = await addToWatchlist(show1.id);
      await promoteFromQueue(entry1.id);
      await prisma.showDayAssignment.deleteMany({ where: { watchlistEntryId: entry1.id } });
      await assignShowToDay(entry1.id, 1); // Monday only

      // Show 2 - assign to Tuesday
      const show2 = await cacheShow(60059); // Better Call Saul
      const entry2 = await addToWatchlist(show2.id);
      await promoteFromQueue(entry2.id);
      await prisma.showDayAssignment.deleteMany({ where: { watchlistEntryId: entry2.id } });
      await assignShowToDay(entry2.id, 2); // Tuesday only

      // Generate for Monday and Tuesday
      const monday = localDate(2026, 2, 2);
      await generateSchedule(monday, 2);

      const mondaySchedule = await getScheduleForDay(monday);
      const tuesday = localDate(2026, 2, 3);
      const tuesdaySchedule = await getScheduleForDay(tuesday);

      // Monday should only have show1
      const mondayShowIds = new Set(mondaySchedule!.episodes.map((ep) => ep.showId));
      expect(mondayShowIds.has(show1.id)).toBe(true);
      expect(mondayShowIds.has(show2.id)).toBe(false);

      // Tuesday should only have show2
      const tuesdayShowIds = new Set(tuesdaySchedule!.episodes.map((ep) => ep.showId));
      expect(tuesdayShowIds.has(show2.id)).toBe(true);
      expect(tuesdayShowIds.has(show1.id)).toBe(false);
    });

    it('handles show assigned to multiple days', async () => {
      await updateSettings({ weekdayMinutes: 120 });

      // Show 1 - assign to both Monday and Tuesday
      const show1 = await cacheShow(1396); // Breaking Bad
      const entry1 = await addToWatchlist(show1.id);
      await promoteFromQueue(entry1.id);
      await prisma.showDayAssignment.deleteMany({ where: { watchlistEntryId: entry1.id } });
      await assignShowToDay(entry1.id, 1); // Monday
      await assignShowToDay(entry1.id, 2); // Tuesday

      // Generate for Monday and Tuesday
      const monday = localDate(2026, 2, 2);
      await generateSchedule(monday, 2);

      const mondaySchedule = await getScheduleForDay(monday);
      const tuesday = localDate(2026, 2, 3);
      const tuesdaySchedule = await getScheduleForDay(tuesday);

      // Both days should have show1
      expect(mondaySchedule!.episodes.length).toBeGreaterThan(0);
      expect(tuesdaySchedule!.episodes.length).toBeGreaterThan(0);
      expect(mondaySchedule!.episodes[0].showId).toBe(show1.id);
      expect(tuesdaySchedule!.episodes[0].showId).toBe(show1.id);
    });

    it('skips days with no assigned shows', async () => {
      await updateSettings({ weekdayMinutes: 120 });

      // Show 1 - assign to Monday only
      const show1 = await cacheShow(1396); // Breaking Bad
      const entry1 = await addToWatchlist(show1.id);
      await promoteFromQueue(entry1.id);
      await prisma.showDayAssignment.deleteMany({ where: { watchlistEntryId: entry1.id } });
      await assignShowToDay(entry1.id, 1); // Monday only

      // Generate for Tuesday (no shows assigned)
      const tuesday = localDate(2026, 2, 3);
      await generateSchedule(tuesday, 1);

      const tuesdaySchedule = await getScheduleForDay(tuesday);

      // Tuesday should have schedule day but no episodes
      expect(tuesdaySchedule).not.toBeNull();
      expect(tuesdaySchedule!.episodes.length).toBe(0);
    });

    it('only includes shows with watching status', async () => {
      await updateSettings({ weekdayMinutes: 120 });

      // Show 1 - watching, assigned to Monday
      const show1 = await cacheShow(1396); // Breaking Bad
      const entry1 = await addToWatchlist(show1.id);
      await promoteFromQueue(entry1.id);
      await prisma.showDayAssignment.deleteMany({ where: { watchlistEntryId: entry1.id } });
      await assignShowToDay(entry1.id, 1); // Monday

      // Show 2 - queued (not watching), but we'll manually add an assignment
      const show2 = await cacheShow(60059); // Better Call Saul
      const entry2 = await addToWatchlist(show2.id);
      // Don't promote - stays queued
      await assignShowToDay(entry2.id, 1); // Monday - but should be ignored

      // Generate for Monday
      const monday = localDate(2026, 2, 2);
      await generateSchedule(monday, 1);

      const mondaySchedule = await getScheduleForDay(monday);

      // Only watching show should appear
      const showIds = new Set(mondaySchedule!.episodes.map((ep) => ep.showId));
      expect(showIds.has(show1.id)).toBe(true);
      expect(showIds.has(show2.id)).toBe(false); // Queued, not watching
    });
  });

  describe('generateSchedule - roundrobin mode', () => {
    it('alternates episodes between shows across multiple passes', async () => {
      await updateSettings({ schedulingMode: 'roundrobin', weekdayMinutes: 120 });

      // Two short shows (22 min each) — 120 min budget fits ~5 episodes
      const show1 = await prisma.show.create({
        data: {
          tmdbId: 99901,
          title: 'RR Show A',
          genres: '["Comedy"]',
          totalSeasons: 1,
          totalEpisodes: 10,
          episodeRuntime: 22,
          status: 'Ended',
        },
      });
      const show2 = await prisma.show.create({
        data: {
          tmdbId: 99902,
          title: 'RR Show B',
          genres: '["Drama"]',
          totalSeasons: 1,
          totalEpisodes: 10,
          episodeRuntime: 22,
          status: 'Ended',
        },
      });

      const entry1 = await prisma.watchlistEntry.create({
        data: { showId: show1.id, status: 'watching', currentSeason: 1, currentEpisode: 1 },
      });
      const entry2 = await prisma.watchlistEntry.create({
        data: { showId: show2.id, status: 'watching', currentSeason: 1, currentEpisode: 1 },
      });

      await assignShowToDay(entry1.id, 1); // Monday
      await assignShowToDay(entry2.id, 1); // Monday

      const monday = localDate(2026, 2, 2);
      await generateSchedule(monday, 1);

      const schedule = await getScheduleForDay(monday);
      expect(schedule).not.toBeNull();

      // Should have more than 2 episodes (multiple passes)
      expect(schedule!.episodes.length).toBeGreaterThan(2);

      // Episodes should alternate: A, B, A, B, ...
      for (let i = 1; i < schedule!.episodes.length; i++) {
        expect(schedule!.episodes[i].showId).not.toBe(schedule!.episodes[i - 1].showId);
      }
    });

    it('handles one show running out of episodes before the other', async () => {
      await updateSettings({ schedulingMode: 'roundrobin', weekdayMinutes: 120 });

      // Show with only 2 episodes
      const shortShow = await prisma.show.create({
        data: {
          tmdbId: 99903,
          title: 'RR Short Show',
          genres: '["Comedy"]',
          totalSeasons: 1,
          totalEpisodes: 2,
          episodeRuntime: 22,
          status: 'Ended',
        },
      });
      // Show with many episodes
      const longShow = await prisma.show.create({
        data: {
          tmdbId: 99904,
          title: 'RR Long Show',
          genres: '["Drama"]',
          totalSeasons: 1,
          totalEpisodes: 10,
          episodeRuntime: 22,
          status: 'Ended',
        },
      });

      const entry1 = await prisma.watchlistEntry.create({
        data: { showId: shortShow.id, status: 'watching', currentSeason: 1, currentEpisode: 1 },
      });
      const entry2 = await prisma.watchlistEntry.create({
        data: { showId: longShow.id, status: 'watching', currentSeason: 1, currentEpisode: 1 },
      });

      await assignShowToDay(entry1.id, 1);
      await assignShowToDay(entry2.id, 1);

      const monday = localDate(2026, 2, 2);
      await generateSchedule(monday, 1);

      const schedule = await getScheduleForDay(monday);
      expect(schedule).not.toBeNull();

      // Short show should have at most 2 episodes
      const shortEps = schedule!.episodes.filter((ep) => ep.showId === shortShow.id);
      const longEps = schedule!.episodes.filter((ep) => ep.showId === longShow.id);
      expect(shortEps.length).toBeLessThanOrEqual(2);
      // Long show should have more episodes than short show
      expect(longEps.length).toBeGreaterThan(shortEps.length);
    });
  });

  describe('generateSchedule - episode availability', () => {
    beforeEach(() => {
      vi.resetAllMocks();
    });

    it('skips shows with unavailable episodes for returning series', async () => {
      await updateSettings({ weekdayMinutes: 120 });

      // Create a returning series show directly in db
      const show = await prisma.show.create({
        data: {
          tmdbId: 88888,
          title: 'Unavailable Show',
          genres: '["Drama"]',
          totalSeasons: 2,
          totalEpisodes: 20,
          episodeRuntime: 30,
          status: 'Returning Series',
        },
      });

      const entry = await prisma.watchlistEntry.create({
        data: {
          showId: show.id,
          status: 'watching',
          currentSeason: 2,
          currentEpisode: 5,
        },
      });

      // Assign to Monday
      await assignShowToDay(entry.id, 1);

      // Mock isEpisodeAvailable to return unavailable
      vi.spyOn(tmdb, 'isEpisodeAvailable').mockResolvedValue({
        available: false,
        airDate: '2099-12-31',
      });

      const monday = localDate(2026, 2, 2);
      await generateSchedule(monday, 1);

      const mondaySchedule = await getScheduleForDay(monday);

      // No episodes should be scheduled for this show
      const scheduledForShow = mondaySchedule!.episodes.filter(
        (ep) => ep.showId === show.id
      );
      expect(scheduledForShow.length).toBe(0);
    });

    it('includes ended shows without checking availability', async () => {
      await updateSettings({ weekdayMinutes: 120 });

      // Create an ended show directly in db
      const show = await prisma.show.create({
        data: {
          tmdbId: 88889,
          title: 'Ended Show',
          genres: '["Comedy"]',
          totalSeasons: 3,
          totalEpisodes: 60,
          episodeRuntime: 22,
          status: 'Ended',
        },
      });

      const entry = await prisma.watchlistEntry.create({
        data: {
          showId: show.id,
          status: 'watching',
          currentSeason: 1,
          currentEpisode: 1,
        },
      });

      // Assign to Monday
      await assignShowToDay(entry.id, 1);

      // Spy on isEpisodeAvailable to verify it's NOT called
      const spy = vi.spyOn(tmdb, 'isEpisodeAvailable');

      const monday = localDate(2026, 2, 2);
      await generateSchedule(monday, 1);

      // Should NOT call isEpisodeAvailable for ended shows
      expect(spy).not.toHaveBeenCalled();

      const mondaySchedule = await getScheduleForDay(monday);

      // Should have scheduled at least one episode
      const scheduledForShow = mondaySchedule!.episodes.filter(
        (ep) => ep.showId === show.id
      );
      expect(scheduledForShow.length).toBeGreaterThan(0);
    });

    it('includes available episodes for returning series', async () => {
      await updateSettings({ weekdayMinutes: 120 });

      // Create a returning series show
      const show = await prisma.show.create({
        data: {
          tmdbId: 88890,
          title: 'Available Returning Show',
          genres: '["Drama"]',
          totalSeasons: 2,
          totalEpisodes: 20,
          episodeRuntime: 30,
          status: 'Returning Series',
        },
      });

      const entry = await prisma.watchlistEntry.create({
        data: {
          showId: show.id,
          status: 'watching',
          currentSeason: 1,
          currentEpisode: 1,
        },
      });

      // Assign to Monday
      await assignShowToDay(entry.id, 1);

      // Mock isEpisodeAvailable to return available
      vi.spyOn(tmdb, 'isEpisodeAvailable').mockResolvedValue({
        available: true,
        airDate: '2020-01-01',
      });

      const monday = localDate(2026, 2, 2);
      await generateSchedule(monday, 1);

      const mondaySchedule = await getScheduleForDay(monday);

      // Should have scheduled at least one episode
      const scheduledForShow = mondaySchedule!.episodes.filter(
        (ep) => ep.showId === show.id
      );
      expect(scheduledForShow.length).toBeGreaterThan(0);
    });
  });
});
