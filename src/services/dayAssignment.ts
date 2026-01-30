// ABOUTME: Manages which shows are assigned to which days of the week.
// ABOUTME: Handles day assignment CRUD and capacity calculations.

import { prisma } from '../lib/db';
import type { ShowDayAssignment, WatchlistEntry, Show } from '@prisma/client';
import { getSettings } from './settings';

export type DayAssignmentWithShow = ShowDayAssignment & {
  watchlistEntry: WatchlistEntry & { show: Show };
};

export async function assignShowToDay(
  watchlistEntryId: number,
  dayOfWeek: number
): Promise<ShowDayAssignment> {
  return prisma.showDayAssignment.create({
    data: { watchlistEntryId, dayOfWeek },
  });
}

export async function getShowsForDay(dayOfWeek: number): Promise<DayAssignmentWithShow[]> {
  return prisma.showDayAssignment.findMany({
    where: { dayOfWeek },
    include: {
      watchlistEntry: {
        include: { show: true },
      },
    },
  });
}

export async function removeShowFromDay(
  watchlistEntryId: number,
  dayOfWeek: number
): Promise<ShowDayAssignment> {
  return prisma.showDayAssignment.delete({
    where: {
      watchlistEntryId_dayOfWeek: { watchlistEntryId, dayOfWeek },
    },
  });
}

export async function removeAllAssignments(watchlistEntryId: number): Promise<{ count: number }> {
  return prisma.showDayAssignment.deleteMany({
    where: { watchlistEntryId },
  });
}

export interface DayCapacity {
  totalMinutes: number;
  usedMinutes: number;
  availableMinutes: number;
}

export async function getDayCapacity(dayOfWeek: number): Promise<DayCapacity> {
  const settings = await getSettings();

  // Get budget for this day - check day-specific override first, then fall back to weekday/weekend
  const dayBudgets = [
    settings.sundayMinutes ?? settings.weekendMinutes,
    settings.mondayMinutes ?? settings.weekdayMinutes,
    settings.tuesdayMinutes ?? settings.weekdayMinutes,
    settings.wednesdayMinutes ?? settings.weekdayMinutes,
    settings.thursdayMinutes ?? settings.weekdayMinutes,
    settings.fridayMinutes ?? settings.weekdayMinutes,
    settings.saturdayMinutes ?? settings.weekendMinutes,
  ];
  const totalMinutes = dayBudgets[dayOfWeek];

  // Get watching shows assigned to this day
  const assignments = await prisma.showDayAssignment.findMany({
    where: {
      dayOfWeek,
      watchlistEntry: { status: 'watching' },
    },
    include: {
      watchlistEntry: { include: { show: true } },
    },
  });

  const usedMinutes = assignments.reduce(
    (sum, a) => sum + a.watchlistEntry.show.episodeRuntime,
    0
  );

  return {
    totalMinutes,
    usedMinutes,
    availableMinutes: totalMinutes - usedMinutes,
  };
}

async function getDayGenres(dayOfWeek: number): Promise<string[]> {
  const assignments = await prisma.showDayAssignment.findMany({
    where: {
      dayOfWeek,
      watchlistEntry: { status: 'watching' },
    },
    include: {
      watchlistEntry: { include: { show: true } },
    },
  });

  const genres = assignments.flatMap((a) =>
    JSON.parse(a.watchlistEntry.show.genres) as string[]
  );

  return [...new Set(genres)];
}

export async function findBestDayForShow(
  runtime: number,
  genres: string[] = []
): Promise<number> {
  const capacities = await Promise.all(
    [0, 1, 2, 3, 4, 5, 6].map(async (day) => ({
      day,
      ...(await getDayCapacity(day)),
      genres: await getDayGenres(day),
    }))
  );

  // Filter to days that can fit the show
  const viable = capacities.filter((c) => c.availableMinutes >= runtime);

  if (viable.length === 0) {
    // No single day fits; return day with most space
    return capacities.sort((a, b) => b.availableMinutes - a.availableMinutes)[0].day;
  }

  // Score by: available time + genre variety bonus
  const scored = viable.map((c) => {
    const genreOverlap = genres.filter((g) => c.genres.includes(g)).length;
    const varietyBonus = genreOverlap === 0 ? 30 : 0; // Bonus for genre diversity
    return {
      ...c,
      score: c.availableMinutes + varietyBonus,
    };
  });

  return scored.sort((a, b) => b.score - a.score)[0].day;
}
