// ABOUTME: Core scheduling engine for generating viewing schedules.
// ABOUTME: Generates day-based schedules based on show assignments to specific days of the week.

import { prisma } from '../lib/db';
import { getSettings, getMinutesForDay } from './settings';
import { isEpisodeAvailable } from './tmdb';
import { pickNextMember } from './rotation';
import { scoreDayForShow, getDayGenres } from './dayGenre';
import type { ScheduleDay, ScheduledEpisode, Show, WatchlistEntry, RotationGroup } from '@prisma/client';

export type ScheduleDayWithEpisodes = ScheduleDay & {
  episodes: (ScheduledEpisode & { show: Show; rotationGroup: RotationGroup | null })[];
};

type AssignmentWithEntry = {
  watchlistEntry: WatchlistEntry & { show: Show };
  rotationGroupId?: number;
};

// Mutex to prevent concurrent schedule generation from locking SQLite
let scheduleLock: Promise<void> = Promise.resolve();

// Getter returns the live scheduleLock promise. CommonJS destructured imports
// capture values at import time, so a getter is needed for the shutdown handler
// to read the current promise rather than a stale reference.
export function getScheduleLock(): Promise<void> {
  return scheduleLock;
}

// Guard to prevent unnecessary schedule regeneration
let scheduleStale = true;
let lastGeneratedDays = 0;

export function markScheduleStale(): void {
  scheduleStale = true;
  lastGeneratedDays = 0;
}

export function markScheduleGenerated(days: number): void {
  scheduleStale = false;
  lastGeneratedDays = Math.max(lastGeneratedDays, days);
}

export function shouldRegenerate(requestedDays: number): boolean {
  return scheduleStale || requestedDays > lastGeneratedDays;
}

