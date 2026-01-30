// ABOUTME: Tests for the core scheduler service.
// ABOUTME: Covers all scheduling modes and edge cases.

import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../lib/db';
import { generateSchedule, getScheduleForDay } from './scheduler';
import { cacheShow } from './showCache';
import { addToWatchlist, promoteFromQueue } from './watchlist';
import { updateSettings } from './settings';
import { assignShowToDay } from './dayAssignment';

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
});
