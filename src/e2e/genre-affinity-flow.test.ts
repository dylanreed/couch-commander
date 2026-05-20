// ABOUTME: End-to-end test for the genre-affinity scheduling flow.
// ABOUTME: Set a day theme via API -> bulk-promote a queued show ->
// ABOUTME: regenerate schedule -> assert the show landed on the themed day.

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../index';
import { prisma } from '../lib/db';
import { generateSchedule, getScheduleForDay, clearSchedule } from '../services/scheduler';

describe('E2E: genre affinity', () => {
  beforeEach(async () => {
    await prisma.scheduledEpisode.deleteMany();
    await prisma.scheduleDay.deleteMany();
    await prisma.dayGenrePreference.deleteMany();
    await prisma.showDayAssignment.deleteMany();
    await prisma.rotationMember.deleteMany();
    await prisma.rotationDayAssignment.deleteMany();
    await prisma.rotationGroup.deleteMany();
    await prisma.watchlistEntry.deleteMany();
    await prisma.show.deleteMany();
    await prisma.settings.upsert({
      where: { id: 1 },
      create: { id: 1, weekdayMinutes: 60, weekendMinutes: 60, schedulingMode: 'sequential' },
      update: { weekdayMinutes: 60, weekendMinutes: 60, schedulingMode: 'sequential' },
    });
    await clearSchedule();
  });

  it('set theme -> bulk promote -> regen -> show lands on themed day', async () => {
    // Seed two queued shows of different genres.
    const comedyShow = await prisma.show.create({
      data: { tmdbId: 1001, title: 'Comedy Hour', genres: JSON.stringify(['Comedy']), totalSeasons: 1, totalEpisodes: 20, episodeRuntime: 30, status: 'Ended' },
    });
    const dramaShow = await prisma.show.create({
      data: { tmdbId: 1002, title: 'Drama Hour', genres: JSON.stringify(['Drama']), totalSeasons: 1, totalEpisodes: 20, episodeRuntime: 30, status: 'Ended' },
    });
    const comedyEntry = await prisma.watchlistEntry.create({ data: { showId: comedyShow.id, status: 'queued' } });
    const dramaEntry = await prisma.watchlistEntry.create({ data: { showId: dramaShow.id, status: 'queued' } });

    // 1. Set Tuesday = Comedy, Wednesday = Drama via the API.
    let r = await request(app).put('/api/settings/day-genres').send({ dayOfWeek: 2, genres: ['Comedy'] });
    expect(r.status).toBe(200);
    r = await request(app).put('/api/settings/day-genres').send({ dayOfWeek: 3, genres: ['Drama'] });
    expect(r.status).toBe(200);

    // 2. Bulk-promote both shows.
    r = await request(app).post('/api/watchlist/bulk/promote').send({ entryIds: [comedyEntry.id, dramaEntry.id] });
    expect(r.status).toBe(200);

    // 3. Regenerate the schedule starting from a Sunday so days 0..6 line up.
    const start = new Date('2026-05-17T00:00:00.000Z'); // Sunday
    await generateSchedule(start, 7);

    // 4. Assert placements.
    const tuesday = await getScheduleForDay(new Date('2026-05-19T00:00:00.000Z'));
    const wednesday = await getScheduleForDay(new Date('2026-05-20T00:00:00.000Z'));

    expect(tuesday!.episodes.map((e) => e.show.title)).toContain('Comedy Hour');
    expect(tuesday!.episodes.map((e) => e.show.title)).not.toContain('Drama Hour');
    expect(wednesday!.episodes.map((e) => e.show.title)).toContain('Drama Hour');
    expect(wednesday!.episodes.map((e) => e.show.title)).not.toContain('Comedy Hour');
  });
});
