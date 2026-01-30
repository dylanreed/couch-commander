// ABOUTME: End-to-end test for the core scheduling flow.
// ABOUTME: Tests: add show -> promote -> assign day -> generate schedule -> check in.

import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../lib/db';
import { cacheShow } from '../services/showCache';
import { addToWatchlist, promoteFromQueue } from '../services/watchlist';
import { assignShowToDay } from '../services/dayAssignment';
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

  it('completes full flow: add show -> promote -> schedule -> check-in', async () => {
    // 1. Add a show to watchlist (starts as queued)
    const show = await cacheShow(1396); // Breaking Bad
    const entry = await addToWatchlist(show.id);

    // 2. Configure settings
    await updateSettings({
      weekdayMinutes: 120, // 2 hours
      schedulingMode: 'sequential',
    });

    // 3. Promote to watching (auto-assigns to a day)
    await promoteFromQueue(entry.id);

    // 4. Assign to today's day of week
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayDayOfWeek = today.getDay();

    // Clear auto-assignment and assign to today
    await prisma.showDayAssignment.deleteMany({ where: { watchlistEntryId: entry.id } });
    await assignShowToDay(entry.id, todayDayOfWeek);

    // 5. Generate schedule
    await generateSchedule(today, 7);

    // 6. Verify today has episodes
    const todaySchedule = await getScheduleForDay(today);
    expect(todaySchedule).not.toBeNull();
    expect(todaySchedule!.episodes.length).toBeGreaterThan(0);
    expect(todaySchedule!.episodes[0].status).toBe('pending');

    // 7. Simulate check-in: mark first episode as watched
    const firstEpisode = todaySchedule!.episodes[0];
    await prisma.scheduledEpisode.update({
      where: { id: firstEpisode.id },
      data: { status: 'watched' },
    });

    // 8. Verify episode is marked watched
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

    const entry1 = await addToWatchlist(show1.id, { priority: 0 });
    const entry2 = await addToWatchlist(show2.id, { priority: 1 });

    await updateSettings({
      weekdayMinutes: 180,
      schedulingMode: 'roundrobin',
    });

    // Promote both shows to watching
    await promoteFromQueue(entry1.id);
    await promoteFromQueue(entry2.id);

    // Assign both to today's day of week
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayDayOfWeek = today.getDay();

    await prisma.showDayAssignment.deleteMany({ where: { watchlistEntryId: entry1.id } });
    await prisma.showDayAssignment.deleteMany({ where: { watchlistEntryId: entry2.id } });
    await assignShowToDay(entry1.id, todayDayOfWeek);
    await assignShowToDay(entry2.id, todayDayOfWeek);

    await generateSchedule(today, 1);

    const schedule = await getScheduleForDay(today);
    expect(schedule!.episodes.length).toBeGreaterThan(1);

    // Should have episodes from both shows
    const showIds = new Set(schedule!.episodes.map((ep) => ep.showId));
    expect(showIds.size).toBe(2);
  });
});
