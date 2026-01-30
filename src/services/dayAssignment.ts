// ABOUTME: Manages which shows are assigned to which days of the week.
// ABOUTME: Handles day assignment CRUD and capacity calculations.

import { prisma } from '../lib/db';
import type { ShowDayAssignment, WatchlistEntry, Show } from '@prisma/client';

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
