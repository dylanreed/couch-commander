// ABOUTME: Internal JSON API for rotation groups and members.
// ABOUTME: Same auth profile as other internal /api routes (used by the web UI).

import { Router } from 'express';
import { prisma } from '../../lib/db';
import { clearSchedule } from '../../services/scheduler';

const router = Router();

function parseId(id: string): number | null {
  const parsed = parseInt(id, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

router.get('/', async (_req, res) => {
  const groups = await prisma.rotationGroup.findMany({
    include: {
      members: {
        include: { watchlistEntry: { include: { show: true } } },
        orderBy: { order: 'asc' },
      },
      dayAssignments: true,
    },
    orderBy: { id: 'asc' },
  });
  res.json(groups);
});

router.post('/', async (req, res) => {
  const { name, dropOnFinish, active } = req.body ?? {};
  if (typeof name !== 'string' || name.trim() === '') {
    return res.status(400).json({ error: 'name is required' });
  }
  const group = await prisma.rotationGroup.create({
    data: {
      name: name.trim(),
      dropOnFinish: dropOnFinish ?? true,
      active: active ?? true,
    },
  });
  await clearSchedule();
  res.status(201).json(group);
});

router.get('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'bad id' });
  const group = await prisma.rotationGroup.findUnique({
    where: { id },
    include: {
      members: {
        include: { watchlistEntry: { include: { show: true } } },
        orderBy: { order: 'asc' },
      },
      dayAssignments: true,
    },
  });
  if (!group) return res.status(404).json({ error: 'not found' });
  res.json(group);
});

router.patch('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'bad id' });
  const existing = await prisma.rotationGroup.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'not found' });
  const { name, dropOnFinish, active } = req.body ?? {};
  const group = await prisma.rotationGroup.update({
    where: { id },
    data: {
      ...(typeof name === 'string' ? { name: name.trim() } : {}),
      ...(typeof dropOnFinish === 'boolean' ? { dropOnFinish } : {}),
      ...(typeof active === 'boolean' ? { active } : {}),
    },
  });
  await clearSchedule();
  res.json(group);
});

router.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'bad id' });
  const existing = await prisma.rotationGroup.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'not found' });
  await prisma.rotationGroup.delete({ where: { id } });
  await clearSchedule();
  res.status(204).end();
});

router.post('/:id/members', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'bad id' });
  const { watchlistEntryId } = req.body ?? {};
  if (!watchlistEntryId) return res.status(400).json({ error: 'watchlistEntryId required' });
  const group = await prisma.rotationGroup.findUnique({ where: { id }, include: { members: true } });
  if (!group) return res.status(404).json({ error: 'not found' });
  const nextOrder = group.members.length;
  try {
    const member = await prisma.rotationMember.create({
      data: { rotationGroupId: id, watchlistEntryId: Number(watchlistEntryId), order: nextOrder },
    });
    await clearSchedule();
    res.status(201).json(member);
  } catch (err: any) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'already a member' });
    throw err;
  }
});

router.patch('/:id/members/reorder', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'bad id' });
  const { memberIds } = req.body ?? {};
  if (!Array.isArray(memberIds)) return res.status(400).json({ error: 'memberIds array required' });

  // Two-pass update prevents unique-constraint clashes if a constraint is ever added later
  await prisma.$transaction(async (tx) => {
    const tempBase = 10000;
    for (let i = 0; i < memberIds.length; i++) {
      await tx.rotationMember.update({
        where: { id: memberIds[i] },
        data: { order: tempBase + i },
      });
    }
    for (let i = 0; i < memberIds.length; i++) {
      await tx.rotationMember.update({
        where: { id: memberIds[i] },
        data: { order: i },
      });
    }
  });
  await clearSchedule();
  res.json({ ok: true });
});

router.delete('/:id/members/:memberId', async (req, res) => {
  const memberId = parseId(req.params.memberId);
  if (memberId === null) return res.status(400).json({ error: 'bad memberId' });
  const member = await prisma.rotationMember.findUnique({ where: { id: memberId } });
  if (!member) return res.status(404).json({ error: 'not found' });
  await prisma.rotationMember.delete({ where: { id: memberId } });
  await clearSchedule();
  res.status(204).end();
});

router.put('/:id/days', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'bad id' });
  const { daysOfWeek } = req.body ?? {};
  if (!Array.isArray(daysOfWeek) || !daysOfWeek.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) {
    return res.status(400).json({ error: 'daysOfWeek must be array of 0..6' });
  }
  await prisma.$transaction([
    prisma.rotationDayAssignment.deleteMany({ where: { rotationGroupId: id } }),
    ...daysOfWeek.map((d: number) => prisma.rotationDayAssignment.create({ data: { rotationGroupId: id, dayOfWeek: d } })),
  ]);
  await clearSchedule();
  res.json({ ok: true });
});

router.post('/:id/members/:memberId/revive', async (req, res) => {
  const memberId = parseId(req.params.memberId);
  if (memberId === null) return res.status(400).json({ error: 'bad memberId' });
  const member = await prisma.rotationMember.findUnique({ where: { id: memberId } });
  if (!member) return res.status(404).json({ error: 'not found' });
  await prisma.rotationMember.update({ where: { id: memberId }, data: { finished: false } });
  await clearSchedule();
  res.json({ ok: true });
});

export default router;
