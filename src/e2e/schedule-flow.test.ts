// ABOUTME: End-to-end test for the core scheduling flow.
// ABOUTME: Tests: add show -> generate schedule -> check in.

import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../lib/db';
import { cacheShow } from '../services/showCache';
import { addToWatchlist } from '../services/watchlist';
import { updateSettings } from '../services/settings';
import { generateSchedule, getScheduleForDay } from '../services/scheduler';

describe('E2E: Schedule Flow', () => {
  beforeEach(async () => {
    await prisma.scheduledEpisode.deleteMany();
    await prisma.scheduleDay.deleteMany();
    await prisma.showDayAssignment.deleteMany();
    await prisma.watchlistEntry.deleteMany();
    await prisma.show.deleteMany();
    await prisma.settings.deleteMany();
  });

  it('completes full flow: add show -> schedule -> check-in', async () => {
    // 1. Add a show to watchlist
    const show = await cacheShow(1396); // Breaking Bad
    await addToWatchlist(show.id);

    // 2. Configure settings
    await updateSettings({
      weekdayMinutes: 120, // 2 hours
      schedulingMode: 'sequential',
    });

    // 3. Generate schedule
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    await generateSchedule(today, 7);

    // 4. Verify today has episodes
    const todaySchedule = await getScheduleForDay(today);
    expect(todaySchedule).not.toBeNull();
    expect(todaySchedule!.episodes.length).toBeGreaterThan(0);
    expect(todaySchedule!.episodes[0].status).toBe('pending');

    // 5. Simulate check-in: mark first episode as watched
    const firstEpisode = todaySchedule!.episodes[0];
    await prisma.scheduledEpisode.update({
      where: { id: firstEpisode.id },
      data: { status: 'watched' },
    });

    // 6. Verify episode is marked watched
    const updatedSchedule = await getScheduleForDay(today);
    const updatedEpisode = updatedSchedule!.episodes.find(
      (ep) => ep.id === firstEpisode.id
    );
    expect(updatedEpisode!.status).toBe('watched');
  });

  it('handles multiple shows in round-robin mode', async () => {
    // Add two shows
    const show1 = await cacheShow(1396); // Breaking Bad
    const show2 = await cacheShow(60059); // Better Call Saul

    await addToWatchlist(show1.id, { priority: 0 });
    await addToWatchlist(show2.id, { priority: 1 });

    await updateSettings({
      weekdayMinutes: 180,
      schedulingMode: 'roundrobin',
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    await generateSchedule(today, 1);

    const schedule = await getScheduleForDay(today);
    expect(schedule!.episodes.length).toBeGreaterThan(1);

    // Should have episodes from both shows
    const showIds = new Set(schedule!.episodes.map((ep) => ep.showId));
    expect(showIds.size).toBe(2);
  });
});
