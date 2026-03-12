// ABOUTME: Core scheduling engine for generating viewing schedules.
// ABOUTME: Generates day-based schedules based on show assignments to specific days of the week.

import { prisma } from '../lib/db';
import { getSettings, getMinutesForDay } from './settings';
import { isEpisodeAvailable } from './tmdb';
import type { ScheduleDay, ScheduledEpisode, Show, WatchlistEntry } from '@prisma/client';

export type ScheduleDayWithEpisodes = ScheduleDay & {
  episodes: (ScheduledEpisode & { show: Show })[];
};

type AssignmentWithEntry = {
  watchlistEntry: WatchlistEntry & { show: Show };
};

// Mutex to prevent concurrent schedule generation from locking SQLite
let scheduleLock: Promise<void> = Promise.resolve();

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

export function generateSchedule(startDate: Date, days: number): Promise<void> {
  // Queue behind any in-progress generation to avoid SQLite write conflicts
  const previous = scheduleLock;
  let resolve: () => void;
  scheduleLock = new Promise<void>((r) => { resolve = r; });

  return previous
    .then(() => doGenerateSchedule(startDate, days))
    .finally(() => resolve!());
}

async function doGenerateSchedule(startDate: Date, days: number): Promise<void> {
  const settings = await getSettings();

  // Track current position for each show across all days being generated
  const positions = new Map<number, { season: number; episode: number }>();

  for (let i = 0; i < days; i++) {
    const currentDate = new Date(startDate);
    currentDate.setDate(currentDate.getDate() + i);
    currentDate.setHours(0, 0, 0, 0);

    const dayOfWeek = currentDate.getDay();
    const minutesForDay = await getMinutesForDay(currentDate);

    // Get shows assigned to this day of week with watching status
    const assignments = await prisma.showDayAssignment.findMany({
      where: {
        dayOfWeek,
        watchlistEntry: { status: 'watching' },
      },
      include: {
        watchlistEntry: { include: { show: true } },
      },
    });

    // Initialize positions for shows we haven't seen yet
    for (const assignment of assignments) {
      const entry = assignment.watchlistEntry;
      if (!positions.has(entry.id)) {
        positions.set(entry.id, {
          season: entry.currentSeason,
          episode: entry.currentEpisode,
        });
      }
    }

    // Create or update schedule day
    const scheduleDay = await prisma.scheduleDay.upsert({
      where: { date: currentDate },
      update: { plannedMinutes: minutesForDay },
      create: { date: currentDate, plannedMinutes: minutesForDay },
    });

    // Clear existing episodes for this day
    await prisma.scheduledEpisode.deleteMany({
      where: { scheduleDayId: scheduleDay.id },
    });

    // Fill day with episodes from assigned shows
    if (settings.schedulingMode === 'sequential') {
      await fillDaySequential(scheduleDay.id, assignments, positions, minutesForDay);
    } else if (settings.schedulingMode === 'roundrobin') {
      await fillDayRoundRobin(scheduleDay.id, assignments, positions, minutesForDay);
    }
  }
}

async function fillDaySequential(
  scheduleDayId: number,
  assignments: AssignmentWithEntry[],
  positions: Map<number, { season: number; episode: number }>,
  budgetMinutes: number
): Promise<void> {
  let remainingMinutes = budgetMinutes;
  let order = 0;

  // Only ONE episode per show per day
  for (const assignment of assignments) {
    if (remainingMinutes <= 0) break;

    const entry = assignment.watchlistEntry;
    const pos = positions.get(entry.id)!;
    const runtime = entry.show.episodeRuntime;

    if (remainingMinutes >= runtime && pos.episode <= entry.show.totalEpisodes) {
      // Check availability for returning series
      if (entry.show.status === 'Returning Series') {
        const availability = await isEpisodeAvailable(
          entry.show.tmdbId,
          pos.season,
          pos.episode
        );
        if (!availability.available) {
          continue; // Skip this show, try next
        }
      }

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
    }
  }
}

async function fillDayRoundRobin(
  scheduleDayId: number,
  assignments: AssignmentWithEntry[],
  positions: Map<number, { season: number; episode: number }>,
  budgetMinutes: number
): Promise<void> {
  let remainingMinutes = budgetMinutes;
  let order = 0;

  // Loop through all assignments repeatedly, one episode per show per pass,
  // until time runs out or no show can be scheduled in a full pass
  let scheduledThisPass = true;
  while (remainingMinutes > 0 && scheduledThisPass) {
    scheduledThisPass = false;

    for (const assignment of assignments) {
      if (remainingMinutes <= 0) break;

      const entry = assignment.watchlistEntry;
      const pos = positions.get(entry.id)!;
      const runtime = entry.show.episodeRuntime;

      if (remainingMinutes >= runtime && pos.episode <= entry.show.totalEpisodes) {
        // Check availability for returning series
        if (entry.show.status === 'Returning Series') {
          const availability = await isEpisodeAvailable(
            entry.show.tmdbId,
            pos.season,
            pos.episode
          );
          if (!availability.available) {
            continue; // Skip this show, try next
          }
        }

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
        scheduledThisPass = true;
      }
    }
  }
}

export async function clearSchedule(): Promise<void> {
  await prisma.scheduledEpisode.deleteMany();
  await prisma.scheduleDay.deleteMany();
}
