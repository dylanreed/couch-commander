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
