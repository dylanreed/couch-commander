// ABOUTME: Manages the user's watchlist of TV shows.
// ABOUTME: Handles adding, removing, reordering, and progress tracking.

import { prisma } from '../lib/db';
import type { WatchlistEntry, Show } from '@prisma/client';

interface WatchlistOptions {
  startSeason?: number;
  startEpisode?: number;
  priority?: number;
  modeOverride?: string;
}

export async function addToWatchlist(
  showId: number,
  options: WatchlistOptions = {}
): Promise<WatchlistEntry> {
  const { startSeason = 1, startEpisode = 1, priority = 0, modeOverride } = options;

  return prisma.watchlistEntry.create({
    data: {
      showId,
      startSeason,
      startEpisode,
      currentSeason: startSeason,
      currentEpisode: startEpisode,
      priority,
      modeOverride,
    },
  });
}

export async function removeFromWatchlist(entryId: number): Promise<void> {
  await prisma.watchlistEntry.delete({
    where: { id: entryId },
  });
}

export type WatchlistEntryWithShow = WatchlistEntry & { show: Show };

export async function getWatchlist(): Promise<WatchlistEntryWithShow[]> {
  return prisma.watchlistEntry.findMany({
    where: { active: true },
    include: { show: true },
    orderBy: { priority: 'asc' },
  });
}

export async function getWatchlistEntry(entryId: number): Promise<WatchlistEntryWithShow | null> {
  return prisma.watchlistEntry.findUnique({
    where: { id: entryId },
    include: { show: true },
  });
}

export async function updateWatchlistEntry(
  entryId: number,
  data: Partial<Omit<WatchlistEntry, 'id' | 'showId' | 'createdAt' | 'updatedAt'>>
): Promise<WatchlistEntry> {
  return prisma.watchlistEntry.update({
    where: { id: entryId },
    data,
  });
}

export async function reorderWatchlist(orderedIds: number[]): Promise<void> {
  const updates = orderedIds.map((id, index) =>
    prisma.watchlistEntry.update({
      where: { id },
      data: { priority: index },
    })
  );

  await prisma.$transaction(updates);
}

export async function advanceEpisode(
  entryId: number,
  season: number,
  episode: number
): Promise<WatchlistEntry> {
  return prisma.watchlistEntry.update({
    where: { id: entryId },
    data: {
      currentSeason: season,
      currentEpisode: episode,
    },
  });
}
