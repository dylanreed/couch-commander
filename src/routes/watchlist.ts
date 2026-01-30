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
  const watching = await prisma.watchlistEntry.findMany({
    where: { status: 'watching' },
    include: { show: true, dayAssignments: true },
    orderBy: { priority: 'asc' },
  });

  const queued = await prisma.watchlistEntry.findMany({
    where: { status: 'queued' },
    include: { show: true },
    orderBy: { priority: 'asc' },
  });

  renderWithLayout(res, 'watchlist', {
    title: 'Watchlist',
    watching,
    queued,
  });
});

export default router;