export async function getScheduleForDay(date: Date): Promise<ScheduleDayWithEpisodes | null> {
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);

  return prisma.scheduleDay.findUnique({
    where: { date: dayStart },
    include: {
      episodes: {
        include: { show: true, rotationGroup: true },
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

    // Fetch rotation groups assigned to this day-of-week (active only)
    const rotationDayAssignments = await prisma.rotationDayAssignment.findMany({
      where: { dayOfWeek, rotationGroup: { active: true } },
    });

    // For each rotation group, pick the next-due member and synthesise an
    // AssignmentWithEntry that carries the rotationGroupId tag. Rotation
    // membership itself is the signal of intent — the WatchlistEntry status
    // is not consulted here (pickNextMember already filters inactive entries).
    const rotationAssignments: AssignmentWithEntry[] = [];
    for (const rda of rotationDayAssignments) {
      const member = await pickNextMember(rda.rotationGroupId);
      if (!member) continue;
      const fullEntry = await prisma.watchlistEntry.findUnique({
        where: { id: member.watchlistEntryId },
        include: { show: true },
      });
      if (!fullEntry) continue;
      rotationAssignments.push({
        watchlistEntry: fullEntry,
        rotationGroupId: rda.rotationGroupId,
      });
    }

    // Merge direct + rotation assignments
    const allAssignments: AssignmentWithEntry[] = [
      ...assignments,
      ...rotationAssignments,
    ];

    // Initialize positions for shows we haven't seen yet
    for (const assignment of allAssignments) {
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
      await fillDaySequential(scheduleDay.id, allAssignments, positions, minutesForDay);
    } else if (settings.schedulingMode === 'roundrobin') {
      await fillDayRoundRobin(scheduleDay.id, allAssignments, positions, minutesForDay);
    } else {
      console.warn(`Unknown scheduling mode "${settings.schedulingMode}", falling back to sequential`);
      await fillDaySequential(scheduleDay.id, allAssignments, positions, minutesForDay);
    }
  }

  // Pass 2: place unpinned watching shows onto the best-scoring day within the
  // requested window. Unpinned means no ShowDayAssignment rows AND no rotation
  // membership — rotation members are scheduled by rotation logic in Pass 1.
  // Each unpinned show gets AT MOST ONE episode across the whole window — one
  // per show per week — to maximise variety per night. Soft preference: shows
  // still get placed even when no day's theme matches.
  const unpinnedEntries = await prisma.watchlistEntry.findMany({
    where: {
      status: 'watching',
      dayAssignments: { none: {} },
      rotationMembers: { none: {} },
    },
    include: { show: true },
  });

  if (unpinnedEntries.length > 0) {
    // Snapshot per-day remaining capacity + next episode order.
    type DayState = {
      date: Date;
      dayOfWeek: number;
      scheduleDayId: number;
      remainingMinutes: number;
      nextOrder: number;
    };

    const dayStates: DayState[] = [];
    for (let i = 0; i < days; i++) {
      const currentDate = new Date(startDate);
      currentDate.setDate(currentDate.getDate() + i);
      currentDate.setHours(0, 0, 0, 0);

      const scheduleDay = await prisma.scheduleDay.findUnique({
        where: { date: currentDate },
        include: { episodes: true },
      });
      if (!scheduleDay) continue;

      const usedMinutes = scheduleDay.episodes.reduce((s, e) => s + e.runtime, 0);
      const maxOrder = scheduleDay.episodes.reduce((m, e) => Math.max(m, e.order), -1);
      dayStates.push({
        date: currentDate,
        dayOfWeek: currentDate.getDay(),
        scheduleDayId: scheduleDay.id,
        remainingMinutes: scheduleDay.plannedMinutes - usedMinutes,
        nextOrder: maxOrder + 1,
      });
    }

    // Place exactly one episode per unpinned show. Each show is the show's
    // current season/episode (read directly off the watchlist entry).
    for (const entry of unpinnedEntries) {
      const season = entry.currentSeason;
      const episode = entry.currentEpisode;
      if (episode > entry.show.totalEpisodes) continue;
      const runtime = entry.show.episodeRuntime;
      const showGenres = (() => {
        try { return JSON.parse(entry.show.genres) as string[]; }
        catch { return []; }
      })();

      // Primary scan: score each day that can fit the episode. Themed days
      // reject shows whose genres don't overlap — those days are reserved for
      // their matching shows. Days without a theme remain open to anything.
      let bestIdx = -1;
      let bestScore = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < dayStates.length; i++) {
        const s = dayStates[i];
        if (s.remainingMinutes < runtime) continue;
        const dayGenres = await getDayGenres(s.dayOfWeek);
        if (dayGenres.length > 0 && !showGenres.some((g) => dayGenres.includes(g))) {
          continue;
        }
        const score = await scoreDayForShow(s.dayOfWeek, showGenres, s.remainingMinutes);
        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }

      // Safety net: if the primary scan found no eligible day (the show matched
      // no themed day with room), scan again over any day with capacity,
      // dropping the themed-exclusion filter. scoreDayForShow still ranks days,
      // so the genre bonus survives — only the hard exclusion is dropped.
      if (bestIdx < 0) {
        bestScore = Number.NEGATIVE_INFINITY;
        for (let i = 0; i < dayStates.length; i++) {
          const s = dayStates[i];
          if (s.remainingMinutes < runtime) continue;
          const score = await scoreDayForShow(s.dayOfWeek, showGenres, s.remainingMinutes);
          if (score > bestScore) {
            bestScore = score;
            bestIdx = i;
          }
        }
      }

      // No day has capacity — the show gets none this week. It surfaces in the
      // "Doesn't Fit" overflow on the schedule page.
      if (bestIdx < 0) continue;
      const target = dayStates[bestIdx];

      // Availability check for returning series (mirrors fillDaySequential)
      if (entry.show.status === 'Returning Series') {
        const availability = await isEpisodeAvailable(entry.show.tmdbId, season, episode);
        if (!availability.available) continue;
      }

      await prisma.scheduledEpisode.create({
        data: {
          scheduleDayId: target.scheduleDayId,
          showId: entry.show.id,
          season,
          episode,
          runtime,
          order: target.nextOrder,
          status: 'pending',
        },
      });

      target.remainingMinutes -= runtime;
      target.nextOrder += 1;
    }
  }

  markScheduleGenerated(days);
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
          rotationGroupId: assignment.rotationGroupId ?? null,
        },
      });

      pos.episode++;
      remainingMinutes -= runtime;
      order++;

      // If this was the last available episode for a rotation member, drop them
      // from rotation so the next pick skips this member.
      if (assignment.rotationGroupId && pos.episode > entry.show.totalEpisodes) {
        await prisma.rotationMember.updateMany({
          where: { rotationGroupId: assignment.rotationGroupId, watchlistEntryId: entry.id },
          data: { finished: true },
        });
      }
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
            rotationGroupId: assignment.rotationGroupId ?? null,
          },
        });

        pos.episode++;
        remainingMinutes -= runtime;
        order++;
        scheduledThisPass = true;

        if (assignment.rotationGroupId && pos.episode > entry.show.totalEpisodes) {
          await prisma.rotationMember.updateMany({
            where: { rotationGroupId: assignment.rotationGroupId, watchlistEntryId: entry.id },
            data: { finished: true },
          });
        }
      }
    }
  }
}

export async function clearSchedule(): Promise<void> {
  await prisma.scheduledEpisode.deleteMany();
  await prisma.scheduleDay.deleteMany();
  markScheduleStale();
}
