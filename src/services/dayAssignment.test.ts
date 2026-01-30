// ABOUTME: Tests for day assignment service.
// ABOUTME: Verifies show-to-day linking functionality.

import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../lib/db';
import {
  assignShowToDay,
  getShowsForDay,
  removeShowFromDay,
  removeAllAssignments,
} from './dayAssignment';
import { cacheShow } from './showCache';
import { addToWatchlist } from './watchlist';

describe('Day Assignment Service', () => {
  beforeEach(async () => {
    await prisma.scheduledEpisode.deleteMany();
    await prisma.scheduleDay.deleteMany();
    await prisma.showDayAssignment.deleteMany();
    await prisma.watchlistEntry.deleteMany();
    await prisma.show.deleteMany();
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
});
