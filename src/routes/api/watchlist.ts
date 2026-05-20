// ABOUTME: API routes for managing watchlist entries.
// ABOUTME: Handles add, remove, promote, finish, and reorder operations.

import { Router } from 'express';
import { cacheShow } from '../../services/showCache';
import { addToWatchlist, removeFromWatchlist, promoteFromQueue, finishShow, demoteToQueue, checkQueueAvailability } from '../../services/watchlist';
import { clearSchedule } from '../../services/scheduler';
import { setShowDays } from '../../services/dayAssignment';
import { prisma } from '../../lib/db';

const router = Router();

function parseId(id: string): number | null {
  const parsed = parseInt(id, 10);
  return isNaN(parsed) ? null : parsed;
}

router.post('/', async (req, res) => {
  const { tmdbId } = req.body;

  if (!tmdbId) {
    return res.status(400).json({ error: 'tmdbId required' });
  }

  try {
    const show = await cacheShow(Number(tmdbId));
    const entry = await addToWatchlist(show.id);
    await clearSchedule(); // Force regeneration
    res.status(201).json({ success: true, id: entry.id });
  } catch (error: any) {
    console.error('Add to watchlist error:', error);
    if (error.code === 'P2002') {
      res.status(400).json({ error: 'Show is already in your watchlist' });
    } else {
      res.status(500).json({ error: 'Failed to add show' });
    }
  }
});

router.get('/availability', async (req, res) => {
  try {
    const availability = await checkQueueAvailability();
    res.json(availability);
  } catch (error) {
    res.status(500).json({ error: 'Failed to check availability' });
  }
});

function parseEntryIds(body: any): number[] | null {
  if (!body || !Array.isArray(body.entryIds)) return null;
  const ids = body.entryIds.filter((x: unknown) => Number.isInteger(x)) as number[];
  return ids.length === 0 ? null : ids;
}

router.post('/bulk/promote', async (req, res) => {
  const ids = parseEntryIds(req.body);
  if (!ids) return res.status(400).json({ error: 'entryIds must be a non-empty array of integers' });
  const result = await prisma.watchlistEntry.updateMany({
    where: { id: { in: ids } },
    data: { status: 'watching' },
  });
  // Promote = unpinned. We do not create ShowDayAssignment rows.
  await clearSchedule();
  res.json({ promoted: ids, count: result.count });
});

router.post('/bulk/demote', async (req, res) => {
  const ids = parseEntryIds(req.body);
  if (!ids) return res.status(400).json({ error: 'entryIds must be a non-empty array of integers' });
  await prisma.$transaction([
    prisma.showDayAssignment.deleteMany({ where: { watchlistEntryId: { in: ids } } }),
    prisma.watchlistEntry.updateMany({
      where: { id: { in: ids } },
      data: { status: 'queued' },
    }),
  ]);
  await clearSchedule();
  res.json({ demoted: ids });
});

router.post('/bulk/remove', async (req, res) => {
  const ids = parseEntryIds(req.body);
  if (!ids) return res.status(400).json({ error: 'entryIds must be a non-empty array of integers' });
  await prisma.watchlistEntry.deleteMany({ where: { id: { in: ids } } });
  await clearSchedule();
  res.json({ removed: ids });
});

router.post('/bulk/rotation/:rotationId', async (req, res) => {
  const ids = parseEntryIds(req.body);
  if (!ids) return res.status(400).json({ error: 'entryIds must be a non-empty array of integers' });
  const rotationId = parseInt(req.params.rotationId, 10);
  if (Number.isNaN(rotationId)) return res.status(400).json({ error: 'bad rotationId' });

  const existing = await prisma.rotationMember.findMany({
    where: { rotationGroupId: rotationId, watchlistEntryId: { in: ids } },
    select: { watchlistEntryId: true },
  });
  const existingIds = new Set(existing.map((m) => m.watchlistEntryId));
  const toAdd = ids.filter((id) => !existingIds.has(id));
  const skipped = ids.filter((id) => existingIds.has(id));

  if (toAdd.length > 0) {
    const baseOrder = await prisma.rotationMember.count({ where: { rotationGroupId: rotationId } });
    await prisma.$transaction(
      toAdd.map((entryId, i) =>
        prisma.rotationMember.create({
          data: { rotationGroupId: rotationId, watchlistEntryId: entryId, order: baseOrder + i },
        })
      )
    );
    await clearSchedule();
  }

  res.json({ added: toAdd, skipped });
});

router.delete('/:id', async (req, res) => {
  const parsedId = parseId(req.params.id);
  if (parsedId === null) {
    return res.status(400).json({ error: 'invalid id' });
  }

  try {
    await removeFromWatchlist(parsedId);
    await clearSchedule();
    res.send(''); // htmx expects empty response for swap
  } catch (error) {
    console.error('Remove from watchlist error:', error);
    res.status(500).json({ error: 'Failed to remove show' });
  }
});

router.post('/:id/promote', async (req, res) => {
  const parsedId = parseId(req.params.id);
  if (parsedId === null) {
    return res.status(400).json({ error: 'invalid id' });
  }

  try {
    const entry = await promoteFromQueue(parsedId);
    res.status(200).json(entry);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

router.post('/:id/finish', async (req, res) => {
  const parsedId = parseId(req.params.id);
  if (parsedId === null) {
    return res.status(400).json({ error: 'invalid id' });
  }

  try {
    const result = await finishShow(parsedId);
    res.status(200).json(result);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

router.post('/:id/demote', async (req, res) => {
  const parsedId = parseId(req.params.id);
  if (parsedId === null) {
    return res.status(400).json({ error: 'invalid id' });
  }

  try {
    const entry = await demoteToQueue(parsedId);
    await clearSchedule();
    res.status(200).json(entry);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

router.put('/:id/days', async (req, res) => {
  const parsedId = parseId(req.params.id);
  if (parsedId === null) {
    return res.status(400).json({ error: 'invalid id' });
  }

  const { days } = req.body;

  if (!Array.isArray(days)) {
    return res.status(400).json({ error: 'days must be an array' });
  }

  // Validate all days are integers 0-6
  const hasInvalid = days.some((d: any) => typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 6);
  if (hasInvalid) {
    return res.status(400).json({ error: 'days must be integers between 0 and 6' });
  }

  try {
    const assignments = await setShowDays(parsedId, days);
    await clearSchedule(); // Force regeneration
    res.status(200).json({ success: true, assignments });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

router.put('/:id/episode', async (req, res) => {
  const parsedId = parseId(req.params.id);
  if (parsedId === null) {
    return res.status(400).json({ error: 'invalid id' });
  }

  const { season, episode } = req.body;

  console.log('Episode update request:', { id: parsedId, season, episode, body: req.body });

  const seasonNum = Number(season);
  const episodeNum = Number(episode);

  if (isNaN(seasonNum) || isNaN(episodeNum) || seasonNum < 1 || episodeNum < 1) {
    return res.status(400).json({ error: 'Invalid season or episode number' });
  }

  try {
    const entry = await prisma.watchlistEntry.update({
      where: { id: parsedId },
      data: {
        currentSeason: seasonNum,
        currentEpisode: episodeNum,
      },
      include: { show: true },
    });
    console.log('Updated entry:', entry.id, 'to S' + entry.currentSeason + 'E' + entry.currentEpisode);
    await clearSchedule();
    res.status(200).json(entry);
  } catch (error) {
    console.error('Episode update error:', error);
    res.status(400).json({ error: (error as Error).message });
  }
});

export default router;
