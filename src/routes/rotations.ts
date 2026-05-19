// ABOUTME: HTML page routes for managing rotation groups.
// ABOUTME: List, new, and edit views; form-submit handlers post back here.

import { Router, Response } from 'express';
import { prisma } from '../lib/db';
import { clearSchedule } from '../services/scheduler';

const router = Router();

function parseId(id: string): number | null {
  const parsed = parseInt(id, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function renderWithLayout(
  res: Response,
  page: string,
  data: Record<string, unknown>
) {
  res.render(`pages/${page}`, data, (err, body) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Error rendering page');
    }
    res.render('layouts/main', { ...data, body });
  });
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
  renderWithLayout(res, 'rotations/index', { title: 'Rotations', groups });
});

router.get('/new', (_req, res) => {
  renderWithLayout(res, 'rotations/edit', {
    title: 'New rotation',
    group: null,
    members: [],
    days: [],
    allEntries: [],
  });
});

router.post('/', async (req, res) => {
  const { name } = req.body ?? {};
  if (typeof name !== 'string' || name.trim() === '') {
    return res.status(400).send('name required');
  }
  const group = await prisma.rotationGroup.create({ data: { name: name.trim() } });
  await clearSchedule();
  res.redirect(`/rotations/${group.id}`);
});

router.get('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(404).send('not found');
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
  if (!group) return res.status(404).send('not found');
  const allEntries = await prisma.watchlistEntry.findMany({
    where: { active: true },
    include: { show: true },
    orderBy: { show: { title: 'asc' } },
  });
  renderWithLayout(res, 'rotations/edit', {
    title: group.name,
    group,
    members: group.members,
    days: group.dayAssignments.map((d) => d.dayOfWeek),
    allEntries,
  });
});

router.post('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(404).send('not found');
  const { name, dropOnFinish, active } = req.body ?? {};
  await prisma.rotationGroup.update({
    where: { id },
    data: {
      ...(typeof name === 'string' && name.trim() !== '' ? { name: name.trim() } : {}),
      dropOnFinish: dropOnFinish === 'on' || dropOnFinish === 'true',
      active: active === 'on' || active === 'true',
    },
  });
  await clearSchedule();
  res.redirect(`/rotations/${id}`);
});

router.post('/:id/delete', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(404).send('not found');
  await prisma.rotationGroup.delete({ where: { id } });
  await clearSchedule();
  res.redirect('/rotations');
});

export default router;
