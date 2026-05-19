# Watchlist bulk actions + genre-driven scheduling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-section multi-select bulk actions to the watchlist, render TMDB genres as chips on show cards across the app, and introduce a genre-day affinity model so unpinned shows get placed by the scheduler each regen on days whose theme matches their genres.

**Architecture:** Three parallel feature surfaces sharing one mental model — "shows organize across the week." Schema gains a `DayGenrePreference` table (many genres per day). Promote stops auto-pinning shows to days; the scheduler grows a second placement pass that scores unpinned shows by genre overlap and remaining capacity. The watchlist page grows per-section checkboxes and sticky bulk-action bars. The settings page grows a "Day themes" picker. TMDB genres already on `Show.genres` get surfaced as chips.

**Tech Stack:** TypeScript / Node.js / Express / EJS / Prisma / SQLite, Vitest + supertest for tests, Tailwind for chip styling, htmx + plain `fetch()` for inline page interactions.

**Spec:** `docs/superpowers/specs/2026-05-19-watchlist-bulk-and-genre-scheduling-design.md`

---

## File map

**New files**
- `src/services/dayGenre.ts` — CRUD for `DayGenrePreference` + the affinity scoring helper used by the scheduler.
- `src/services/dayGenre.test.ts` — unit tests for the service.
- `src/routes/api/settings.ts` — JSON API for the new `PUT /api/settings/day-genres` endpoint.
- `src/routes/api/settings.test.ts` — supertest coverage for the new endpoint.
- `src/e2e/genre-affinity-flow.test.ts` — full flow: set Tuesday theme, promote a comedy, regen, assert placement.
- `src/views/partials/genre-chips.ejs` — small EJS partial rendering a row of genre chips for a show.

**Modified files**
- `prisma/schema.prisma` — add `DayGenrePreference` model; drop `Settings.genreRules`; trim the `schedulingMode` comment.
- `src/services/settings.ts` — drop `GenreRule`, `getGenreRules`, `updateGenreRules`.
- `src/services/dayAssignment.ts` — delete `findBestDayForShow`, `getDayGenres`, and the variety-bonus block.
- `src/services/watchlist.ts` — `promoteFromQueue` stops calling `findBestDayForShow` and stops creating `ShowDayAssignment` rows.
- `src/services/watchlist.test.ts` — update existing tests that assert auto-day-assignment on promote.
- `src/services/scheduler.ts` — add Pass 2 (unpinned-show placement) after the existing per-day fill loop.
- `src/services/scheduler.test.ts` — extend with unpinned-placement tests.
- `src/routes/api/watchlist.ts` — add four `/bulk/*` endpoints.
- `src/routes/api/watchlist.test.ts` — supertest coverage for the four bulk endpoints.
- `src/index.ts` — mount the new `routes/api/settings` router.
- `src/views/pages/watchlist.ejs` — checkboxes per row, per-section action bars, JS for bulk operations, genre chips.
- `src/views/pages/settings.ejs` — new "Day themes" section + JS for toggling chips.
- `src/views/pages/schedule.ejs` — genre chips next to episode titles.
- `src/views/pages/dashboard.ejs` — genre chips next to tonight's episodes.
- `src/views/pages/rotations/edit.ejs` — genre chips next to each rotation member.
- `src/views/layouts/main.ejs` — `.genre-chip` CSS class added to the `<style>` block.

---

## Task ordering

1. Schema migration
2. Settings service cleanup
3. `dayGenre` service
4. Day-genre API endpoint
5. Settings page "Day themes" UI
6. Genre chips: CSS + partial + render across views
7. Bulk watchlist API endpoints
8. Watchlist UI: per-section checkboxes + sticky action bars + bulk JS
9. `promoteFromQueue` unpinned + cleanup of `dayAssignment` helpers
10. Scheduler Pass 2 (unpinned-show placement)
11. End-to-end genre-affinity test

Each task is self-contained — tests pass after each commit before the next task begins.

---

## Task 1: Schema migration — add `DayGenrePreference`, drop `Settings.genreRules`

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Edit the schema**

In `prisma/schema.prisma`, locate the `Settings` model and remove this line:

```prisma
  genreRules          String  @default("[]") // JSON array of rules
```

Then trim the `schedulingMode` comment from:

```prisma
  schedulingMode      String  @default("sequential") // "sequential", "roundrobin", "genre"
```

to:

```prisma
  schedulingMode      String  @default("sequential") // "sequential", "roundrobin"
```

At the bottom of the file (after `RotationDayAssignment`), add the new model:

```prisma
model DayGenrePreference {
  id        Int    @id @default(autoincrement())
  dayOfWeek Int    // 0=Sunday, 1=Monday, ... 6=Saturday
  genre     String
  createdAt DateTime @default(now())

  @@unique([dayOfWeek, genre])
  @@index([dayOfWeek])
}
```

- [ ] **Step 2: Push the schema to the dev database**

Run: `npm run db:push`
Expected: `Your database is now in sync with your Prisma schema.` and the Prisma client regenerates without error. If Prisma asks about data loss for `genreRules`, accept (the field is empty across all environments).

If the prompt blocks the command, run: `npx prisma db push --accept-data-loss`

- [ ] **Step 3: Verify the Prisma client has the new model**

Run: `node -e "const {PrismaClient} = require('@prisma/client'); const p = new PrismaClient(); console.log(typeof p.dayGenrePreference.findMany);"`
Expected: prints `function` (the model is on the client).

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(schema): add DayGenrePreference, drop unused Settings.genreRules"
```

---

## Task 2: Settings service cleanup

**Files:**
- Modify: `src/services/settings.ts`
- Modify: `src/views/pages/settings.ejs:84` (remove stale TODO comment)

- [ ] **Step 1: Strip `GenreRule` from `src/services/settings.ts`**

Remove these lines (they reference the dropped `genreRules` column):

```typescript
export interface GenreRule {
  genre: string;
  allowedDays: number[]; // 0-6, Sunday-Saturday
  blocked: boolean;
}

export async function getGenreRules(): Promise<GenreRule[]> {
  const settings = await getSettings();
  return JSON.parse(settings.genreRules);
}

export async function updateGenreRules(rules: GenreRule[]): Promise<Settings> {
  return updateSettings({ genreRules: JSON.stringify(rules) });
}
```

If the file's ABOUTME comment mentions "genre rules", soften it to just "Handles time budgets and scheduling modes."

- [ ] **Step 2: Remove the stale TODO from settings.ejs**

In `src/views/pages/settings.ejs:84`, delete the line:

```html
        <%# TODO: Re-add genre mode as "assigning genres for a day of the week" once backend implementation exists %>
```

(It's superseded by the new Day themes UI added in Task 5.)

- [ ] **Step 3: Verify nothing else references the removed symbols**

Run: `grep -rn "genreRules\|GenreRule\|getGenreRules\|updateGenreRules" src/`
Expected: zero matches.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/settings.ts src/views/pages/settings.ejs
git commit -m "refactor(settings): drop unused GenreRule API"
```

