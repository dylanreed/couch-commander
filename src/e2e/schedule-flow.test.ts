// ABOUTME: End-to-end test for the core scheduling flow.
// ABOUTME: Tests: add show -> promote (auto-assign) -> generate schedule -> check in.

import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../lib/db';
import { cacheShow } from '../services/showCache';
import { addToWatchlist, promoteFromQueue, finishShow } from '../services/watchlist';
import { updateSettings } from '../services/settings';
import { generateSchedule, getScheduleForDay } from '../services/scheduler';
import { assignShowToDay } from '../services/dayAssignment';

describe('E2E: Schedule Flow', () => {
  beforeEach(async () => {
    await prisma.scheduledEpisode.deleteMany();
    await prisma.scheduleDay.deleteMany();
    await prisma.showDayAssignment.deleteMany();
    await prisma.watchlistEntry.deleteMany();
    await prisma.show.deleteMany();
    await prisma.settings.deleteMany();
  });

  it('completes full flow: add -> promote -> schedule -> check-in', async () => {
    // 1. Add a show to watchlist (queued by default)
    const show = await cacheShow(1396); // Breaking Bad
    const entry = await addToWatchlist(show.id);
    expect(entry.status).toBe('queued');

    // 2. Configure settings
    await updateSettings({ weekdayMinutes: 120 });

    // 3. Promote to watching (auto-assigns to best day)
    const promoted = await promoteFromQueue(entry.id);
    expect(promoted.status).toBe('watching');
    expect(promoted.dayAssignments.length).toBeGreaterThan(0);

    // 4. Get the assigned day and generate schedule for that day
    const assignedDay = promoted.dayAssignments[0].dayOfWeek;

    // Create a date that matches that day of week
    const today = new Date();
    while (today.getDay() !== assignedDay) {
      today.setDate(today.getDate() + 1);
    }
    today.setHours(0, 0, 0, 0);

    await generateSchedule(today, 1);

    // 5. Verify schedule has episodes
    const schedule = await getScheduleForDay(today);
    expect(schedule).not.toBeNull();
    expect(schedule!.episodes.length).toBeGreaterThan(0);
    expect(schedule!.episodes[0].status).toBe('pending');
    expect(schedule!.episodes[0].showId).toBe(show.id);

    // 6. Mark first episode watched
    const firstEpisode = schedule!.episodes[0];
    await prisma.scheduledEpisode.update({
      where: { id: firstEpisode.id },
      data: { status: 'watched' },
    });

    // 7. Verify episode is watched
    const updated = await getScheduleForDay(today);
    const ep = updated!.episodes.find((e) => e.id === firstEpisode.id);
    expect(ep!.status).toBe('watched');
  });

  it('finishes show without auto-promoting (user picks manually)', async () => {
    await updateSettings({ weekdayMinutes: 120 });

    // Add two shows
    const show1 = await cacheShow(1396);
    const show2 = await cacheShow(60059);

    const entry1 = await addToWatchlist(show1.id);
    await addToWatchlist(show2.id);

    // Promote first, second stays in queue
    await promoteFromQueue(entry1.id);

    // Finish first show - should NOT auto-promote
    const result = await finishShow(entry1.id);

    expect(result.finishedEntry.status).toBe('finished');
    expect(result.promotedEntry).toBeNull(); // User picks manually
  });
});
