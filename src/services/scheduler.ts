// ABOUTME: Core scheduling engine for generating viewing schedules.
// ABOUTME: Supports sequential, round-robin, and genre-slotted modes.

import { prisma } from '../lib/db';
import { getSettings, getMinutesForDay } from './settings';
import { getWatchlist, type WatchlistEntryWithShow } from './watchlist';
import type { ScheduleDay, ScheduledEpisode, Show } from '@prisma/client';

export type ScheduleDayWithEpisodes = ScheduleDay & {
  episodes: (ScheduledEpisode & { show: Show })[];
};

export async function getScheduleForDay(date: Date): Promise<ScheduleDayWithEpisodes | null> {
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);

  return prisma.scheduleDay.findUnique({
    where: { date: dayStart },
    include: {
      episodes: {
        include: { show: true },
        orderBy: { order: 'asc' },
      },
    },
  });
}

export async function generateSchedule(startDate: Date, days: number): Promise<void> {
  const settings = await getSettings();
  const watchlist = await getWatchlist();

  if (watchlist.length === 0) {
    return;
  }

  // Track current position for each show
  const positions = new Map<number, { season: number; episode: number }>();
  for (const entry of watchlist) {
    positions.set(entry.id, {
      season: entry.currentSeason,
      episode: entry.currentEpisode,
    });
  }

  for (let i = 0; i < days; i++) {
    const currentDate = new Date(startDate);
    currentDate.setDate(currentDate.getDate() + i);
    currentDate.setHours(0, 0, 0, 0);

    const minutesForDay = await getMinutesForDay(currentDate);

    // Create or clear the schedule day
    await prisma.scheduleDay.upsert({
      where: { date: currentDate },
      update: { plannedMinutes: minutesForDay },
      create: { date: currentDate, plannedMinutes: minutesForDay },
    });

    // Clear existing episodes for this day
    await prisma.scheduledEpisode.deleteMany({
      where: { scheduleDay: { date: currentDate } },
    });

    const scheduleDay = await prisma.scheduleDay.findUnique({
      where: { date: currentDate },
    });

    if (!scheduleDay) continue;

    let remainingMinutes = minutesForDay;
    const episodeOrder = 0;

    if (settings.schedulingMode === 'sequential') {
      remainingMinutes = await fillDaySequential(
        scheduleDay.id,
        watchlist,
        positions,
        remainingMinutes,
        episodeOrder
      );
    } else if (settings.schedulingMode === 'roundrobin') {
      remainingMinutes = await fillDayRoundRobin(
        scheduleDay.id,
        watchlist,
        positions,
        remainingMinutes,
        episodeOrder
      );
    }
    // Genre mode would go here
  }
}

async function fillDaySequential(
  scheduleDayId: number,
  watchlist: WatchlistEntryWithShow[],
  positions: Map<number, { season: number; episode: number }>,
  remainingMinutes: number,
  startOrder: number
): Promise<number> {
  let order = startOrder;

  for (const entry of watchlist) {
    if (remainingMinutes <= 0) break;

    const pos = positions.get(entry.id)!;
    const runtime = entry.show.episodeRuntime;

    // Schedule episodes from this show until time runs out or show is done
    while (remainingMinutes >= runtime && pos.episode <= entry.show.totalEpisodes) {
      await prisma.scheduledEpisode.create({
        data: {
          scheduleDayId,
          showId: entry.show.id,
          season: pos.season,
          episode: pos.episode,
          runtime,
          order,
          status: 'pending',
        },
      });

      pos.episode++;
      remainingMinutes -= runtime;
      order++;

      // Simple episode increment (doesn't handle seasons properly yet)
      // In a full implementation, we'd need season/episode data from TMDB
    }
  }

  return remainingMinutes;
}

async function fillDayRoundRobin(
  scheduleDayId: number,
  watchlist: WatchlistEntryWithShow[],
  positions: Map<number, { season: number; episode: number }>,
  remainingMinutes: number,
  startOrder: number
): Promise<number> {
  let order = startOrder;
  let addedThisRound = true;

  while (remainingMinutes > 0 && addedThisRound) {
    addedThisRound = false;

    for (const entry of watchlist) {
      if (remainingMinutes <= 0) break;

      const pos = positions.get(entry.id)!;
      const runtime = entry.show.episodeRuntime;

      if (remainingMinutes >= runtime && pos.episode <= entry.show.totalEpisodes) {
        await prisma.scheduledEpisode.create({
          data: {
            scheduleDayId,
            showId: entry.show.id,
            season: pos.season,
            episode: pos.episode,
            runtime,
            order,
            status: 'pending',
          },
        });

        pos.episode++;
        remainingMinutes -= runtime;
        order++;
        addedThisRound = true;
      }
    }
  }

  return remainingMinutes;
}

export async function clearSchedule(): Promise<void> {
  await prisma.scheduledEpisode.deleteMany();
  await prisma.scheduleDay.deleteMany();
}
