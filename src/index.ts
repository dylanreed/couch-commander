// ABOUTME: Entry point for the Couch Commander Express application.
// ABOUTME: Sets up the server, middleware, routes, and view engine.

import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { getScheduleForDay, generateSchedule } from './services/scheduler';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5055;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Helper to render with layout
function renderWithLayout(
  res: express.Response,
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

// Routes
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/', async (_req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  // Generate schedule if needed
  await generateSchedule(today, 14);

  const todaySchedule = await getScheduleForDay(today);
  const yesterdaySchedule = await getScheduleForDay(yesterday);

  const yesterdayPending = yesterdaySchedule?.episodes.filter(
    (ep) => ep.status === 'pending'
  ) || [];

  renderWithLayout(res, 'dashboard', {
    title: 'Dashboard',
    todayEpisodes: todaySchedule?.episodes || [],
    yesterdayEpisodes: yesterdayPending,
    needsCheckin: yesterdayPending.length > 0,
  });
});

app.listen(PORT, () => {
  console.log(`Couch Commander running on http://localhost:${PORT}`);
});

export default app;
