// ABOUTME: End-to-end tests for the schedule regenerate endpoint.
// ABOUTME: Tests POST /api/schedule/regenerate returns success and preserves past watched episodes.

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../index';
import { prisma } from '../lib/db';

describe('POST /api/schedule/regenerate', () => {
  beforeEach(async () => {
    await prisma.scheduledEpisode.deleteMany();
    await prisma.scheduleDay.deleteMany();
    await prisma.showDayAssignment.deleteMany();
    await prisma.watchlistEntry.deleteMany();
    await prisma.show.deleteMany();
    await prisma.settings.deleteMany();
  });

  describe('Overflow Shows', () => {
    it('identifies shows that do not fit in the schedule', async () => {
      const fittingShow = await prisma.show.create({
        data: {
          tmdbId: 88881, title: 'Short Show', genres: '["Comedy"]',
          totalSeasons: 1, totalEpisodes: 10, episodeRuntime: 30, status: 'Ended',
        },
      });
      const overflowShow = await prisma.show.create({
        data: {
          tmdbId: 88882, title: 'Long Show', genres: '["Drama"]',
          totalSeasons: 1, totalEpisodes: 10, episodeRuntime: 60, status: 'Ended',
        },
      });

      const todayDow = new Date().getDay();
      const entry1 = await prisma.watchlistEntry.create({ data: { showId: fittingShow.id, status: 'watching' } });
      await prisma.showDayAssignment.create({ data: { watchlistEntryId: entry1.id, dayOfWeek: todayDow } });
      const entry2 = await prisma.watchlistEntry.create({ data: { showId: overflowShow.id, status: 'watching' } });
      await prisma.showDayAssignment.create({ data: { watchlistEntryId: entry2.id, dayOfWeek: todayDow } });

      await prisma.settings.upsert({
        where: { id: 1 },
        update: { weekdayMinutes: 30, weekendMinutes: 30 },
        create: { weekdayMinutes: 30, weekendMinutes: 30 },
      });

      await request(app).post('/api/schedule/regenerate');
      const res = await request(app).get('/schedule');
      expect(res.status).toBe(200);
      expect(res.text).toContain('Doesn&#39;t Fit');
      expect(res.text).toContain('Long Show');
    });

    it('excludes completed shows from overflow', async () => {
      const show = await prisma.show.create({
        data: {
          tmdbId: 88883, title: 'Completed Show', genres: '["Comedy"]',
          totalSeasons: 1, totalEpisodes: 5, episodeRuntime: 30, status: 'Ended',
        },
      });
      const entry = await prisma.watchlistEntry.create({
        data: { showId: show.id, status: 'watching', currentSeason: 1, currentEpisode: 6 },
      });
      await prisma.showDayAssignment.create({ data: { watchlistEntryId: entry.id, dayOfWeek: new Date().getDay() } });
      await prisma.settings.upsert({
        where: { id: 1 },
        update: { weekdayMinutes: 1, weekendMinutes: 1 },
        create: { weekdayMinutes: 1, weekendMinutes: 1 },
      });

      await request(app).post('/api/schedule/regenerate');
      const res = await request(app).get('/schedule');
      expect(res.status).toBe(200);
      expect(res.text).not.toContain('Doesn&#39;t Fit');
      expect(res.text).not.toContain('Completed Show');
    });

    it('hides overflow section when all shows fit', async () => {
      const res = await request(app).get('/schedule');
      expect(res.status).toBe(200);
      expect(res.text).not.toContain('Doesn&#39;t Fit');
    });
  });

  it('returns 200 with { success: true }', async () => {
    const res = await request(app).post('/api/schedule/regenerate');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it('preserves past watched episodes when regenerating', async () => {
    // Create a show
    const show = await prisma.show.create({
      data: {
        tmdbId: 99999,
        title: 'Test Show',
        posterPath: null,
        genres: '[]',
        totalSeasons: 2,
        totalEpisodes: 20,
        episodeRuntime: 30,
        status: 'Ended',
      },
    });

    // Create a watchlist entry (watching)
    const watchlistEntry = await prisma.watchlistEntry.create({
      data: {
        showId: show.id,
        status: 'watching',
        currentSeason: 1,
        currentEpisode: 1,
      },
    });

    // Assign to today's day of week
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    await prisma.showDayAssignment.create({
      data: {
        watchlistEntryId: watchlistEntry.id,
        dayOfWeek: today.getDay(),
      },
    });

    // Create a past schedule day (yesterday) with a watched episode
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const pastDay = await prisma.scheduleDay.create({
      data: {
        date: yesterday,
        plannedMinutes: 120,
      },
    });

    const pastEpisode = await prisma.scheduledEpisode.create({
      data: {
        scheduleDayId: pastDay.id,
        showId: show.id,
        season: 1,
        episode: 1,
        runtime: 30,
        order: 0,
        status: 'watched',
      },
    });

    // Create a future schedule day with a pending episode (this should be deleted)
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const futureDay = await prisma.scheduleDay.create({
      data: {
        date: tomorrow,
        plannedMinutes: 120,
      },
    });

    await prisma.scheduledEpisode.create({
      data: {
        scheduleDayId: futureDay.id,
        showId: show.id,
        season: 1,
        episode: 2,
        runtime: 30,
        order: 0,
        status: 'pending',
      },
    });

    // Call regenerate
    const res = await request(app).post('/api/schedule/regenerate');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    // Past watched episode should still exist
    const pastEpisodeAfter = await prisma.scheduledEpisode.findUnique({
      where: { id: pastEpisode.id },
    });
    expect(pastEpisodeAfter).not.toBeNull();
    expect(pastEpisodeAfter!.status).toBe('watched');

    // Past schedule day should still exist
    const pastDayAfter = await prisma.scheduleDay.findUnique({
      where: { id: pastDay.id },
    });
    expect(pastDayAfter).not.toBeNull();
  });

  it("replaces today's schedule day and watched episode on regenerate", async () => {
    // Create a show
    const show = await prisma.show.create({
      data: {
        tmdbId: 88888,
        title: 'Today Edge Case Show',
        posterPath: null,
        genres: '[]',
        totalSeasons: 1,
        totalEpisodes: 10,
        episodeRuntime: 30,
        status: 'Ended',
      },
    });

    const watchlistEntry = await prisma.watchlistEntry.create({
      data: {
        showId: show.id,
        status: 'watching',
        currentSeason: 1,
        currentEpisode: 1,
      },
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    await prisma.showDayAssignment.create({
      data: {
        watchlistEntryId: watchlistEntry.id,
        dayOfWeek: today.getDay(),
      },
    });

    // Create a schedule day for TODAY with a watched episode
    const todayDay = await prisma.scheduleDay.create({
      data: {
        date: today,
        plannedMinutes: 60,
      },
    });

    const oldWatchedEpisode = await prisma.scheduledEpisode.create({
      data: {
        scheduleDayId: todayDay.id,
        showId: show.id,
        season: 1,
        episode: 1,
        runtime: 30,
        order: 0,
        status: 'watched',
      },
    });

    // Regenerate — today is >= today, so it gets cleared and rebuilt
    const res = await request(app).post('/api/schedule/regenerate');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    // The old schedule day for today should be gone
    const oldDayAfter = await prisma.scheduleDay.findUnique({
      where: { id: todayDay.id },
    });
    expect(oldDayAfter).toBeNull();

    // The old watched episode should be gone (today gets fully regenerated)
    const oldEpisodeAfter = await prisma.scheduledEpisode.findUnique({
      where: { id: oldWatchedEpisode.id },
    });
    expect(oldEpisodeAfter).toBeNull();

    // A fresh schedule day for today should exist
    const newTodayDay = await prisma.scheduleDay.findFirst({
      where: { date: today },
    });
    expect(newTodayDay).not.toBeNull();
  });
});
