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

export async function setShowDays(
  watchlistEntryId: number,
  days: number[]
): Promise<ShowDayAssignment[]> {
  // Remove all existing assignments
  await prisma.showDayAssignment.deleteMany({
    where: { watchlistEntryId },
  });

  // Create new assignments for each day
  const assignments: ShowDayAssignment[] = [];
  for (const dayOfWeek of days) {
    const assignment = await prisma.showDayAssignment.create({
      data: { watchlistEntryId, dayOfWeek },
    });
    assignments.push(assignment);
  }

  return assignments;
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