---

## Task 3: `dayGenre` service — CRUD + scoring helper

**Files:**
- Create: `src/services/dayGenre.ts`
- Create: `src/services/dayGenre.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/services/dayGenre.test.ts`:

```typescript
// ABOUTME: Tests for the day-genre preference service.
// ABOUTME: Covers CRUD + affinity scoring used by the scheduler.

import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../lib/db';
import {
  getDayGenres,
  getAllDayGenres,
  setDayGenres,
  scoreDayForShow,
} from './dayGenre';

describe('dayGenre service', () => {
  beforeEach(async () => {
    await prisma.dayGenrePreference.deleteMany();
  });

  describe('setDayGenres + getDayGenres', () => {
    it('persists a set of genres for a day', async () => {
      await setDayGenres(2, ['Comedy', 'Family']);
      const result = await getDayGenres(2);
      expect(result.sort()).toEqual(['Comedy', 'Family']);
    });

    it('replaces previous genres on subsequent set', async () => {
      await setDayGenres(2, ['Comedy', 'Family']);
      await setDayGenres(2, ['Drama']);
      const result = await getDayGenres(2);
      expect(result).toEqual(['Drama']);
    });

    it('clears the day when given an empty array', async () => {
      await setDayGenres(2, ['Comedy']);
      await setDayGenres(2, []);
      const result = await getDayGenres(2);
      expect(result).toEqual([]);
    });
  });

  describe('getAllDayGenres', () => {
    it('returns a 7-element array keyed by day-of-week', async () => {
      await setDayGenres(0, ['Drama']);
      await setDayGenres(2, ['Comedy', 'Family']);
      const all = await getAllDayGenres();
      expect(all).toHaveLength(7);
      expect(all[0].sort()).toEqual(['Drama']);
      expect(all[1]).toEqual([]);
      expect(all[2].sort()).toEqual(['Comedy', 'Family']);
    });
  });

  describe('scoreDayForShow', () => {
    it('adds 1000 per overlapping genre', async () => {
      await setDayGenres(2, ['Comedy', 'Family']);
      const score = await scoreDayForShow(2, ['Comedy', 'Family', 'Drama'], 60);
      // 2 overlaps * 1000 + 60 capacity = 2060
      expect(score).toBe(2060);
    });

    it('returns just remaining capacity when no genre overlaps', async () => {
      await setDayGenres(2, ['Drama']);
      const score = await scoreDayForShow(2, ['Comedy'], 75);
      expect(score).toBe(75);
    });

    it('returns just remaining capacity when day has no preferences', async () => {
      const score = await scoreDayForShow(3, ['Comedy', 'Drama'], 45);
      expect(score).toBe(45);
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/services/dayGenre.test.ts`
Expected: `Cannot find module './dayGenre'` errors.

- [ ] **Step 3: Implement the service**

Create `src/services/dayGenre.ts`:

```typescript
// ABOUTME: CRUD + scoring for day-of-week genre preferences.
// ABOUTME: Used by the scheduler to bias unpinned-show placement.

import { prisma } from '../lib/db';

const GENRE_MATCH_WEIGHT = 1000;

export async function getDayGenres(dayOfWeek: number): Promise<string[]> {
  const rows = await prisma.dayGenrePreference.findMany({
    where: { dayOfWeek },
    select: { genre: true },
  });
  return rows.map((r) => r.genre);
}

export async function getAllDayGenres(): Promise<string[][]> {
  const rows = await prisma.dayGenrePreference.findMany({
    select: { dayOfWeek: true, genre: true },
  });
  const buckets: string[][] = [[], [], [], [], [], [], []];
  for (const r of rows) buckets[r.dayOfWeek].push(r.genre);
  return buckets;
}

export async function setDayGenres(dayOfWeek: number, genres: string[]): Promise<void> {
  await prisma.$transaction([
    prisma.dayGenrePreference.deleteMany({ where: { dayOfWeek } }),
    ...genres.map((g) =>
      prisma.dayGenrePreference.create({ data: { dayOfWeek, genre: g } })
    ),
  ]);
}

/**
 * Score a day for placing an unpinned show. Higher is better. The day must
 * already be known to have enough capacity for one episode — the caller
 * filters those out.
 */
export async function scoreDayForShow(
  dayOfWeek: number,
  showGenres: string[],
  remainingMinutes: number
): Promise<number> {
  const dayGenres = await getDayGenres(dayOfWeek);
  const overlap = showGenres.filter((g) => dayGenres.includes(g)).length;
  return overlap * GENRE_MATCH_WEIGHT + remainingMinutes;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/services/dayGenre.test.ts`
Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/dayGenre.ts src/services/dayGenre.test.ts
git commit -m "feat(dayGenre): service for day-of-week genre preferences"
```

---

## Task 4: Day-genre API endpoint

**Files:**
- Create: `src/routes/api/settings.ts`
- Create: `src/routes/api/settings.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/routes/api/settings.test.ts`:

```typescript
// ABOUTME: Supertest coverage for the settings JSON API.
// ABOUTME: Currently covers PUT /api/settings/day-genres.

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../index';
import { prisma } from '../../lib/db';
import { getDayGenres } from '../../services/dayGenre';

