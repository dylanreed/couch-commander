// ABOUTME: End-to-end test for rotation group flow.
// ABOUTME: Creates a group via API, assigns to Sunday, generates schedule, marks shows finished.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import app from '../index';
import { prisma } from '../lib/db';
import { generateSchedule, getScheduleForDay, clearSchedule } from '../services/scheduler';

async function seedShow(tmdbId: number, title: string, totalEpisodes = 50, entryStatus = 'watching') {
  const show = await prisma.show.create({
    data: { tmdbId, title, genres: '[]', totalSeasons: 1, totalEpisodes, episodeRuntime: 30, status: 'Ended' },
  });
  const entry = await prisma.watchlistEntry.create({ data: { showId: show.id, status: entryStatus } });
  return { show, entry };
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
  await prisma.settings.upsert({
    where: { id: 1 },
    create: { id: 1, weekdayMinutes: 60, weekendMinutes: 60, schedulingMode: 'sequential' },
    update: { weekdayMinutes: 60, weekendMinutes: 60, schedulingMode: 'sequential' },
  });
  await clearSchedule();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('rotation flow', () => {
  it('cycles MSW / DM / MAG over four Sundays via the API', async () => {
    const msw = await seedShow(901, 'MSW');
    const dm  = await seedShow(902, 'DM');
    const mag = await seedShow(903, 'MAG', 1); // MAG only has 1 episode for the drop test later

    let r = await request(app).post('/api/rotations').send({ name: 'Sunday Mystery Hour' });
    expect(r.status).toBe(201);
    const groupId = r.body.id;

    for (const e of [msw.entry, dm.entry, mag.entry]) {
      await request(app).post(`/api/rotations/${groupId}/members`).send({ watchlistEntryId: e.id });
    }
    await request(app).put(`/api/rotations/${groupId}/days`).send({ daysOfWeek: [0] });

    const start = new Date('2026-05-17T00:00:00.000Z');
    await generateSchedule(start, 28);

    const sundayDates = [0, 7, 14, 21].map(i => {
      const d = new Date(start); d.setDate(d.getDate() + i); d.setHours(0, 0, 0, 0); return d;
    });
    const sundays = await Promise.all(sundayDates.map(d => getScheduleForDay(d)));
    const titles = sundays.map(day => day!.episodes.map(ep => ep.show.title));
    expect(titles[0]).toEqual(['MSW']);
    expect(titles[1]).toEqual(['DM']);
    expect(titles[2]).toEqual(['MAG']);
    expect(titles[3]).toEqual(['MSW']);

    const members = await prisma.rotationMember.findMany({ where: { rotationGroupId: groupId } });
    const magMember = members.find(m => m.watchlistEntryId === mag.entry.id);
    expect(magMember!.finished).toBe(true);
  });

  it('schedules rotation members whose watchlist entry is queued (not yet promoted to watching)', async () => {
    // Rotation membership is itself the signal of intent — a user who builds a
    // rotation out of queued shows should not have to manually promote each
    // entry to 'watching' before the scheduler will pick them.
    const a = await seedShow(701, 'Queued A', 50, 'queued');
    const b = await seedShow(702, 'Queued B', 50, 'queued');

    const r = await request(app).post('/api/rotations').send({ name: 'Queued Sundays' });
    const groupId = r.body.id;
    await request(app).post(`/api/rotations/${groupId}/members`).send({ watchlistEntryId: a.entry.id });
    await request(app).post(`/api/rotations/${groupId}/members`).send({ watchlistEntryId: b.entry.id });
    await request(app).put(`/api/rotations/${groupId}/days`).send({ daysOfWeek: [0] });

    const start = new Date('2026-05-17T00:00:00.000Z');
    await generateSchedule(start, 14);

    const sun1 = await getScheduleForDay(new Date('2026-05-17T00:00:00.000Z'));
    const sun2 = await getScheduleForDay(new Date('2026-05-24T00:00:00.000Z'));
    expect(sun1!.episodes.map(ep => ep.show.title)).toEqual(['Queued A']);
    expect(sun2!.episodes.map(ep => ep.show.title)).toEqual(['Queued B']);
  });

  it('hides queued entries from the /watchlist queue section when they are in an active rotation', async () => {
    // A show in an active rotation is already being scheduled via the
    // rotation, so listing it in the queue section is redundant noise.
    const a = await seedShow(601, 'In Rotation', 50, 'queued');
    const b = await seedShow(602, 'Plain Queued', 50, 'queued');

    const r = await request(app).post('/api/rotations').send({ name: 'Hide Me Queue' });
    const groupId = r.body.id;
    await request(app).post(`/api/rotations/${groupId}/members`).send({ watchlistEntryId: a.entry.id });

    // While the rotation is active, "In Rotation" should not appear in the queue list.
    let page = await request(app).get('/watchlist');
    expect(page.status).toBe(200);
    const queueStart = page.text.indexOf('<!-- Queue -->');
    expect(queueStart).toBeGreaterThan(-1);
    const queueSection = page.text.slice(queueStart);
    expect(queueSection).not.toContain('In Rotation');
    expect(queueSection).toContain('Plain Queued');

    // Deactivate the rotation and the same entry should reappear in the queue.
    await request(app).post(`/rotations/${groupId}`).send({ name: 'Hide Me Queue', active: '' });
    page = await request(app).get('/watchlist');
    const queueSection2 = page.text.slice(page.text.indexOf('<!-- Queue -->'));
    expect(queueSection2).toContain('In Rotation');
    expect(queueSection2).toContain('Plain Queued');
  });

  it('is idempotent across regenerations', async () => {
    const a = await seedShow(801, 'A');
    const b = await seedShow(802, 'B');

    const r = await request(app).post('/api/rotations').send({ name: 'AB' });
    const groupId = r.body.id;
    await request(app).post(`/api/rotations/${groupId}/members`).send({ watchlistEntryId: a.entry.id });
    await request(app).post(`/api/rotations/${groupId}/members`).send({ watchlistEntryId: b.entry.id });
    await request(app).put(`/api/rotations/${groupId}/days`).send({ daysOfWeek: [0] });

    const start = new Date('2026-05-17T00:00:00.000Z');
    await generateSchedule(start, 14);
    const firstA = (await getScheduleForDay(new Date('2026-05-17T00:00:00.000Z')))!.episodes[0].show.title;
    await generateSchedule(start, 14);
    const secondA = (await getScheduleForDay(new Date('2026-05-17T00:00:00.000Z')))!.episodes[0].show.title;
    expect(firstA).toBe(secondA);
  });
});
