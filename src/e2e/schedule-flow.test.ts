// ABOUTME: End-to-end test for the core scheduling flow.
// ABOUTME: Tests: add show -> promote (auto-assign) -> generate schedule -> check in.

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../index';
import { prisma } from '../lib/db';
import { cacheShow } from '../services/showCache';
import { addToWatchlist, promoteFromQueue, finishShow } from '../services/watchlist';
import { updateSettings } from '../services/settings';
import { generateSchedule, getScheduleForDay, clearSchedule } from '../services/scheduler';
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

  it('schedule header reflects actually-scheduled minutes, not theoretical demand', async () => {
    // Assigned demand (109m) exceeds budget (90m); scheduler fits 22+43=65m
    // and pushes the 44m show to "Doesn't Fit". The header should read
    // 65/90, not 109/90, because the user can plainly see only 65m of
    // episodes listed for the day.
    await updateSettings({ weekdayMinutes: 90, weekendMinutes: 90 });

    async function seed(tmdbId: number, title: string, runtime: number, dayOfWeek: number) {
      const show = await prisma.show.create({
        data: { tmdbId, title, genres: '[]', totalSeasons: 1, totalEpisodes: 50, episodeRuntime: runtime, status: 'Ended' },
      });
      const entry = await prisma.watchlistEntry.create({ data: { showId: show.id, status: 'watching' } });
      await prisma.showDayAssignment.create({ data: { watchlistEntryId: entry.id, dayOfWeek } });
      return { show, entry };
    }

    // Pick a future date so it falls inside the 7-day window /schedule renders.
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const targetDayOfWeek = (start.getDay() + 1) % 7; // tomorrow's day-of-week
    await seed(501, 'Twenty-Two', 22, targetDayOfWeek);
    await seed(502, 'Forty-Three', 43, targetDayOfWeek);
    await seed(503, 'Forty-Four', 44, targetDayOfWeek);

    await clearSchedule();
    await generateSchedule(start, 7);

    const page = await request(app).get('/schedule');
    expect(page.status).toBe(200);

    // The 22m and 43m episodes were scheduled (65 total); the 44m wasn't.
    expect(page.text).toContain('65/90 min');
    expect(page.text).not.toContain('109/90 min');
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