describe('Settings API', () => {
  beforeEach(async () => {
    await prisma.dayGenrePreference.deleteMany();
  });

  describe('PUT /api/settings/day-genres', () => {
    it('replaces genres for the given day', async () => {
      const r = await request(app)
        .put('/api/settings/day-genres')
        .send({ dayOfWeek: 2, genres: ['Comedy', 'Family'] });

      expect(r.status).toBe(200);
      const stored = await getDayGenres(2);
      expect(stored.sort()).toEqual(['Comedy', 'Family']);
    });

    it('clears a day when given an empty list', async () => {
      await request(app).put('/api/settings/day-genres').send({ dayOfWeek: 1, genres: ['Drama'] });
      const r = await request(app).put('/api/settings/day-genres').send({ dayOfWeek: 1, genres: [] });
      expect(r.status).toBe(200);
      const stored = await getDayGenres(1);
      expect(stored).toEqual([]);
    });

    it('rejects an invalid dayOfWeek', async () => {
      const r = await request(app)
        .put('/api/settings/day-genres')
        .send({ dayOfWeek: 9, genres: ['Comedy'] });
      expect(r.status).toBe(400);
    });

    it('rejects a non-array genres', async () => {
      const r = await request(app)
        .put('/api/settings/day-genres')
        .send({ dayOfWeek: 0, genres: 'Comedy' });
      expect(r.status).toBe(400);
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/routes/api/settings.test.ts`
Expected: 404 responses or "Cannot find module" — the route doesn't exist yet.

- [ ] **Step 3: Implement the route**

Create `src/routes/api/settings.ts`:

```typescript
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
```

- [ ] **Step 4: Mount the router**

In `src/index.ts`, just above the line `app.use('/api/shows', showsApiRoutes);` (around line 51), add:

```typescript
import settingsApiRoutes from './routes/api/settings';
```

And in the API routes block, add:

```typescript
app.use('/api/settings', settingsApiRoutes);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- src/routes/api/settings.test.ts`
Expected: all 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/routes/api/settings.ts src/routes/api/settings.test.ts src/index.ts
git commit -m "feat(api): PUT /api/settings/day-genres"
```

---

## Task 5: Settings page "Day themes" UI

**Files:**
- Modify: `src/routes/settings.ts`
- Modify: `src/views/pages/settings.ejs`

- [ ] **Step 1: Pass day-genres data to the settings view**

In `src/routes/settings.ts`, update the GET handler to fetch the necessary data. Replace the existing GET block:

```typescript
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
```

with:

```typescript
router.get('/', async (_req, res) => {
  try {
    const settings = await getSettings();
    const dayGenres = await getAllDayGenres();

    // Union of genres across all current watchlist entries so the user only
    // sees chips that map to shows they actually have.
    const entries = await prisma.watchlistEntry.findMany({
      include: { show: true },
    });
    const genreSet = new Set<string>();
    for (const e of entries) {
      for (const g of JSON.parse(e.show.genres) as string[]) genreSet.add(g);
    }
    const availableGenres = [...genreSet].sort();

    renderWithLayout(res, 'settings', {
      title: 'Settings',
      settings,
      dayGenres,
      availableGenres,
    });
  } catch (error) {
    console.error('Settings page error:', error);
    renderWithLayout(res, 'error', { title: 'Error', message: 'Failed to load settings' });
  }
});
```

Add these imports at the top of the file (alongside the existing imports):

```typescript
import { prisma } from '../lib/db';
import { getAllDayGenres } from '../services/dayGenre';
```

- [ ] **Step 2: Add the Day Themes section to the settings view**

In `src/views/pages/settings.ejs`, scroll to the bottom of the main form/content block (after the existing settings sections, before the final closing `</div>` or wherever the page wraps up). Insert this block. If you're unsure where, append it just before the file's final closing `</div>`:

```html
<section class="bg-lounge-surface rounded-2xl p-6 border border-lounge-border mt-6">
  <div class="flex items-center gap-3 mb-4">
    <div class="w-10 h-10 rounded-xl bg-lounge-gold/20 flex items-center justify-center">
      <span class="text-lounge-gold">🎭</span>
    </div>
    <div>
      <h2 class="font-display text-xl font-semibold text-lounge-cream">Day Themes</h2>
      <p class="text-sm text-lounge-muted">Tag a day with genres. Unpinned shows whose genres match a day's theme are placed there first.</p>
    </div>
  </div>

  <% const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']; %>
  <div class="space-y-3">
    <% for (var d = 0; d < 7; d++) { %>
      <div class="flex items-center gap-4">
        <div class="w-24 text-sm text-lounge-cream font-medium"><%= dayNames[d] %></div>
        <div class="flex flex-wrap gap-1.5" data-day-genres="<%= d %>">
          <% if (availableGenres.length === 0) { %>
            <span class="text-xs text-lounge-muted italic">Add shows to your watchlist to see genres here.</span>
          <% } %>
          <% availableGenres.forEach(function(g) { %>
            <% var active = dayGenres[d].includes(g); %>
            <button type="button"
                    class="day-theme-chip text-xs px-3 py-1 rounded-full transition-colors <%= active ? 'bg-lounge-gold text-lounge-bg' : 'bg-lounge-card text-lounge-muted hover:bg-lounge-border' %>"
                    data-day="<%= d %>"
                    data-genre="<%= g %>"
                    data-active="<%= active ? 'true' : 'false' %>">
              <%= g %>
            </button>
          <% }); %>
        </div>
      </div>
    <% } %>
  </div>
</section>

<script>
  document.querySelectorAll('.day-theme-chip').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      var day = Number(btn.dataset.day);
      var container = document.querySelector('[data-day-genres="' + day + '"]');
      var nowActive = btn.dataset.active !== 'true';
      btn.dataset.active = nowActive ? 'true' : 'false';
      btn.classList.toggle('bg-lounge-gold');
      btn.classList.toggle('text-lounge-bg');
      btn.classList.toggle('bg-lounge-card');
      btn.classList.toggle('text-lounge-muted');

      var genres = Array.from(container.querySelectorAll('.day-theme-chip'))
        .filter(function (c) { return c.dataset.active === 'true'; })
        .map(function (c) { return c.dataset.genre; });

      var r = await fetch('/api/settings/day-genres', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dayOfWeek: day, genres: genres }),
      });
      if (!r.ok) {
        alert('Failed to save day theme');
        // Revert
        btn.dataset.active = nowActive ? 'false' : 'true';
        btn.classList.toggle('bg-lounge-gold');
        btn.classList.toggle('text-lounge-bg');
        btn.classList.toggle('bg-lounge-card');
        btn.classList.toggle('text-lounge-muted');
      }
    });
  });
</script>
```

- [ ] **Step 3: Manual verification**

Run: `npm run dev` (in another terminal if not already running)
Browse to `http://localhost:4242/settings` and confirm:
- A new "Day Themes" section appears.
- The chip picker shows genres pulled from your current watchlist.
- Clicking a chip toggles it gold; the change persists across page reloads.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/routes/settings.ts src/views/pages/settings.ejs
git commit -m "feat(settings): day themes chip picker"
```

---

## Task 6: Genre chips — CSS, partial, and apply across views

**Files:**
- Modify: `src/views/layouts/main.ejs`
- Create: `src/views/partials/genre-chips.ejs`
- Modify: `src/views/pages/watchlist.ejs`
- Modify: `src/views/pages/schedule.ejs`
- Modify: `src/views/pages/dashboard.ejs`
- Modify: `src/views/pages/rotations/edit.ejs`

- [ ] **Step 1: Add the `.genre-chip` CSS rule**

In `src/views/layouts/main.ejs`, locate the `.rotation-chip` rule inside the `<style>` block (around line 149). Add the following just after it:

```css
    /* Genre chip — used on watchlist, schedule, dashboard, and rotation views */
    .genre-chip {
      display: inline-block;
      font-size: 0.65rem;
      padding: 0.1rem 0.5rem;
      border-radius: 9999px;
      background: var(--lounge-card);
      color: var(--lounge-muted);
      margin-right: 0.25rem;
      white-space: nowrap;
    }
```

- [ ] **Step 2: Create the chip partial**

Create `src/views/partials/genre-chips.ejs`:

```html
<%# ABOUTME: Renders a row of small genre chips for a show. %>
<%# ABOUTME: Caller passes `show` — uses show.genres (JSON-encoded array). %>
<%
  var __genres = [];
  try { __genres = JSON.parse(show.genres) || []; } catch (e) { __genres = []; }
%>
<% if (__genres.length > 0) { %>
  <span class="inline-flex flex-wrap gap-1 align-middle">
    <% __genres.forEach(function (g) { %>
      <span class="genre-chip"><%= g %></span>
    <% }); %>
  </span>
<% } %>
```

- [ ] **Step 3: Render chips on the watchlist page**

In `src/views/pages/watchlist.ejs`, find each show card's title block (there are two — one in the Currently Watching section, one in the Queue section). The watching section's title line looks like:

```html
<h3 class="font-display text-lg text-lounge-cream mb-1"><%= entry.show.title %></h3>
```

Below that `</h3>`, add:

```html
<%- include('../partials/genre-chips', { show: entry.show }) %>
```

Do the same below the queue section's title `</h3>`.

- [ ] **Step 4: Render chips on the schedule page**

In `src/views/pages/schedule.ejs`, find the line (around line 76) that renders the episode title:

```html
<% if (ep.rotationGroup) { %><span class="rotation-chip">&#8635; <%= ep.rotationGroup.name %></span><% } %><%= ep.show.title %>
```

Replace it with:

```html
<% if (ep.rotationGroup) { %><span class="rotation-chip">&#8635; <%= ep.rotationGroup.name %></span><% } %><%= ep.show.title %>
<%- include('../partials/genre-chips', { show: ep.show }) %>
```

- [ ] **Step 5: Render chips on the dashboard**

In `src/views/pages/dashboard.ejs`, find the lines that render the episode title (they look similar to schedule.ejs's, with the rotation chip). There are typically two — one for today's episodes, one for yesterday's pending. Below each, add:

```html
<%- include('../partials/genre-chips', { show: ep.show }) %>
```

- [ ] **Step 6: Render chips on the rotation edit page**

In `src/views/pages/rotations/edit.ejs`, find the member list `<li>` block (around line 70):

```html
<span class="flex-1 text-lounge-cream">
  <%= m.watchlistEntry.show.title %>
  ...
</span>
```

Just before the closing `</span>` of that block (after the existing season/episode badges), add:

```html
<%- include('../../partials/genre-chips', { show: m.watchlistEntry.show }) %>
```

Note the `../..` since this view is one level deeper than the others.

- [ ] **Step 7: Manual verification**

Run: `npm run dev` and browse:
- `/watchlist` — each show card has a row of small grey genre chips under the title.
- `/schedule` — each scheduled episode shows chips.
- `/` (dashboard) — tonight's episodes show chips.
- `/rotations/<id>` — each member row shows chips.

- [ ] **Step 8: Run the full test suite**

Run: `npm test`
Expected: all tests pass (no behavioral change beyond rendering).

- [ ] **Step 9: Commit**

```bash
git add src/views/layouts/main.ejs src/views/partials/genre-chips.ejs \
        src/views/pages/watchlist.ejs src/views/pages/schedule.ejs \
        src/views/pages/dashboard.ejs src/views/pages/rotations/edit.ejs
git commit -m "feat(ui): genre chips on watchlist, schedule, dashboard, rotation views"
```

---

## Task 7: Bulk watchlist API endpoints

**Files:**
- Modify: `src/routes/api/watchlist.ts`
- Modify: `src/routes/api/watchlist.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/routes/api/watchlist.test.ts` (inside the top-level `describe('Watchlist API', ...)` block, or in a new top-level `describe` after it — either is fine; copy the existing test file's `beforeEach` setup pattern):

```typescript
describe('Bulk endpoints', () => {
  async function seedShow(tmdbId: number, title: string, status = 'queued') {
    const show = await prisma.show.create({
      data: { tmdbId, title, genres: '[]', totalSeasons: 1, totalEpisodes: 10, episodeRuntime: 30, status: 'Ended' },
    });
    return prisma.watchlistEntry.create({ data: { showId: show.id, status } });
  }

  it('POST /api/watchlist/bulk/promote flips multiple queued entries to watching, no day assignments created', async () => {
    const a = await seedShow(801, 'BP A');
    const b = await seedShow(802, 'BP B');
    const r = await request(app).post('/api/watchlist/bulk/promote').send({ entryIds: [a.id, b.id] });
    expect(r.status).toBe(200);
    expect(r.body.promoted.sort()).toEqual([a.id, b.id].sort());

    const updated = await prisma.watchlistEntry.findMany({
      where: { id: { in: [a.id, b.id] } },
      include: { dayAssignments: true },
    });
    for (const e of updated) {
      expect(e.status).toBe('watching');
      expect(e.dayAssignments).toEqual([]);
    }
  });

  it('POST /api/watchlist/bulk/demote moves to queued and clears day assignments', async () => {
    const a = await seedShow(811, 'BD A', 'watching');
    await prisma.showDayAssignment.create({ data: { watchlistEntryId: a.id, dayOfWeek: 1 } });

    const r = await request(app).post('/api/watchlist/bulk/demote').send({ entryIds: [a.id] });
    expect(r.status).toBe(200);
    expect(r.body.demoted).toEqual([a.id]);

    const updated = await prisma.watchlistEntry.findUnique({
      where: { id: a.id },
      include: { dayAssignments: true },
    });
    expect(updated!.status).toBe('queued');
    expect(updated!.dayAssignments).toEqual([]);
  });

  it('POST /api/watchlist/bulk/remove deletes multiple entries', async () => {
    const a = await seedShow(821, 'BR A');
    const b = await seedShow(822, 'BR B');
    const r = await request(app).post('/api/watchlist/bulk/remove').send({ entryIds: [a.id, b.id] });
    expect(r.status).toBe(200);
    expect(r.body.removed.sort()).toEqual([a.id, b.id].sort());

    const remaining = await prisma.watchlistEntry.findMany({ where: { id: { in: [a.id, b.id] } } });
    expect(remaining).toEqual([]);
  });

  it('POST /api/watchlist/bulk/rotation/:rotationId adds members, skipping duplicates', async () => {
    const a = await seedShow(831, 'BRot A');
    const b = await seedShow(832, 'BRot B');
    const group = await prisma.rotationGroup.create({ data: { name: 'BulkTarget' } });
    // pre-add b so it should be skipped as a duplicate
    await prisma.rotationMember.create({ data: { rotationGroupId: group.id, watchlistEntryId: b.id, order: 0 } });

    const r = await request(app)
      .post(`/api/watchlist/bulk/rotation/${group.id}`)
      .send({ entryIds: [a.id, b.id] });
    expect(r.status).toBe(200);
    expect(r.body.added).toEqual([a.id]);
    expect(r.body.skipped).toEqual([b.id]);

    const members = await prisma.rotationMember.findMany({ where: { rotationGroupId: group.id } });
    expect(members.length).toBe(2);
  });

  it('returns 400 for missing or empty entryIds', async () => {
    const r1 = await request(app).post('/api/watchlist/bulk/promote').send({});
    expect(r1.status).toBe(400);
    const r2 = await request(app).post('/api/watchlist/bulk/promote').send({ entryIds: [] });
    expect(r2.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/routes/api/watchlist.test.ts`
Expected: the new tests fail with 404 (endpoints don't exist).

- [ ] **Step 3: Implement the endpoints**

Open `src/routes/api/watchlist.ts`. Find a good spot near the existing routes (e.g., before `export default router;` at the bottom). Insert:

```typescript
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
```

Make sure `clearSchedule` is already imported at the top of the file (it should be — it's used by existing routes; if not, add `import { clearSchedule } from '../../services/scheduler';`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/routes/api/watchlist.test.ts`
Expected: all bulk endpoint tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/routes/api/watchlist.ts src/routes/api/watchlist.test.ts
git commit -m "feat(api): bulk promote/demote/remove/add-to-rotation endpoints"
```

---

## Task 8: Watchlist UI — checkboxes, action bars, JS

**Files:**
- Modify: `src/routes/watchlist.ts`
- Modify: `src/views/pages/watchlist.ejs`

- [ ] **Step 1: Pass the rotations list to the watchlist view**

In `src/routes/watchlist.ts`'s GET handler, add a rotations fetch alongside the existing queries. Update the renderWithLayout call to pass `rotations`. Replace the GET handler body with:

```typescript
router.get('/', async (_req, res) => {
  try {
    const watching = await prisma.watchlistEntry.findMany({
      where: { status: 'watching' },
      include: {
        show: true,
        dayAssignments: true,
        rotationMembers: { include: { rotationGroup: true } },
      },
      orderBy: { priority: 'asc' },
    });

    const queued = await prisma.watchlistEntry.findMany({
      where: {
        status: 'queued',
        NOT: {
          rotationMembers: { some: { rotationGroup: { active: true } } },
        },
      },
      include: { show: true },
      orderBy: { priority: 'asc' },
    });

    const rotations = await prisma.rotationGroup.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, name: true, active: true },
    });

    renderWithLayout(res, 'watchlist', {
      title: 'Watchlist',
      watching,
      queued,
      rotations,
    });
  } catch (error) {
    console.error('Watchlist page error:', error);
    renderWithLayout(res, 'error', { title: 'Error', message: 'Failed to load watchlist' });
  }
});
```

- [ ] **Step 2: Add checkboxes + action bar to the Currently Watching section**

In `src/views/pages/watchlist.ejs`, locate the Currently Watching section header (`<!-- Currently Watching -->` comment, around line 108). Replace the section header block — the `<div class="flex items-center gap-3">` line through the closing `</div>` that holds the section title — so that it includes the section toolbar. The replacement is:

```html
  <!-- Currently Watching -->
  <section class="space-y-5" id="watching-section">
    <div class="flex items-center gap-3">
      <input type="checkbox" id="watching-select-all" class="accent-lounge-gold w-4 h-4">
      <div class="w-3 h-3 rounded-full bg-lounge-watching"></div>
      <h2 class="font-display text-2xl font-semibold text-lounge-cream">Currently Watching</h2>
      <span class="text-lounge-muted text-sm">(<%= watching.length %> shows)</span>
    </div>

    <div id="watching-action-bar" class="hidden bg-lounge-surface border border-lounge-border rounded-2xl px-4 py-2 flex items-center gap-3 sticky top-20 z-40">
      <span class="text-sm text-lounge-cream"><span id="watching-count">0</span> selected</span>
      <button type="button" class="text-xs px-3 py-1.5 rounded-lg bg-lounge-card text-lounge-queue hover:bg-lounge-queue hover:text-lounge-bg transition-colors" onclick="bulkAction('watching', 'demote')">Demote</button>
      <button type="button" class="text-xs px-3 py-1.5 rounded-lg bg-lounge-card text-red-400 hover:bg-red-400 hover:text-lounge-bg transition-colors" onclick="bulkAction('watching', 'remove')">Remove</button>
      <div class="relative">
        <button type="button" class="text-xs px-3 py-1.5 rounded-lg bg-lounge-card text-lounge-cream hover:bg-lounge-border transition-colors" onclick="toggleRotationMenu('watching')">Add to rotation ▾</button>
        <div id="watching-rotation-menu" class="hidden absolute right-0 mt-1 bg-lounge-surface border border-lounge-border rounded-xl py-1 min-w-[180px] z-50">
          <% rotations.forEach(function(r) { %>
            <button type="button" class="block w-full text-left px-3 py-1.5 text-xs text-lounge-cream hover:bg-lounge-card" onclick="bulkAction('watching', 'rotation', <%= r.id %>)"><%= r.name %><% if (!r.active) { %> <span class="text-lounge-muted">(paused)</span><% } %></button>
          <% }); %>
          <% if (rotations.length === 0) { %>
            <div class="px-3 py-2 text-xs text-lounge-muted italic">No rotations yet</div>
          <% } %>
        </div>
      </div>
    </div>

    <% if (watching.length === 0) { %>
    <div class="bg-lounge-surface rounded-2xl p-8 text-center border border-lounge-border">
      <p class="text-lounge-muted">No shows currently in rotation. Promote a show from your queue to start watching!</p>
    </div>
    <% } else { %>
    <div class="grid gap-4">
```

Now find each watching card's outer `<div>` and add a checkbox column. The current card opens with something like:

```html
<div class="bg-lounge-surface rounded-2xl p-5 card-hover status-watching" style="animation-delay: <%= index * 50 %>ms">
  <div class="flex gap-5">
```

Change the inner `<div class="flex gap-5">` to:

```html
<div class="flex gap-5 items-start">
  <input type="checkbox" class="watching-select accent-lounge-gold w-4 h-4 mt-1" data-id="<%= entry.id %>">
```

So now each card row begins with the checkbox.

- [ ] **Step 3: Repeat for the Queue section**

Find the `<!-- Queue -->` section header (around line 249) and apply the symmetric treatment. The replacement for the section header block:

```html
  <!-- Queue -->
  <section class="space-y-5" id="queue-section">
    <div class="flex items-center gap-3">
      <input type="checkbox" id="queue-select-all" class="accent-lounge-gold w-4 h-4">
      <div class="w-3 h-3 rounded-full bg-lounge-queue"></div>
      <h2 class="font-display text-2xl font-semibold text-lounge-cream">Queue</h2>
      <span class="text-lounge-muted text-sm">(<%= queued.length %> shows)</span>
    </div>

    <div id="queue-action-bar" class="hidden bg-lounge-surface border border-lounge-border rounded-2xl px-4 py-2 flex items-center gap-3 sticky top-20 z-40">
      <span class="text-sm text-lounge-cream"><span id="queue-count">0</span> selected</span>
      <button type="button" class="text-xs px-3 py-1.5 rounded-lg bg-lounge-card text-lounge-watching hover:bg-lounge-watching hover:text-lounge-bg transition-colors" onclick="bulkAction('queue', 'promote')">Promote</button>
      <button type="button" class="text-xs px-3 py-1.5 rounded-lg bg-lounge-card text-red-400 hover:bg-red-400 hover:text-lounge-bg transition-colors" onclick="bulkAction('queue', 'remove')">Remove</button>
      <div class="relative">
        <button type="button" class="text-xs px-3 py-1.5 rounded-lg bg-lounge-card text-lounge-cream hover:bg-lounge-border transition-colors" onclick="toggleRotationMenu('queue')">Add to rotation ▾</button>
        <div id="queue-rotation-menu" class="hidden absolute right-0 mt-1 bg-lounge-surface border border-lounge-border rounded-xl py-1 min-w-[180px] z-50">
          <% rotations.forEach(function(r) { %>
            <button type="button" class="block w-full text-left px-3 py-1.5 text-xs text-lounge-cream hover:bg-lounge-card" onclick="bulkAction('queue', 'rotation', <%= r.id %>)"><%= r.name %><% if (!r.active) { %> <span class="text-lounge-muted">(paused)</span><% } %></button>
          <% }); %>
          <% if (rotations.length === 0) { %>
            <div class="px-3 py-2 text-xs text-lounge-muted italic">No rotations yet</div>
          <% } %>
        </div>
      </div>
    </div>
```

And add the per-row checkbox to each queue card's opening flex container the same way:

```html
<div class="flex gap-5 items-start">
  <input type="checkbox" class="queue-select accent-lounge-gold w-4 h-4 mt-1" data-id="<%= entry.id %>">
```

- [ ] **Step 4: Add the bulk-action JS**

Append the following `<script>` block to the bottom of `src/views/pages/watchlist.ejs`, after the existing scripts:

```html
<script>
  function selectedIds(section) {
    return Array.from(document.querySelectorAll('.' + section + '-select:checked'))
      .map(function (cb) { return Number(cb.dataset.id); });
  }

  function refreshBar(section) {
    var ids = selectedIds(section);
    var bar = document.getElementById(section + '-action-bar');
    var count = document.getElementById(section + '-count');
    if (ids.length > 0) {
      bar.classList.remove('hidden');
      count.textContent = String(ids.length);
    } else {
      bar.classList.add('hidden');
    }
  }

  function toggleRotationMenu(section) {
    var menu = document.getElementById(section + '-rotation-menu');
    menu.classList.toggle('hidden');
  }

  document.addEventListener('click', function (e) {
    // Close rotation dropdowns when clicking outside
    ['watching', 'queue'].forEach(function (s) {
      var menu = document.getElementById(s + '-rotation-menu');
      if (!menu) return;
      var openerClicked = e.target.closest('[onclick*="toggleRotationMenu(\'' + s + '\')"]');
      var insideMenu = e.target.closest('#' + s + '-rotation-menu');
      if (!openerClicked && !insideMenu) menu.classList.add('hidden');
    });
  });

  ['watching', 'queue'].forEach(function (section) {
    document.querySelectorAll('.' + section + '-select').forEach(function (cb) {
      cb.addEventListener('change', function () { refreshBar(section); });
    });
    var all = document.getElementById(section + '-select-all');
    if (all) {
      all.addEventListener('change', function () {
        document.querySelectorAll('.' + section + '-select').forEach(function (cb) {
          cb.checked = all.checked;
        });
        refreshBar(section);
      });
    }
  });

  async function bulkAction(section, action, rotationId) {
    var ids = selectedIds(section);
    if (ids.length === 0) return;

    if (action === 'remove' && !confirm('Remove ' + ids.length + ' show(s)?')) return;
    if (action === 'demote' && !confirm('Demote ' + ids.length + ' show(s) back to queue?')) return;

    var url;
    if (action === 'rotation') {
      url = '/api/watchlist/bulk/rotation/' + rotationId;
    } else {
      url = '/api/watchlist/bulk/' + action;
    }
    var r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryIds: ids }),
    });
    if (r.ok) {
      location.reload();
    } else {
      var data = {};
      try { data = await r.json(); } catch (e) { /* ignore */ }
      alert('Failed: ' + (data.error || r.status));
    }
  }
</script>
```

- [ ] **Step 5: Manual verification**

Run: `npm run dev`. Visit `/watchlist`:
- Per-row checkboxes appear in both sections.
- Selecting one row makes the action bar fade in.
- Selecting multiple updates the count.
- Bulk promote/demote/remove all behave as expected.
- Add-to-rotation dropdown lists rotations; selecting one adds the entries.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/routes/watchlist.ts src/views/pages/watchlist.ejs
git commit -m "feat(watchlist): per-section multi-select with bulk action bar"
```

---

## Task 9: `promoteFromQueue` unpinned + clean up dead day-assignment helpers

**Files:**
- Modify: `src/services/watchlist.ts`
- Modify: `src/services/watchlist.test.ts`
- Modify: `src/services/dayAssignment.ts`
- Modify: `src/services/dayAssignment.test.ts` (if it tests the deleted helpers)

- [ ] **Step 1: Strip `findBestDayForShow` and `getDayGenres` from `dayAssignment.ts`**

In `src/services/dayAssignment.ts`, delete the following:
- The entire `getDayGenres` function (lines ~114-130)
- The entire `findBestDayForShow` function (lines ~132 onward)

Also remove any imports they relied on that become unused (Prisma-internal types, etc.). Keep `getDayCapacity` — the schedule page uses it for the per-day budget header.

If `src/services/dayAssignment.test.ts` exercises `findBestDayForShow`, delete those `describe`/`it` blocks. Tests for `getDayCapacity` and `assignShowToDay` stay.

- [ ] **Step 2: Update `promoteFromQueue` in `src/services/watchlist.ts`**

Find the existing `promoteFromQueue`. It currently calls `findBestDayForShow` and creates a `ShowDayAssignment`. Replace its body so it only flips status. The function should now look like:

```typescript
export async function promoteFromQueue(entryId: number): Promise<WatchlistEntry & { show: Show; dayAssignments: ShowDayAssignment[] }> {
  const entry = await prisma.watchlistEntry.update({
    where: { id: entryId },
    data: { status: 'watching' },
    include: { show: true, dayAssignments: true },
  });
  return entry;
}
```

(Type names already imported at the top of the file — if `ShowDayAssignment` isn't, add it: `import type { ... ShowDayAssignment ... } from '@prisma/client';`. The `dayAssignments: []` will be returned because the include resolves to an empty array for an unpinned entry, which is what we want.)

Remove the `import { findBestDayForShow } from './dayAssignment'` line — it's no longer needed.

- [ ] **Step 3: Update `src/services/watchlist.test.ts`**

Find tests that assert auto-day-assignment after promote. They typically include lines like:

```typescript
expect(promoted.dayAssignments.length).toBeGreaterThan(0);
```

Flip those expectations to `toEqual([])` or `toBe(0)`. The promote test that runs end-to-end (in `src/e2e/schedule-flow.test.ts`) will also need this change — find its `expect(promoted.dayAssignments.length).toBeGreaterThan(0);` and change to `expect(promoted.dayAssignments).toEqual([]);`. Then, downstream of that assertion in the same test, instead of relying on the auto-assigned day, **pin the show explicitly** via `assignShowToDay(promoted.id, today.getDay())` so the rest of the flow has something to schedule. Add the import for `assignShowToDay` if not already present.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all tests pass with the new unpinned-on-promote behavior.

- [ ] **Step 5: Commit**

```bash
git add src/services/watchlist.ts src/services/watchlist.test.ts \
        src/services/dayAssignment.ts src/services/dayAssignment.test.ts \
        src/e2e/schedule-flow.test.ts
git commit -m "feat(watchlist): promote leaves shows unpinned; remove findBestDayForShow"
```

---

## Task 10: Scheduler Pass 2 — unpinned-show placement

**Files:**
- Modify: `src/services/scheduler.ts`
- Modify: `src/services/scheduler.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/services/scheduler.test.ts` (inside the top-level describe, or in a new describe block at the end):

```typescript
describe('Pass 2: unpinned-show placement via genre affinity', () => {
  beforeEach(async () => {
    await prisma.scheduledEpisode.deleteMany();
    await prisma.scheduleDay.deleteMany();
    await prisma.dayGenrePreference.deleteMany();
    await prisma.showDayAssignment.deleteMany();
    await prisma.rotationMember.deleteMany();
    await prisma.rotationDayAssignment.deleteMany();
    await prisma.rotationGroup.deleteMany();
    await prisma.watchlistEntry.deleteMany();
    await prisma.show.deleteMany();
    await prisma.settings.upsert({
      where: { id: 1 },
      create: { id: 1, weekdayMinutes: 60, weekendMinutes: 60, schedulingMode: 'sequential' },
      update: { weekdayMinutes: 60, weekendMinutes: 60, schedulingMode: 'sequential' },
    });
  });

  async function seedShow(tmdbId: number, title: string, genres: string[], runtime = 30) {
    const show = await prisma.show.create({
      data: {
        tmdbId,
        title,
        genres: JSON.stringify(genres),
        totalSeasons: 1,
        totalEpisodes: 50,
        episodeRuntime: runtime,
        status: 'Ended',
      },
    });
    const entry = await prisma.watchlistEntry.create({ data: { showId: show.id, status: 'watching' } });
    return { show, entry };
  }

  it('places an unpinned show on the day whose theme matches its genres', async () => {
    // Mon=Drama, Tue=Comedy
    await prisma.dayGenrePreference.createMany({
      data: [
        { dayOfWeek: 1, genre: 'Drama' },
        { dayOfWeek: 2, genre: 'Comedy' },
      ],
    });
    await seedShow(901, 'Comedy Show', ['Comedy']);

    // Pick a Sunday so the 7-day window covers Mon (idx 1) and Tue (idx 2)
    const start = new Date('2026-05-17T00:00:00.000Z'); // Sunday
    await generateSchedule(start, 7);

    const tuesday = new Date('2026-05-19T00:00:00.000Z');
    const monday = new Date('2026-05-18T00:00:00.000Z');
    const tueDay = await getScheduleForDay(tuesday);
    const monDay = await getScheduleForDay(monday);

    expect(tueDay!.episodes.map((e) => e.show.title)).toContain('Comedy Show');
    expect(monDay!.episodes.map((e) => e.show.title)).not.toContain('Comedy Show');
  });

  it('still schedules an unpinned show when no day matches its genres (falls back to capacity)', async () => {
    await seedShow(902, 'Sci-Fi Show', ['Sci-Fi']);
    const start = new Date('2026-05-17T00:00:00.000Z');
    await generateSchedule(start, 7);

    // Scan all 7 days and make sure the show appears somewhere.
    let found = false;
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      const day = await getScheduleForDay(d);
      if (day?.episodes.some((e) => e.show.title === 'Sci-Fi Show')) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it('pinned shows still go on their pinned day regardless of genre preferences', async () => {
    // Mark Tuesday=Comedy. Then pin a Comedy show to Wednesday. It must stay on Wed.
    await prisma.dayGenrePreference.create({ data: { dayOfWeek: 2, genre: 'Comedy' } });
    const { entry } = await seedShow(903, 'Pinned Comedy', ['Comedy']);
    await prisma.showDayAssignment.create({ data: { watchlistEntryId: entry.id, dayOfWeek: 3 } });

    const start = new Date('2026-05-17T00:00:00.000Z');
    await generateSchedule(start, 7);

    const wednesday = new Date('2026-05-20T00:00:00.000Z');
    const tuesday = new Date('2026-05-19T00:00:00.000Z');
    const wedDay = await getScheduleForDay(wednesday);
    const tueDay = await getScheduleForDay(tuesday);

    expect(wedDay!.episodes.map((e) => e.show.title)).toContain('Pinned Comedy');
    expect(tueDay!.episodes.map((e) => e.show.title)).not.toContain('Pinned Comedy');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/services/scheduler.test.ts -t "Pass 2"`
Expected: the new tests fail (unpinned shows don't get scheduled, because Pass 1 only sees pinned `ShowDayAssignment` rows and rotation picks).

- [ ] **Step 3: Implement Pass 2 in the scheduler**

In `src/services/scheduler.ts`, add the import for the scoring helper at the top:

```typescript
import { scoreDayForShow } from './dayGenre';
```

Find the end of `doGenerateSchedule` — after the existing `for (let i = 0; i < days; i++) { ... }` loop, just before `markScheduleGenerated(days);`. Insert this block:

```typescript
  // Pass 2: place unpinned watching shows (no ShowDayAssignment rows) onto
  // the best-scoring day within the requested window. Soft preference —
  // shows still get placed even when no day's theme matches their genres.
  const unpinnedEntries = await prisma.watchlistEntry.findMany({
    where: {
      status: 'watching',
      dayAssignments: { none: {} },
    },
    include: { show: true },
  });

  if (unpinnedEntries.length > 0) {
    // Snapshot per-day remaining capacity + per-show position.
    type DayState = {
      date: Date;
      dayOfWeek: number;
      scheduleDayId: number;
      remainingMinutes: number;
      nextOrder: number;
    };

    const dayStates: DayState[] = [];
    for (let i = 0; i < days; i++) {
      const currentDate = new Date(startDate);
      currentDate.setDate(currentDate.getDate() + i);
      currentDate.setHours(0, 0, 0, 0);

      const scheduleDay = await prisma.scheduleDay.findUnique({
        where: { date: currentDate },
        include: { episodes: true },
      });
      if (!scheduleDay) continue;

      const usedMinutes = scheduleDay.episodes.reduce((s, e) => s + e.runtime, 0);
      const maxOrder = scheduleDay.episodes.reduce((m, e) => Math.max(m, e.order), -1);
      dayStates.push({
        date: currentDate,
        dayOfWeek: currentDate.getDay(),
        scheduleDayId: scheduleDay.id,
        remainingMinutes: scheduleDay.plannedMinutes - usedMinutes,
        nextOrder: maxOrder + 1,
      });
    }

    // Position pointer (season/episode) per show — initialize from the
    // watchlist entry's current progress.
    const unpinnedPositions = new Map<number, { season: number; episode: number }>();
    for (const e of unpinnedEntries) {
      unpinnedPositions.set(e.id, { season: e.currentSeason, episode: e.currentEpisode });
    }

    // Round-robin: each pass tries to schedule one episode per unpinned show
    // on its highest-scoring day with capacity. Stop when a full pass adds nothing.
    let progress = true;
    while (progress) {
      progress = false;
      for (const entry of unpinnedEntries) {
        const pos = unpinnedPositions.get(entry.id)!;
        if (pos.episode > entry.show.totalEpisodes) continue;
        const runtime = entry.show.episodeRuntime;
        const showGenres = (() => {
          try { return JSON.parse(entry.show.genres) as string[]; }
          catch { return []; }
        })();

        // Score each day that can fit one more episode.
        let bestIdx = -1;
        let bestScore = Number.NEGATIVE_INFINITY;
        for (let i = 0; i < dayStates.length; i++) {
          const s = dayStates[i];
          if (s.remainingMinutes < runtime) continue;
          const score = await scoreDayForShow(s.dayOfWeek, showGenres, s.remainingMinutes);
          if (score > bestScore) {
            bestScore = score;
            bestIdx = i;
          }
        }
        if (bestIdx < 0) continue;
        const target = dayStates[bestIdx];

        // Availability check for returning series (mirrors fillDaySequential)
        if (entry.show.status === 'Returning Series') {
          const availability = await isEpisodeAvailable(entry.show.tmdbId, pos.season, pos.episode);
          if (!availability.available) continue;
        }

        await prisma.scheduledEpisode.create({
          data: {
            scheduleDayId: target.scheduleDayId,
            showId: entry.show.id,
            season: pos.season,
            episode: pos.episode,
            runtime,
            order: target.nextOrder,
            status: 'pending',
          },
        });

        target.remainingMinutes -= runtime;
        target.nextOrder += 1;
        pos.episode += 1;
        progress = true;
      }
    }
  }
```

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `npm test -- src/services/scheduler.test.ts -t "Pass 2"`
Expected: all 3 new tests pass.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/scheduler.ts src/services/scheduler.test.ts
git commit -m "feat(scheduler): pass 2 places unpinned shows by genre-day affinity"
```

---

## Task 11: End-to-end genre-affinity flow test

**Files:**
- Create: `src/e2e/genre-affinity-flow.test.ts`

- [ ] **Step 1: Write the test**

Create `src/e2e/genre-affinity-flow.test.ts`:

```typescript
// ABOUTME: End-to-end test for the genre-affinity scheduling flow.
// ABOUTME: Set a day theme via API -> bulk-promote a queued show ->
// ABOUTME: regenerate schedule -> assert the show landed on the themed day.

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../index';
import { prisma } from '../lib/db';
import { generateSchedule, getScheduleForDay, clearSchedule } from '../services/scheduler';

describe('E2E: genre affinity', () => {
  beforeEach(async () => {
    await prisma.scheduledEpisode.deleteMany();
    await prisma.scheduleDay.deleteMany();
    await prisma.dayGenrePreference.deleteMany();
    await prisma.showDayAssignment.deleteMany();
    await prisma.rotationMember.deleteMany();
    await prisma.rotationDayAssignment.deleteMany();
    await prisma.rotationGroup.deleteMany();
    await prisma.watchlistEntry.deleteMany();
    await prisma.show.deleteMany();
    await prisma.settings.upsert({
      where: { id: 1 },
      create: { id: 1, weekdayMinutes: 60, weekendMinutes: 60, schedulingMode: 'sequential' },
      update: { weekdayMinutes: 60, weekendMinutes: 60, schedulingMode: 'sequential' },
    });
    await clearSchedule();
  });

  it('set theme -> bulk promote -> regen -> show lands on themed day', async () => {
    // Seed two queued shows of different genres.
    const comedyShow = await prisma.show.create({
      data: { tmdbId: 1001, title: 'Comedy Hour', genres: JSON.stringify(['Comedy']), totalSeasons: 1, totalEpisodes: 20, episodeRuntime: 30, status: 'Ended' },
    });
    const dramaShow = await prisma.show.create({
      data: { tmdbId: 1002, title: 'Drama Hour', genres: JSON.stringify(['Drama']), totalSeasons: 1, totalEpisodes: 20, episodeRuntime: 30, status: 'Ended' },
    });
    const comedyEntry = await prisma.watchlistEntry.create({ data: { showId: comedyShow.id, status: 'queued' } });
    const dramaEntry = await prisma.watchlistEntry.create({ data: { showId: dramaShow.id, status: 'queued' } });

    // 1. Set Tuesday = Comedy, Wednesday = Drama via the API.
    let r = await request(app).put('/api/settings/day-genres').send({ dayOfWeek: 2, genres: ['Comedy'] });
    expect(r.status).toBe(200);
    r = await request(app).put('/api/settings/day-genres').send({ dayOfWeek: 3, genres: ['Drama'] });
    expect(r.status).toBe(200);

    // 2. Bulk-promote both shows.
    r = await request(app).post('/api/watchlist/bulk/promote').send({ entryIds: [comedyEntry.id, dramaEntry.id] });
    expect(r.status).toBe(200);

    // 3. Regenerate the schedule starting from a Sunday so days 0..6 line up.
    const start = new Date('2026-05-17T00:00:00.000Z'); // Sunday
    await generateSchedule(start, 7);

    // 4. Assert placements.
    const tuesday = await getScheduleForDay(new Date('2026-05-19T00:00:00.000Z'));
    const wednesday = await getScheduleForDay(new Date('2026-05-20T00:00:00.000Z'));

    expect(tuesday!.episodes.map((e) => e.show.title)).toContain('Comedy Hour');
    expect(tuesday!.episodes.map((e) => e.show.title)).not.toContain('Drama Hour');
    expect(wednesday!.episodes.map((e) => e.show.title)).toContain('Drama Hour');
    expect(wednesday!.episodes.map((e) => e.show.title)).not.toContain('Comedy Hour');
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm test -- src/e2e/genre-affinity-flow.test.ts`
Expected: passes — the previous tasks should have built everything this flow exercises.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/e2e/genre-affinity-flow.test.ts
git commit -m "test(e2e): genre-affinity full flow"
```

---

## Self-review summary

Spec coverage:
- Multi-select bulk actions → Tasks 7 (API) + 8 (UI)
- Genre chips → Task 6
- `DayGenrePreference` schema → Task 1
- Day themes settings UI → Task 5
- Scheduler Pass 2 (unpinned placement) → Task 10
- Promote leaves shows unpinned → Task 9
- Remove `findBestDayForShow`, `getDayGenres`, `genreRules` → Tasks 1, 2, 9
- End-to-end test → Task 11

Tests cover every code path described in the spec.
