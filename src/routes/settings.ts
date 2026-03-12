// ABOUTME: Page route for the settings view.
// ABOUTME: Allows configuring time budgets and scheduling preferences.

import { Router, Response } from 'express';
import { getSettings, updateSettings } from '../services/settings';
import { clearSchedule } from '../services/scheduler';

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
    const settings = await getSettings();

    renderWithLayout(res, 'settings', {
      title: 'Settings',
      settings,
    });
  } catch (error) {
    console.error('Settings page error:', error);
    renderWithLayout(res, 'error', { title: 'Error', message: 'Failed to load settings' });
  }
});

router.post('/', async (req, res) => {
  try {
    const {
      weekdayMinutes,
      weekendMinutes,
      mondayMinutes,
      tuesdayMinutes,
      wednesdayMinutes,
      thursdayMinutes,
      fridayMinutes,
      saturdayMinutes,
      sundayMinutes,
      schedulingMode,
      staggeredStart,
      staggerEpisodes,
    } = req.body;

    await updateSettings({
      weekdayMinutes: Number(weekdayMinutes) || 120,
      weekendMinutes: Number(weekendMinutes) || 240,
      mondayMinutes: mondayMinutes ? Number(mondayMinutes) : null,
      tuesdayMinutes: tuesdayMinutes ? Number(tuesdayMinutes) : null,
      wednesdayMinutes: wednesdayMinutes ? Number(wednesdayMinutes) : null,
      thursdayMinutes: thursdayMinutes ? Number(thursdayMinutes) : null,
      fridayMinutes: fridayMinutes ? Number(fridayMinutes) : null,
      saturdayMinutes: saturdayMinutes ? Number(saturdayMinutes) : null,
      sundayMinutes: sundayMinutes ? Number(sundayMinutes) : null,
      schedulingMode: schedulingMode || 'sequential',
      staggeredStart: staggeredStart === 'true',
      staggerEpisodes: Number(staggerEpisodes) || 3,
    });

    await clearSchedule(); // Force schedule regeneration

    res.status(200).send('');
  } catch (error) {
    console.error('Settings update error:', error);
    renderWithLayout(res, 'error', { title: 'Error', message: 'Failed to update settings' });
  }
});

export default router;
