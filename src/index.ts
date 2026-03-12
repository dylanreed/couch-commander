// ABOUTME: Entry point for the Couch Commander Express application.
// ABOUTME: Sets up the server, middleware, routes, and view engine.

import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { getScheduleForDay, generateSchedule, getScheduleLock, shouldRegenerate } from './services/scheduler';
import { prisma } from './lib/db';
import watchlistRoutes from './routes/watchlist';
import settingsRoutes from './routes/settings';
import scheduleRoutes from './routes/schedule';
import showsApiRoutes from './routes/api/shows';
import watchlistApiRoutes from './routes/api/watchlist';
import checkinApiRoutes from './routes/api/checkin';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4242;

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

// API routes
app.use('/api/shows', showsApiRoutes);
app.use('/api/watchlist', watchlistApiRoutes);
app.use('/api/checkin', checkinApiRoutes);

// Page routes
app.use('/watchlist', watchlistRoutes);
app.use('/settings', settingsRoutes);
app.use('/schedule', scheduleRoutes);

// Unauthenticated ping for Docker healthchecks and load balancers
app.get('/ping', (_req, res) => {
  res.json({ status: 'ok' });
});

// Routes
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/', async (_req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (shouldRegenerate(14)) {
      await generateSchedule(today, 14);
    }

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
  } catch (error) {
    console.error('Dashboard error:', error);
    renderWithLayout(res, 'error', { title: 'Error', message: 'Failed to load dashboard' });
  }
});

// Only start the server when run directly, not when imported by tests
if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`Couch Commander running on http://localhost:${PORT}`);
  });

  async function gracefulShutdown(signal: string) {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    server.close(() => {
      console.log('HTTP server closed');
    });
    await getScheduleLock();
    await prisma.$disconnect();
    console.log('Database disconnected');
    process.exit(0);
  }

  function forceShutdown() {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }

  process.on('SIGTERM', () => {
    setTimeout(forceShutdown, 5000).unref();
    gracefulShutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    setTimeout(forceShutdown, 5000).unref();
    gracefulShutdown('SIGINT');
  });
}

export default app;
