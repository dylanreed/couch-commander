// ABOUTME: JSON API for app settings endpoints.
// ABOUTME: Day-genre preferences live here; legacy form-based settings
// ABOUTME: continue to live at src/routes/settings.ts.

import { Router } from 'express';
import { setDayGenres } from '../../services/dayGenre';
import { clearSchedule } from '../../services/scheduler';

const router = Router();

router.put('/day-genres', async (req, res) => {
  const { dayOfWeek, genres } = req.body ?? {};
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
    return res.status(400).json({ error: 'dayOfWeek must be an integer 0..6' });
  }
  if (!Array.isArray(genres) || !genres.every((g) => typeof g === 'string')) {
    return res.status(400).json({ error: 'genres must be an array of strings' });
  }
  await setDayGenres(dayOfWeek, genres);
  await clearSchedule();
  res.json({ ok: true });
});

export default router;
