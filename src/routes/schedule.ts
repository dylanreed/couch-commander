// ABOUTME: Page route for the schedule view.
// ABOUTME: Shows the weekly schedule with episode status.

import { Router, Response } from 'express';
import { generateSchedule, getScheduleForDay, shouldRegenerate, markScheduleStale } from '../services/scheduler';
import { getDayCapacity } from '../services/dayAssignment';
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

    // Delete scheduled episodes for future days
    if (futureDayIds.length > 0) {
      await prisma.scheduledEpisode.deleteMany({
        where: { scheduleDayId: { in: futureDayIds } },
      });

      // Delete the future schedule days
      await prisma.scheduleDay.deleteMany({
        where: { id: { in: futureDayIds } },
      });
    }

    // Mark schedule stale so it will be regenerated
    markScheduleStale();

    // Generate a fresh schedule from today
    await generateSchedule(today, 7);

    res.json({ success: true });
  } catch (error) {
    console.error('Schedule regenerate error:', error);
    res.status(500).json({ success: false, error: 'Failed to regenerate schedule' });
  }
});

router.get('/', async (_req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (shouldRegenerate(7)) {
      await generateSchedule(today, 7);
    }

    const days = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() + i);

      const schedule = await getScheduleForDay(date);
      const capacity = await getDayCapacity(date.getDay());
      days.push({
        date,
        isToday: i === 0,
        plannedMinutes: schedule?.plannedMinutes || 0,
        episodes: schedule?.episodes || [],
        capacity,
      });
    }

    renderWithLayout(res, 'schedule', {
      title: 'Schedule',
      days,
    });
  } catch (error) {
    console.error('Schedule error:', error);
    renderWithLayout(res, 'error', { title: 'Error', message: 'Failed to load schedule' });
  }
});

export default router;
