// ABOUTME: Caches TMDB show data to local SQLite database.
// ABOUTME: Minimizes API calls by storing show info locally.

import { prisma } from '../lib/db';
import { getShowDetails } from './tmdb';
import type { Show } from '@prisma/client';

export async function getCachedShow(tmdbId: number): Promise<Show | null> {
  return prisma.show.findUnique({
    where: { tmdbId },
  });
}

export async function cacheShow(tmdbId: number): Promise<Show> {
  // Check if already cached
  const existing = await getCachedShow(tmdbId);
  if (existing) {
    return existing;
  }

  // Fetch from TMDB and cache
  const details = await getShowDetails(tmdbId);

  return prisma.show.create({
    data: {
      tmdbId: details.id,
      title: details.name,
      posterPath: details.posterPath,
      genres: JSON.stringify(details.genres),
      totalSeasons: details.totalSeasons,
      totalEpisodes: details.totalEpisodes,
      episodeRuntime: details.episodeRuntime,
      status: details.status,
    },
  });
}

export async function refreshShowCache(tmdbId: number): Promise<Show> {
  const details = await getShowDetails(tmdbId);

  return prisma.show.upsert({
    where: { tmdbId },
    update: {
      title: details.name,
      posterPath: details.posterPath,
      genres: JSON.stringify(details.genres),
      totalSeasons: details.totalSeasons,
      totalEpisodes: details.totalEpisodes,
      episodeRuntime: details.episodeRuntime,
      status: details.status,
    },
    create: {
      tmdbId: details.id,
      title: details.name,
      posterPath: details.posterPath,
      genres: JSON.stringify(details.genres),
      totalSeasons: details.totalSeasons,
      totalEpisodes: details.totalEpisodes,
      episodeRuntime: details.episodeRuntime,
      status: details.status,
    },
  });
}
