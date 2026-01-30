// ABOUTME: Page route for the schedule view.
// ABOUTME: Shows the weekly schedule with episode status.

import { Router, Response } from 'express';
import { generateSchedule, getScheduleForDay } from '../services/scheduler';

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
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Generate schedule for next 7 days
  await generateSchedule(today, 7);

  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() + i);

    const schedule = await getScheduleForDay(date);
    days.push({
      date,
      isToday: i === 0,
      plannedMinutes: schedule?.plannedMinutes || 0,
      episodes: schedule?.episodes || [],
    });
  }

  renderWithLayout(res, 'schedule', {
    title: 'Schedule',
    days,
  });
});

export default router;
