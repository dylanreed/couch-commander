// ABOUTME: Page route for the watchlist view.
// ABOUTME: Displays watching shows and queue with management options.

import { Router, Response } from 'express';
import { prisma } from '../lib/db';

const router = Router();

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
  try {
    const watching = await prisma.watchlistEntry.findMany({
      where: { status: 'watching' },
      include: {
        show: true,
        dayAssignments: true,
        rotationMembers: { include: { rotationGroup: true } },
      },
      orderBy: { priority: 'asc' },
    });

    // Hide queued entries that are already being scheduled via an active
    // rotation — they'd otherwise double-list as both "Queue" and a
    // rotation pick on the schedule.
    const queued = await prisma.watchlistEntry.findMany({
      where: {
        status: 'queued',
        NOT: {
          rotationMembers: { some: { rotationGroup: { active: true } } },
        },
      },
      include: { show: true },
      orderBy: { priority: 'asc' },
    });

    const rotations = await prisma.rotationGroup.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, name: true, active: true },
    });

    renderWithLayout(res, 'watchlist', {
      title: 'Watchlist',
      watching,
      queued,
      rotations,
    });
  } catch (error) {
    console.error('Watchlist page error:', error);
    renderWithLayout(res, 'error', { title: 'Error', message: 'Failed to load watchlist' });
  }
});

export default router;
