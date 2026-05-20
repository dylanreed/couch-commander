// ABOUTME: CRUD + scoring for day-of-week genre preferences.
// ABOUTME: Used by the scheduler to bias unpinned-show placement.

import { prisma } from '../lib/db';

const GENRE_MATCH_WEIGHT = 1000;

export async function getDayGenres(dayOfWeek: number): Promise<string[]> {
  const rows = await prisma.dayGenrePreference.findMany({
    where: { dayOfWeek },
    select: { genre: true },
  });
  return rows.map((r) => r.genre);
}

export async function getAllDayGenres(): Promise<string[][]> {
  const rows = await prisma.dayGenrePreference.findMany({
    select: { dayOfWeek: true, genre: true },
  });
  const buckets: string[][] = [[], [], [], [], [], [], []];
  for (const r of rows) buckets[r.dayOfWeek].push(r.genre);
  return buckets;
}

export async function setDayGenres(dayOfWeek: number, genres: string[]): Promise<void> {
  await prisma.$transaction([
    prisma.dayGenrePreference.deleteMany({ where: { dayOfWeek } }),
    ...genres.map((g) =>
      prisma.dayGenrePreference.create({ data: { dayOfWeek, genre: g } })
    ),
  ]);
}

/**
 * Score a day for placing an unpinned show. Higher is better. The day must
 * already be known to have enough capacity for one episode — the caller
 * filters those out.
 */
export async function scoreDayForShow(
  dayOfWeek: number,
  showGenres: string[],
  remainingMinutes: number
): Promise<number> {
  const dayGenres = await getDayGenres(dayOfWeek);
  const overlap = showGenres.filter((g) => dayGenres.includes(g)).length;
  return overlap * GENRE_MATCH_WEIGHT + remainingMinutes;
}
