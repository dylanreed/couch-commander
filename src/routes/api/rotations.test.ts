// ABOUTME: API route tests for rotation group CRUD + membership ops.
// ABOUTME: Drives supertest against the live Express app.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../index';
import { prisma } from '../../lib/db';

async function makeShowAndEntry(tmdbId: number) {
  const show = await prisma.show.create({
    data: { tmdbId, title: `S${tmdbId}`, genres: '[]', totalSeasons: 1, totalEpisodes: 10, episodeRuntime: 30, status: 'Ended' },
  });
  const entry = await prisma.watchlistEntry.create({ data: { showId: show.id, status: 'watching' } });
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
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /api/rotations', () => {
  it('returns empty array initially', async () => {
    const r = await request(app).get('/api/rotations');
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });
});

describe('POST /api/rotations', () => {
  it('creates a group with name only', async () => {
    const r = await request(app).post('/api/rotations').send({ name: 'Sunday Mystery Hour' });
    expect(r.status).toBe(201);
    expect(r.body.id).toBeGreaterThan(0);
    expect(r.body.name).toBe('Sunday Mystery Hour');
    expect(r.body.dropOnFinish).toBe(true);
    expect(r.body.active).toBe(true);
  });

  it('rejects empty name', async () => {
    const r = await request(app).post('/api/rotations').send({});
    expect(r.status).toBe(400);
  });
});

describe('PATCH /api/rotations/:id', () => {
  it('updates name and flags', async () => {
    const g = await prisma.rotationGroup.create({ data: { name: 'A' } });
    const r = await request(app).patch(`/api/rotations/${g.id}`).send({ name: 'B', active: false });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('B');
    expect(r.body.active).toBe(false);
  });

  it('returns 404 for unknown id', async () => {
    const r = await request(app).patch('/api/rotations/9999').send({ name: 'X' });
    expect(r.status).toBe(404);
  });
});

describe('DELETE /api/rotations/:id', () => {
  it('removes the group and its members', async () => {
    const g = await prisma.rotationGroup.create({ data: { name: 'Doomed' } });
    const { entry } = await makeShowAndEntry(11);
    await prisma.rotationMember.create({ data: { rotationGroupId: g.id, watchlistEntryId: entry.id, order: 0 } });
    const r = await request(app).delete(`/api/rotations/${g.id}`);
    expect(r.status).toBe(204);
    expect(await prisma.rotationGroup.count()).toBe(0);
    expect(await prisma.rotationMember.count()).toBe(0);
  });
});

describe('POST /api/rotations/:id/members', () => {
  it('adds a member at next order', async () => {
    const g = await prisma.rotationGroup.create({ data: { name: 'Trio' } });
    const { entry: e1 } = await makeShowAndEntry(11);
    const { entry: e2 } = await makeShowAndEntry(12);
    let r = await request(app).post(`/api/rotations/${g.id}/members`).send({ watchlistEntryId: e1.id });
    expect(r.status).toBe(201);
    expect(r.body.order).toBe(0);
    r = await request(app).post(`/api/rotations/${g.id}/members`).send({ watchlistEntryId: e2.id });
    expect(r.body.order).toBe(1);
  });

  it('rejects duplicate watchlist entry in same group', async () => {
    const g = await prisma.rotationGroup.create({ data: { name: 'Dup' } });
    const { entry } = await makeShowAndEntry(11);
    await request(app).post(`/api/rotations/${g.id}/members`).send({ watchlistEntryId: entry.id });
    const r = await request(app).post(`/api/rotations/${g.id}/members`).send({ watchlistEntryId: entry.id });
    expect(r.status).toBe(409);
  });
});

describe('PATCH /api/rotations/:id/members/reorder', () => {
  it('reorders by provided member-id list', async () => {
    const g = await prisma.rotationGroup.create({ data: { name: 'Order' } });
    const { entry: e1 } = await makeShowAndEntry(11);
    const { entry: e2 } = await makeShowAndEntry(12);
    const { entry: e3 } = await makeShowAndEntry(13);
    const m1 = await prisma.rotationMember.create({ data: { rotationGroupId: g.id, watchlistEntryId: e1.id, order: 0 } });
    const m2 = await prisma.rotationMember.create({ data: { rotationGroupId: g.id, watchlistEntryId: e2.id, order: 1 } });
    const m3 = await prisma.rotationMember.create({ data: { rotationGroupId: g.id, watchlistEntryId: e3.id, order: 2 } });
    const r = await request(app).patch(`/api/rotations/${g.id}/members/reorder`).send({ memberIds: [m3.id, m1.id, m2.id] });
    expect(r.status).toBe(200);
    const reloaded = await prisma.rotationMember.findMany({ where: { rotationGroupId: g.id }, orderBy: { order: 'asc' } });
    expect(reloaded.map(m => m.id)).toEqual([m3.id, m1.id, m2.id]);
  });
});

describe('DELETE /api/rotations/:id/members/:memberId', () => {
  it('removes the member', async () => {
    const g = await prisma.rotationGroup.create({ data: { name: 'Rm' } });
    const { entry } = await makeShowAndEntry(11);
    const m = await prisma.rotationMember.create({ data: { rotationGroupId: g.id, watchlistEntryId: entry.id, order: 0 } });
    const r = await request(app).delete(`/api/rotations/${g.id}/members/${m.id}`);
    expect(r.status).toBe(204);
    expect(await prisma.rotationMember.count({ where: { rotationGroupId: g.id } })).toBe(0);
  });
});

describe('PUT /api/rotations/:id/days', () => {
  it('replaces the day assignments', async () => {
    const g = await prisma.rotationGroup.create({ data: { name: 'Days' } });
    let r = await request(app).put(`/api/rotations/${g.id}/days`).send({ daysOfWeek: [0, 3] });
    expect(r.status).toBe(200);
    let days = await prisma.rotationDayAssignment.findMany({ where: { rotationGroupId: g.id } });
    expect(days.map(d => d.dayOfWeek).sort()).toEqual([0, 3]);
    r = await request(app).put(`/api/rotations/${g.id}/days`).send({ daysOfWeek: [6] });
    days = await prisma.rotationDayAssignment.findMany({ where: { rotationGroupId: g.id } });
    expect(days.map(d => d.dayOfWeek)).toEqual([6]);
  });
});

describe('POST /api/rotations/:id/members/:memberId/revive', () => {
  it('flips finished=true back to false', async () => {
    const g = await prisma.rotationGroup.create({ data: { name: 'Revive' } });
    const { entry } = await makeShowAndEntry(11);
    const m = await prisma.rotationMember.create({ data: { rotationGroupId: g.id, watchlistEntryId: entry.id, order: 0, finished: true } });
    const r = await request(app).post(`/api/rotations/${g.id}/members/${m.id}/revive`);
    expect(r.status).toBe(200);
    const reloaded = await prisma.rotationMember.findUnique({ where: { id: m.id } });
    expect(reloaded!.finished).toBe(false);
  });
});
