// ABOUTME: API route for daily check-in functionality.
// ABOUTME: Marks episodes as watched/skipped and triggers schedule regeneration.

import { Router } from 'express';
import { prisma } from '../../lib/db';
import { clearSchedule } from '../../services/scheduler';

const router = Router();

router.post('/', async (req, res) => {
  const updates: { id: number; status: string }[] = [];

  // Parse form data: ep_123=watched or ep_123=skipped
  for (const [key, value] of Object.entries(req.body)) {
    if (key.startsWith('ep_')) {
      const id = Number(key.replace('ep_', ''));
      updates.push({ id, status: value as string });
    }
  }

  // Update episode statuses
  for (const update of updates) {
    await prisma.scheduledEpisode.update({
      where: { id: update.id },
      data: { status: update.status },
    });
  }

  // Regenerate schedule from today forward
  await clearSchedule();

  res.send('<div class="text-green-400 p-4">Check-in complete! Schedule updated.</div>');
});

export default router;
