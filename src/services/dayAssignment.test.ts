// ABOUTME: Tests for day assignment service.
// ABOUTME: Verifies show-to-day linking functionality.

import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../lib/db';
import {
  assignShowToDay,
  getShowsForDay,
  removeShowFromDay,
  removeAllAssignments,
  getDayCapacity,
} from './dayAssignment';
import { cacheShow } from './showCache';
import { addToWatchlist, updateWatchlistStatus } from './watchlist';
import { updateSettings } from './settings';

describe('Day Assignment Service', () => {
  beforeEach(async () => {
    await prisma.scheduledEpisode.deleteMany();
    await prisma.scheduleDay.deleteMany();
    await prisma.showDayAssignment.deleteMany();
    await prisma.watchlistEntry.deleteMany();
    await prisma.show.deleteMany();
    await prisma.settings.deleteMany();
  });

  it('assigns a show to a specific day', async () => {
    const show = await cacheShow(1396);
    const entry = await addToWatchlist(show.id);

    const assignment = await assignShowToDay(entry.id, 1); // Monday

    expect(assignment.dayOfWeek).toBe(1);
    expect(assignment.watchlistEntryId).toBe(entry.id);
  });

  it('gets all shows assigned to a day', async () => {
    const show = await cacheShow(1396);
    const entry = await addToWatchlist(show.id);
    await assignShowToDay(entry.id, 1);

    const mondayShows = await getShowsForDay(1);

    expect(mondayShows.length).toBe(1);
  });

  it('removes a show from a day', async () => {
    const show = await cacheShow(1396);
    const entry = await addToWatchlist(show.id);
    await assignShowToDay(entry.id, 1);

    await removeShowFromDay(entry.id, 1);

    const mondayShows = await getShowsForDay(1);
    expect(mondayShows.length).toBe(0);
  });

  it('removes all assignments for a show', async () => {
    const show = await cacheShow(1396);
    const entry = await addToWatchlist(show.id);
    await assignShowToDay(entry.id, 1);
    await assignShowToDay(entry.id, 3);

    await removeAllAssignments(entry.id);

    const monday = await getShowsForDay(1);
    const wednesday = await getShowsForDay(3);
    expect(monday.length).toBe(0);
    expect(wednesday.length).toBe(0);
  });

  it('calculates remaining capacity for a day', async () => {
    // Setup: 120 min budget, one ~47-min show assigned
    await updateSettings({ mondayMinutes: 120 });
    const show = await cacheShow(1396); // Breaking Bad, ~47 min
    const entry = await addToWatchlist(show.id);
    await updateWatchlistStatus(entry.id, 'watching');
    await assignShowToDay(entry.id, 1); // Monday

    const capacity = await getDayCapacity(1); // Monday

    expect(capacity.totalMinutes).toBe(120);
    expect(capacity.usedMinutes).toBeGreaterThan(40);
    expect(capacity.availableMinutes).toBeLessThan(80);
  });

  it('uses weekday default when no day-specific override', async () => {
    await updateSettings({ weekdayMinutes: 90 }); // No mondayMinutes set

    const capacity = await getDayCapacity(1); // Monday

    expect(capacity.totalMinutes).toBe(90);
  });

});
