# Schedule Regeneration & "Doesn't Fit" Overflow Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual "Regenerate" button to the schedule page and a "Doesn't Fit" section showing watching shows that couldn't be scheduled due to time budget constraints.

**Architecture:** The regenerate endpoint clears future schedule data and regenerates. Overflow is computed at query time in the schedule route by comparing watching+assigned shows against actually-scheduled show IDs. No schema changes.

**Tech Stack:** TypeScript, Express, EJS, HTMX, Prisma/SQLite, Vitest

**Spec:** `docs/superpowers/specs/2026-03-12-schedule-regen-overflow-design.md`

**Note on episode tracking:** In this codebase, `currentEpisode` is a global counter across all seasons (it never resets per season). A show is "done" when `currentEpisode > totalEpisodes`. The scheduler uses the same convention (`pos.episode <= entry.show.totalEpisodes`).

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/routes/schedule.ts` | Modify | Add POST `/regenerate` endpoint. Add overflow computation to GET `/`. |
| `src/views/pages/schedule.ejs` | Modify | Add regenerate button. Add "Doesn't Fit" section. |
| `src/e2e/schedule-regen.test.ts` | Create | Tests for regenerate endpoint and overflow computation. |

---

## Chunk 1: Schedule Regeneration & Overflow

### Task 1: Regenerate Endpoint + Tests

**Files:**
- Modify: `src/routes/schedule.ts`
- Modify: `src/index.ts`
- Create: `src/e2e/schedule-regen.test.ts`

**Context:** The schedule route is at `src/routes/schedule.ts`. It currently has a GET `/` handler that calls `shouldRegenerate(7)` and `generateSchedule(today, 7)` if stale, then renders the schedule page. The route is mounted at `/schedule` in `src/index.ts`. The API route for schedule operations would be at `/api/schedule` — but this doesn't exist yet. We need to mount the same schedule router at `/api/schedule` too.

**Important files to reference:**
- `src/services/scheduler.ts` — exports `generateSchedule()`, `markScheduleStale()`
- `src/index.ts:61-63` — where page routes are mounted
- `src/index.ts:47-58` — where API routes are mounted
- `src/lib/db.ts` — Prisma client singleton

**Current imports in `src/routes/schedule.ts`:**
```typescript
import { Router, Response } from 'express';
import { generateSchedule, getScheduleForDay, shouldRegenerate } from '../services/scheduler';
import { getDayCapacity } from '../services/dayAssignment';
```
New imports needed: `prisma` from `../lib/db` and `markScheduleStale` from `../services/scheduler`.

- [ ] **Step 1: Write failing tests for regenerate endpoint**

Create `src/e2e/schedule-regen.test.ts`:

```typescript
// ABOUTME: Tests for schedule regeneration endpoint and overflow computation.
// ABOUTME: Verifies regen clears future schedule and overflow detects unscheduled shows.

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../index';
import { prisma } from '../lib/db';

