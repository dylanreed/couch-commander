// ABOUTME: API route for schedule management actions (regenerate, etc.).
// ABOUTME: Handles POST /api/schedule/regenerate to clear and rebuild the schedule.

import { Router } from 'express';
import { generateSchedule, markScheduleStale } from '../../services/scheduler';
import { prisma } from '../../lib/db';

const router = Router();

router.post('/regenerate', async (_req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Find all future schedule days (today and beyond)
    const futureDays = await prisma.scheduleDay.findMany({
      where: { date: { gte: today } },
      select: { id: true },
    });

    const futureDayIds = futureDays.map((d) => d.id);

    // NOTE: This delete + generate sequence is not wrapped in a transaction.
    // That is acceptable because regeneration is idempotent — if it fails partway
    // through, the next page load will trigger auto-regen via shouldRegenerate().
    if (futureDayIds.length > 0) {
      await prisma.scheduledEpisode.deleteMany({
        where: { scheduleDayId: { in: futureDayIds } },
      });

      await prisma.scheduleDay.deleteMany({
        where: { id: { in: futureDayIds } },
      });
    }

    // generateSchedule handles marking the schedule as generated internally,
    // so markScheduleStale() is not needed here.
    await generateSchedule(today, 7);

    res.json({ success: true });
  } catch (error) {
    console.error('Schedule regenerate error:', error);
    res.status(500).json({ success: false, error: 'Failed to regenerate schedule' });
  }
});

export default router;
