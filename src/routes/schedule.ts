// ABOUTME: Page route for the schedule view.
// ABOUTME: Shows the weekly schedule with episode status.

import { Router, Response } from 'express';
import { generateSchedule, getScheduleForDay, shouldRegenerate } from '../services/scheduler';
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

    // Compute overflow: watching shows with day assignments but zero scheduled episodes
    const scheduledShowIds = new Set<number>();
    for (const day of days) {
      for (const ep of day.episodes) {
        scheduledShowIds.add(ep.showId);
      }
    }

    const watchingWithAssignments = await prisma.watchlistEntry.findMany({
      where: {
        status: 'watching',
        dayAssignments: { some: {} },
      },
      include: {
        show: true,
        dayAssignments: true,
      },
    });

    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const overflowShows = watchingWithAssignments
      .filter(entry =>
        !scheduledShowIds.has(entry.showId) &&
        entry.currentEpisode <= entry.show.totalEpisodes
      )
      .map(entry => ({
        ...entry,
        assignedDayNames: entry.dayAssignments.map(a => dayNames[a.dayOfWeek]),
      }));

    renderWithLayout(res, 'schedule', {
      title: 'Schedule',
      days,
      overflowShows,
    });
  } catch (error) {
    console.error('Schedule error:', error);
    renderWithLayout(res, 'error', { title: 'Error', message: 'Failed to load schedule' });
  }
});

export default router;
