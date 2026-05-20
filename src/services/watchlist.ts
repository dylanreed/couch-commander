// ABOUTME: Manages the user's watchlist of TV shows.
// ABOUTME: Handles adding, removing, reordering, and progress tracking.

import { prisma } from '../lib/db';
import type { WatchlistEntry, Show, ShowDayAssignment } from '@prisma/client';
import { removeAllAssignments } from './dayAssignment';
import { isEpisodeAvailable } from './tmdb';

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

export type WatchlistStatus = 'queued' | 'watching' | 'finished' | 'dropped';

export async function updateWatchlistStatus(
  entryId: number,
  status: WatchlistStatus
): Promise<WatchlistEntryWithShow> {
  return prisma.watchlistEntry.update({
    where: { id: entryId },
    data: { status },
    include: { show: true },
  });
}

export type WatchlistEntryWithShowAndAssignments = WatchlistEntry & {
  show: Show;
  dayAssignments: ShowDayAssignment[];
};

export async function promoteFromQueue(
  entryId: number
): Promise<WatchlistEntryWithShowAndAssignments> {
  const entry = await prisma.watchlistEntry.findUnique({
    where: { id: entryId },
    include: { show: true },
  });

  if (!entry) throw new Error('Entry not found');
  if (entry.status !== 'queued') throw new Error('Entry is not queued');

  // Check if episode is available for returning series
  if (entry.show.status === 'Returning Series') {
    const availability = await isEpisodeAvailable(
      entry.show.tmdbId,
      entry.currentSeason,
      entry.currentEpisode
    );

    if (!availability.available) {
      const dateMsg = availability.airDate
        ? `Next episode airs ${availability.airDate}`
        : 'Air date TBA';
      throw new Error(`No episodes available yet. ${dateMsg}`);
    }
  }

  // Flip status to watching — day assignment is handled separately by the scheduler
  return prisma.watchlistEntry.update({
    where: { id: entryId },
    data: { status: 'watching' },
    include: { show: true, dayAssignments: true },
  });
}

export async function demoteToQueue(entryId: number): Promise<WatchlistEntryWithShow> {
  const entry = await prisma.watchlistEntry.findUnique({
    where: { id: entryId },
    include: { show: true },
  });

  if (!entry) throw new Error('Entry not found');
  if (entry.status !== 'watching') throw new Error('Entry is not currently watching');

  // Remove all day assignments
  await removeAllAssignments(entryId);

  // Update status to queued
  const updated = await prisma.watchlistEntry.update({
    where: { id: entryId },
    data: { status: 'queued' },
    include: { show: true },
  });

  return updated;
}

export interface FinishShowResult {
  finishedEntry: WatchlistEntryWithShow;
  promotedEntry: WatchlistEntryWithShowAndAssignments | null;
  movedToQueue: boolean; // True if show is returning and was moved to queue instead of finished
}

export async function finishShow(entryId: number): Promise<FinishShowResult> {
  const entry = await prisma.watchlistEntry.findUnique({
    where: { id: entryId },
    include: { dayAssignments: true, show: true },
  });

  if (!entry) throw new Error('Entry not found');

  const freedRuntime = entry.show.episodeRuntime;
  const isReturning = entry.show.status === 'Returning Series';

  // Remove day assignments first
  await removeAllAssignments(entryId);

  // If show is returning, move to queue to wait for new episodes
  // Otherwise mark as finished
  const newStatus = isReturning ? 'queued' : 'finished';

  await prisma.watchlistEntry.update({
    where: { id: entryId },
    data: { status: newStatus },
  });

  const finishedEntry = await prisma.watchlistEntry.findUnique({
    where: { id: entryId },
    include: { show: true },
  });

  return {
    finishedEntry: finishedEntry!,
    promotedEntry: null, // User chooses what to promote manually
    movedToQueue: isReturning,
  };
}

async function autoPromoteFromQueue(
  freedRuntime: number
): Promise<WatchlistEntryWithShowAndAssignments | null> {
  const queue = await prisma.watchlistEntry.findMany({
    where: { status: 'queued' },
    include: { show: true },
    orderBy: { priority: 'asc' },
  });

  if (queue.length === 0) return null;

  // Score queue entries by runtime similarity to freed slot
  const scored = queue.map((entry) => {
    const runtimeDiff = Math.abs(entry.show.episodeRuntime - freedRuntime);
    return { entry, score: 100 - runtimeDiff };
  });

  const best = scored.sort((a, b) => b.score - a.score)[0];

  // Promote the best match
  return promoteFromQueue(best.entry.id);
}

export interface QueueAvailabilityMap {
  [entryId: number]: {
    available: boolean;
    airDate: string | null;
  };
}

export async function checkQueueAvailability(): Promise<QueueAvailabilityMap> {
  const queue = await prisma.watchlistEntry.findMany({
    where: { status: 'queued' },
    include: { show: true },
  });

  const result: QueueAvailabilityMap = {};

  for (const entry of queue) {
    // Only check returning series - ended shows are always "available"
    if (entry.show.status === 'Returning Series') {
      const availability = await isEpisodeAvailable(
        entry.show.tmdbId,
        entry.currentSeason,
        entry.currentEpisode
      );
      result[entry.id] = availability;
    } else {
      result[entry.id] = { available: true, airDate: null };
    }
  }

  return result;
}
