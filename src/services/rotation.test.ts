// ABOUTME: Unit tests for the rotation service.
// ABOUTME: Covers pick logic, finished-member detection, and edge cases.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '../lib/db';
import { pickNextMember, markFinishedIfNoEpisodesLeft } from './rotation';

async function makeShow(tmdbId: number, totalEpisodes: number) {
  return prisma.show.create({
    data: {
      tmdbId,
      title: `Show ${tmdbId}`,
      genres: '[]',
      totalSeasons: 1,
      totalEpisodes,
      episodeRuntime: 45,
      status: 'Ended',
    },
  });
}

async function makeWatchlistEntry(showId: number, current = { season: 1, episode: 1 }) {
  return prisma.watchlistEntry.create({
    data: {
      showId,
      currentSeason: current.season,
      currentEpisode: current.episode,
      status: 'watching',
    },
  });
}

async function makeGroup(name: string) {
  return prisma.rotationGroup.create({ data: { name } });
}

async function addMember(groupId: number, entryId: number, order: number, finished = false) {
  return prisma.rotationMember.create({
    data: { rotationGroupId: groupId, watchlistEntryId: entryId, order, finished },
  });
}

beforeEach(async () => {
  await prisma.scheduledEpisode.deleteMany();
  await prisma.scheduleDay.deleteMany();
  await prisma.rotationDayAssignment.deleteMany();
  await prisma.rotationMember.deleteMany();
  await prisma.rotationGroup.deleteMany();
  await prisma.showDayAssignment.deleteMany();
  await prisma.watchlistEntry.deleteMany();
  await prisma.show.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('pickNextMember', () => {
  it('returns null for an empty group', async () => {
    const group = await makeGroup('Empty');
    expect(await pickNextMember(group.id)).toBeNull();
  });

  it('returns the only member when there is one', async () => {
    const group = await makeGroup('Solo');
    const show = await makeShow(101, 10);
    const entry = await makeWatchlistEntry(show.id);
    const member = await addMember(group.id, entry.id, 0);
    const picked = await pickNextMember(group.id);
    expect(picked?.id).toBe(member.id);
  });

  it('returns lowest order when all counts are equal (zero)', async () => {
    const group = await makeGroup('Trio');
    const s1 = await makeShow(201, 10);
    const s2 = await makeShow(202, 10);
    const s3 = await makeShow(203, 10);
    const e1 = await makeWatchlistEntry(s1.id);
    const e2 = await makeWatchlistEntry(s2.id);
    const e3 = await makeWatchlistEntry(s3.id);
    await addMember(group.id, e2.id, 1);
    await addMember(group.id, e3.id, 2);
    const first = await addMember(group.id, e1.id, 0);
    const picked = await pickNextMember(group.id);
    expect(picked?.id).toBe(first.id);
  });

  it('skips finished members', async () => {
    const group = await makeGroup('FinishedSkip');
    const s1 = await makeShow(301, 10);
    const s2 = await makeShow(302, 10);
    const e1 = await makeWatchlistEntry(s1.id);
    const e2 = await makeWatchlistEntry(s2.id);
    await addMember(group.id, e1.id, 0, true);
    const m2 = await addMember(group.id, e2.id, 1);
    const picked = await pickNextMember(group.id);
    expect(picked?.id).toBe(m2.id);
  });

  it('skips members whose watchlist entry is inactive', async () => {
    const group = await makeGroup('Inactive');
    const s1 = await makeShow(401, 10);
    const s2 = await makeShow(402, 10);
    const e1 = await makeWatchlistEntry(s1.id);
    await prisma.watchlistEntry.update({ where: { id: e1.id }, data: { active: false } });
    const e2 = await makeWatchlistEntry(s2.id);
    await addMember(group.id, e1.id, 0);
    const m2 = await addMember(group.id, e2.id, 1);
    const picked = await pickNextMember(group.id);
    expect(picked?.id).toBe(m2.id);
  });

  it('returns null when every candidate is finished', async () => {
    const group = await makeGroup('AllDone');
    const s1 = await makeShow(501, 10);
    const e1 = await makeWatchlistEntry(s1.id);
    await addMember(group.id, e1.id, 0, true);
    expect(await pickNextMember(group.id)).toBeNull();
  });

  it('advances on each call when episodes are scheduled between calls', async () => {
    const group = await makeGroup('CountAdvance');
    const s1 = await makeShow(601, 10);
    const s2 = await makeShow(602, 10);
    const e1 = await makeWatchlistEntry(s1.id);
    const e2 = await makeWatchlistEntry(s2.id);
    const m1 = await addMember(group.id, e1.id, 0);
    const m2 = await addMember(group.id, e2.id, 1);

    const first = await pickNextMember(group.id);
    expect(first?.id).toBe(m1.id);

    const scheduleDay = await prisma.scheduleDay.create({
      data: { date: new Date('2026-05-19T00:00:00Z'), plannedMinutes: 60 },
    });
    await prisma.scheduledEpisode.create({
      data: {
        scheduleDayId: scheduleDay.id,
        showId: s1.id,
        season: 1,
        episode: 1,
        runtime: 45,
        order: 0,
        rotationGroupId: group.id,
      },
    });

    const second = await pickNextMember(group.id);
    expect(second?.id).toBe(m2.id);
  });
});

describe('markFinishedIfNoEpisodesLeft', () => {
  it('marks finished when current cursor is past totalEpisodes', async () => {
    const group = await makeGroup('Finish');
    const show = await makeShow(701, 5);
    const entry = await makeWatchlistEntry(show.id, { season: 1, episode: 6 });
    const member = await addMember(group.id, entry.id, 0);
    await markFinishedIfNoEpisodesLeft(member.id);
    const reloaded = await prisma.rotationMember.findUnique({ where: { id: member.id } });
    expect(reloaded?.finished).toBe(true);
  });

  it('leaves finished=false when episodes remain', async () => {
    const group = await makeGroup('NotYet');
    const show = await makeShow(702, 10);
    const entry = await makeWatchlistEntry(show.id, { season: 1, episode: 3 });
    const member = await addMember(group.id, entry.id, 0);
    await markFinishedIfNoEpisodesLeft(member.id);
    const reloaded = await prisma.rotationMember.findUnique({ where: { id: member.id } });
    expect(reloaded?.finished).toBe(false);
  });
});