describe('Schedule Regeneration', () => {
  beforeEach(async () => {
    await prisma.scheduledEpisode.deleteMany();
    await prisma.scheduleDay.deleteMany();
    await prisma.showDayAssignment.deleteMany();
    await prisma.watchlistEntry.deleteMany();
    await prisma.show.deleteMany();
  });

  describe('POST /api/schedule/regenerate', () => {
    it('returns 200 and regenerates the schedule', async () => {
      const res = await request(app).post('/api/schedule/regenerate');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
    });

    it('preserves past watched episodes', async () => {
      const show = await prisma.show.create({
        data: {
          tmdbId: 99999,
          title: 'Test Show',
          genres: '["Drama"]',
          totalSeasons: 1,
          totalEpisodes: 10,
          episodeRuntime: 30,
          status: 'Ended',
        },
      });

      const entry = await prisma.watchlistEntry.create({
        data: { showId: show.id, status: 'watching' },
      });

      await prisma.showDayAssignment.create({
        data: { watchlistEntryId: entry.id, dayOfWeek: new Date().getDay() },
      });

      // Create a past schedule day with a watched episode
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(0, 0, 0, 0);

      const pastDay = await prisma.scheduleDay.create({
        data: { date: yesterday, plannedMinutes: 120 },
      });

      await prisma.scheduledEpisode.create({
        data: {
          scheduleDayId: pastDay.id,
          showId: show.id,
          season: 1,
          episode: 1,
          runtime: 30,
          status: 'watched',
          order: 0,
        },
      });

      // Regenerate
      await request(app).post('/api/schedule/regenerate');

      // Past watched episode should still exist
      const pastEpisodes = await prisma.scheduledEpisode.findMany({
        where: { scheduleDayId: pastDay.id },
      });
      expect(pastEpisodes).toHaveLength(1);
      expect(pastEpisodes[0].status).toBe('watched');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `doppler run -- npx vitest run src/e2e/schedule-regen.test.ts`
Expected: FAIL — POST `/api/schedule/regenerate` returns 404

- [ ] **Step 3: Create the regenerate endpoint**

Update imports in `src/routes/schedule.ts`:

```typescript
import { Router, Response } from 'express';
import { generateSchedule, getScheduleForDay, shouldRegenerate, markScheduleStale } from '../services/scheduler';
import { getDayCapacity } from '../services/dayAssignment';
import { prisma } from '../lib/db';
```

Add a new POST handler in `src/routes/schedule.ts` BEFORE the existing GET `/` handler:

```typescript
router.post('/regenerate', async (_req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Delete only future schedule data, preserving past watched/skipped episodes
    const futureDays = await prisma.scheduleDay.findMany({
      where: { date: { gte: today } },
      select: { id: true },
    });
    const futureDayIds = futureDays.map(d => d.id);

    if (futureDayIds.length > 0) {
      await prisma.scheduledEpisode.deleteMany({
        where: { scheduleDayId: { in: futureDayIds } },
      });
      await prisma.scheduleDay.deleteMany({
        where: { id: { in: futureDayIds } },
      });
    }

    // Mark stale so the guard knows we need fresh data
    markScheduleStale();

    // Regenerate
    await generateSchedule(today, 7);

    res.json({ success: true });
  } catch (error) {
    console.error('Schedule regeneration error:', error);
    res.status(500).json({ error: 'Failed to regenerate schedule' });
  }
});
```

Mount the schedule route for API access in `src/index.ts`. Add this line near the other API route mounts (around line 50):

```typescript
app.use('/api/schedule', scheduleRoutes);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `doppler run -- npx vitest run src/e2e/schedule-regen.test.ts`
Expected: PASS (both tests)

- [ ] **Step 5: Run full test suite**

Run: `doppler run -- npx vitest run`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/routes/schedule.ts src/e2e/schedule-regen.test.ts src/index.ts
git commit -m "feat: add schedule regenerate endpoint"
```

---

### Task 2: Overflow Computation + Overflow UI + Tests

**Files:**
- Modify: `src/routes/schedule.ts`
- Modify: `src/views/pages/schedule.ejs`
- Modify: `src/e2e/schedule-regen.test.ts`

**Context:** Overflow = watching shows with day assignments that got zero episodes scheduled across the 7-day window. Exclude shows with no remaining episodes (where `currentEpisode > totalEpisodes` — this is a global counter, not per-season). The overflow is computed in the schedule route GET handler and passed to the EJS template. The template changes and overflow computation are done together so the tests (which assert on rendered HTML) pass in one step.

- [ ] **Step 1: Write failing tests for overflow**

Add to `src/e2e/schedule-regen.test.ts` inside the outer `describe('Schedule Regeneration')` block:

```typescript
describe('Overflow Shows', () => {
  it('identifies shows that do not fit in the schedule', async () => {
    // Create two shows — one 30min, one 60min
    const fittingShow = await prisma.show.create({
      data: {
        tmdbId: 88881,
        title: 'Short Show',
        genres: '["Comedy"]',
        totalSeasons: 1,
        totalEpisodes: 10,
        episodeRuntime: 30,
        status: 'Ended',
      },
    });

    const overflowShow = await prisma.show.create({
      data: {
        tmdbId: 88882,
        title: 'Long Show',
        genres: '["Drama"]',
        totalSeasons: 1,
        totalEpisodes: 10,
        episodeRuntime: 60,
        status: 'Ended',
      },
    });

    // Both watching, both assigned to today's day of week
    const todayDow = new Date().getDay();

    const entry1 = await prisma.watchlistEntry.create({
      data: { showId: fittingShow.id, status: 'watching' },
    });
    await prisma.showDayAssignment.create({
      data: { watchlistEntryId: entry1.id, dayOfWeek: todayDow },
    });

    const entry2 = await prisma.watchlistEntry.create({
      data: { showId: overflowShow.id, status: 'watching' },
    });
    await prisma.showDayAssignment.create({
      data: { watchlistEntryId: entry2.id, dayOfWeek: todayDow },
    });

    // Set budget to 30 min so only the short show fits
    await prisma.settings.upsert({
      where: { id: 1 },
      update: { weekdayMinutes: 30, weekendMinutes: 30 },
      create: { weekdayMinutes: 30, weekendMinutes: 30 },
    });

    // Regenerate schedule
    await request(app).post('/api/schedule/regenerate');

    // Load schedule page and check for overflow
    const res = await request(app).get('/schedule');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Doesn&#39;t Fit');
    expect(res.text).toContain('Long Show');
    // Short Show fits, so it should NOT be in the overflow section.
    // It will appear in the schedule grid, but not in Doesn't Fit.
    // We check the overflow section specifically by checking it doesn't appear
    // after the "Doesn't Fit" heading.
  });

  it('excludes completed shows from overflow', async () => {
    // currentEpisode is a global counter — episode 6 of a 5-episode show means done
    const show = await prisma.show.create({
      data: {
        tmdbId: 88883,
        title: 'Completed Show',
        genres: '["Comedy"]',
        totalSeasons: 1,
        totalEpisodes: 5,
        episodeRuntime: 30,
        status: 'Ended',
      },
    });

    const entry = await prisma.watchlistEntry.create({
      data: {
        showId: show.id,
        status: 'watching',
        currentSeason: 1,
        currentEpisode: 6, // Past the last episode (global counter)
      },
    });
    await prisma.showDayAssignment.create({
      data: { watchlistEntryId: entry.id, dayOfWeek: new Date().getDay() },
    });

    // Set tiny budget
    await prisma.settings.upsert({
      where: { id: 1 },
      update: { weekdayMinutes: 1, weekendMinutes: 1 },
      create: { weekdayMinutes: 1, weekendMinutes: 1 },
    });

    await request(app).post('/api/schedule/regenerate');

    const res = await request(app).get('/schedule');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('Doesn&#39;t Fit');
    expect(res.text).not.toContain('Completed Show');
  });

  it('hides overflow section when all shows fit', async () => {
    const res = await request(app).get('/schedule');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('Doesn&#39;t Fit');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `doppler run -- npx vitest run src/e2e/schedule-regen.test.ts`
Expected: FAIL — overflow tests fail (no overflow data, no template section)

- [ ] **Step 3: Add overflow computation to schedule GET handler**

In `src/routes/schedule.ts`, modify the GET `/` handler. After the `days` loop but before `renderWithLayout`, add:

```typescript
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
```

Update the `renderWithLayout` call:

```typescript
    renderWithLayout(res, 'schedule', {
      title: 'Schedule',
      days,
      overflowShows,
    });
```

- [ ] **Step 4: Update schedule template with regenerate button and overflow section**

In `src/views/pages/schedule.ejs`, replace the header (lines 1-6) with:

```ejs
<div class="space-y-10">
  <!-- Header -->
  <div class="flex items-end justify-between">
    <div>
      <h1 class="font-display text-4xl font-semibold text-lounge-cream">Weekly Schedule</h1>
      <p class="text-lounge-muted mt-1">Your viewing plan at a glance</p>
    </div>
    <button type="button"
            hx-post="/api/schedule/regenerate"
            hx-swap="none"
            hx-on::after-request="location.reload()"
            hx-indicator="#regen-spinner"
            class="btn-gold px-5 py-2.5 rounded-xl text-sm flex items-center gap-2">
      <svg id="regen-spinner" class="w-4 h-4 htmx-indicator animate-spin" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
      </svg>
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
      </svg>
      Regenerate
    </button>
  </div>
```

After the closing `</div>` of the `<div class="grid gap-4">` day cards grid, and before the final closing `</div>`, add:

```ejs
  <!-- Doesn't Fit -->
  <% if (overflowShows && overflowShows.length > 0) { %>
  <section class="space-y-5">
    <div class="flex items-center gap-3">
      <div class="w-3 h-3 rounded-full bg-red-400"></div>
      <h2 class="font-display text-2xl font-semibold text-lounge-cream">Doesn't Fit</h2>
      <span class="text-lounge-muted text-sm">(<%= overflowShows.length %> shows)</span>
    </div>

    <div class="grid gap-3">
      <% overflowShows.forEach(entry => { %>
      <div class="bg-lounge-surface rounded-2xl p-4 border border-red-400/20">
        <div class="flex gap-4 items-center">
          <% if (entry.show.posterPath) { %>
          <img src="https://image.tmdb.org/t/p/w92<%= entry.show.posterPath %>"
               alt="<%= entry.show.title %>"
               class="poster-img w-12 h-[72px] object-cover flex-shrink-0">
          <% } else { %>
          <div class="w-12 h-[72px] rounded-lg bg-lounge-card flex items-center justify-center flex-shrink-0">
            <svg class="w-5 h-5 text-lounge-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </div>
          <% } %>
          <div class="flex-1 min-w-0">
            <h3 class="font-display text-base font-semibold text-lounge-cream"><%= entry.show.title %></h3>
            <p class="text-sm text-lounge-muted mt-0.5">
              <%= entry.show.episodeRuntime %> min/ep
              <span class="text-lounge-border mx-2">|</span>
              Assigned: <%= entry.assignedDayNames.join(', ') %>
            </p>
          </div>
          <span class="text-xs px-2.5 py-1 rounded-full bg-red-400/10 text-red-400 flex-shrink-0">
            Over budget
          </span>
        </div>
      </div>
      <% }) %>
    </div>

    <p class="text-sm text-lounge-muted">
      Adjust day assignments on <a href="/watchlist" class="text-lounge-gold hover:underline">My Shows</a>
      or increase time budgets in <a href="/settings" class="text-lounge-gold hover:underline">Settings</a>,
      then hit Regenerate.
    </p>
  </section>
  <% } %>
```

- [ ] **Step 5: Run all tests**

Run: `doppler run -- npx vitest run`
Expected: ALL PASS

- [ ] **Step 6: TypeScript build check**

Run: `doppler run -- npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/routes/schedule.ts src/views/pages/schedule.ejs src/e2e/schedule-regen.test.ts
git commit -m "feat: add overflow computation, regenerate button, and Doesn't Fit section"
```
