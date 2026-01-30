# Episode Availability Check Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ensure returning shows can only be promoted/scheduled when episodes have actually aired.

**Architecture:** Add TMDB air date checking function, integrate into promotion and scheduler, show availability status in queue UI.

**Tech Stack:** TypeScript, TMDB API, Prisma, Express, EJS, Vitest

---

### Task 1: Add isEpisodeAvailable function to TMDB service

**Files:**
- Modify: `src/services/tmdb.ts`
- Create: `src/services/tmdb.test.ts`

**Step 1: Write the failing test**

Create `src/services/tmdb.test.ts`:

```typescript
// ABOUTME: Tests for TMDB API service functions.
// ABOUTME: Uses mocked fetch to avoid hitting real API.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isEpisodeAvailable } from './tmdb';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock env
vi.stubEnv('TMDB_API_KEY', 'test-api-key');

describe('isEpisodeAvailable', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns available true when episode air date is in the past', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        episodes: [
          { episode_number: 1, air_date: '2020-01-01' },
          { episode_number: 2, air_date: '2020-01-08' },
        ],
      }),
    });

    const result = await isEpisodeAvailable(12345, 1, 2);

    expect(result.available).toBe(true);
    expect(result.airDate).toBe('2020-01-08');
  });

  it('returns available false when episode air date is in the future', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        episodes: [
          { episode_number: 1, air_date: '2020-01-01' },
          { episode_number: 2, air_date: '2099-12-31' },
        ],
      }),
    });

    const result = await isEpisodeAvailable(12345, 1, 2);

    expect(result.available).toBe(false);
    expect(result.airDate).toBe('2099-12-31');
  });

  it('returns available false with null airDate when episode has no air date', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        episodes: [
          { episode_number: 1, air_date: '2020-01-01' },
          { episode_number: 2, air_date: null },
        ],
      }),
    });

    const result = await isEpisodeAvailable(12345, 1, 2);

    expect(result.available).toBe(false);
    expect(result.airDate).toBeNull();
  });

  it('returns available false when episode does not exist', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        episodes: [
          { episode_number: 1, air_date: '2020-01-01' },
        ],
      }),
    });

    const result = await isEpisodeAvailable(12345, 1, 5);

    expect(result.available).toBe(false);
    expect(result.airDate).toBeNull();
  });

  it('returns available false when season fetch fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    const result = await isEpisodeAvailable(12345, 99, 1);

    expect(result.available).toBe(false);
    expect(result.airDate).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- src/services/tmdb.test.ts`
Expected: FAIL with "isEpisodeAvailable is not exported" or similar

**Step 3: Write minimal implementation**

Add to `src/services/tmdb.ts` after the existing exports:

```typescript
export interface EpisodeAvailability {
  available: boolean;
  airDate: string | null;
}

export async function isEpisodeAvailable(
  tmdbId: number,
  season: number,
  episode: number
): Promise<EpisodeAvailability> {
  const apiKey = getApiKey();
  const url = `${TMDB_BASE_URL}/tv/${tmdbId}/season/${season}?api_key=${apiKey}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return { available: false, airDate: null };
    }

    const data = await response.json();
    const episodeData = data.episodes?.find(
      (ep: { episode_number: number }) => ep.episode_number === episode
    );

    if (!episodeData) {
      return { available: false, airDate: null };
    }

    const airDate = episodeData.air_date || null;
    if (!airDate) {
      return { available: false, airDate: null };
    }

    const today = new Date().toISOString().split('T')[0];
    const available = airDate <= today;

    return { available, airDate };
  } catch {
    return { available: false, airDate: null };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- src/services/tmdb.test.ts`
Expected: PASS (all 5 tests)

**Step 5: Commit**

```bash
git add src/services/tmdb.ts src/services/tmdb.test.ts
git commit -m "feat: add isEpisodeAvailable function to check TMDB air dates"
```

---

### Task 2: Block promotion when episodes unavailable

**Files:**
- Modify: `src/services/watchlist.ts`
- Create: `src/services/watchlist.test.ts`

**Step 1: Write the failing test**

Create `src/services/watchlist.test.ts`:

```typescript
// ABOUTME: Tests for watchlist service functions.
// ABOUTME: Tests promotion blocking when episodes are unavailable.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promoteFromQueue } from './watchlist';
import { prisma } from '../lib/db';
import * as tmdb from './tmdb';

// Mock the TMDB module
vi.mock('./tmdb', () => ({
  isEpisodeAvailable: vi.fn(),
}));

describe('promoteFromQueue', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('throws error when episode is not available', async () => {
    // Create test data
    const show = await prisma.show.create({
      data: {
        tmdbId: 99999,
        title: 'Test Show',
        genres: '["Drama"]',
        totalSeasons: 2,
        totalEpisodes: 20,
        episodeRuntime: 45,
        status: 'Returning Series',
      },
    });

    const entry = await prisma.watchlistEntry.create({
      data: {
        showId: show.id,
        status: 'queued',
        currentSeason: 1,
        currentEpisode: 1,
      },
    });

    // Mock unavailable episode
    vi.mocked(tmdb.isEpisodeAvailable).mockResolvedValueOnce({
      available: false,
      airDate: '2099-12-31',
    });

    await expect(promoteFromQueue(entry.id)).rejects.toThrow(
      'No episodes available yet. Next episode airs 2099-12-31'
    );

    // Cleanup
    await prisma.watchlistEntry.delete({ where: { id: entry.id } });
    await prisma.show.delete({ where: { id: show.id } });
  });

  it('throws error with TBA when no air date known', async () => {
    const show = await prisma.show.create({
      data: {
        tmdbId: 99998,
        title: 'Test Show 2',
        genres: '["Drama"]',
        totalSeasons: 2,
        totalEpisodes: 20,
        episodeRuntime: 45,
        status: 'Returning Series',
      },
    });

    const entry = await prisma.watchlistEntry.create({
      data: {
        showId: show.id,
        status: 'queued',
        currentSeason: 1,
        currentEpisode: 1,
      },
    });

    vi.mocked(tmdb.isEpisodeAvailable).mockResolvedValueOnce({
      available: false,
      airDate: null,
    });

    await expect(promoteFromQueue(entry.id)).rejects.toThrow(
      'No episodes available yet. Air date TBA'
    );

    await prisma.watchlistEntry.delete({ where: { id: entry.id } });
    await prisma.show.delete({ where: { id: show.id } });
  });

  it('succeeds when episode is available', async () => {
    const show = await prisma.show.create({
      data: {
        tmdbId: 99997,
        title: 'Test Show 3',
        genres: '["Drama"]',
        totalSeasons: 2,
        totalEpisodes: 20,
        episodeRuntime: 45,
        status: 'Returning Series',
      },
    });

    const entry = await prisma.watchlistEntry.create({
      data: {
        showId: show.id,
        status: 'queued',
        currentSeason: 1,
        currentEpisode: 1,
      },
    });

    vi.mocked(tmdb.isEpisodeAvailable).mockResolvedValueOnce({
      available: true,
      airDate: '2020-01-01',
    });

    const result = await promoteFromQueue(entry.id);
    expect(result.status).toBe('watching');

    // Cleanup
    await prisma.showDayAssignment.deleteMany({ where: { watchlistEntryId: entry.id } });
    await prisma.watchlistEntry.delete({ where: { id: entry.id } });
    await prisma.show.delete({ where: { id: show.id } });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- src/services/watchlist.test.ts`
Expected: FAIL (promotion succeeds when it should throw)

**Step 3: Modify promoteFromQueue**

In `src/services/watchlist.ts`, add import and modify function:

Add import at top:
```typescript
import { isEpisodeAvailable } from './tmdb';
```

Modify `promoteFromQueue` function (around line 110-143):

```typescript
export async function promoteFromQueue(
  entryId: number
): Promise<WatchlistEntryWithShowAndAssignments> {
  const entry = await prisma.watchlistEntry.findUnique({
    where: { id: entryId },
    include: { show: true },
  });

  if (!entry) throw new Error('Entry not found');
  if (entry.status !== 'queued') throw new Error('Entry is not queued');

  // Check if episode is available for returning series
  if (entry.show.status === 'Returning Series') {
    const availability = await isEpisodeAvailable(
      entry.show.tmdbId,
      entry.currentSeason,
      entry.currentEpisode
    );

    if (!availability.available) {
      const dateMsg = availability.airDate
        ? `Next episode airs ${availability.airDate}`
        : 'Air date TBA';
      throw new Error(`No episodes available yet. ${dateMsg}`);
    }
  }

  const genres = JSON.parse(entry.show.genres) as string[];
  const bestDay = await findBestDayForShow(entry.show.episodeRuntime, genres);

  // Update status to watching
  await prisma.watchlistEntry.update({
    where: { id: entryId },
    data: { status: 'watching' },
  });

  // Assign to best day
  await assignShowToDay(entryId, bestDay);

  // Return with relations
  const result = await prisma.watchlistEntry.findUnique({
    where: { id: entryId },
    include: { show: true, dayAssignments: true },
  });

  if (!result) throw new Error('Entry not found after update');

  return result;
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- src/services/watchlist.test.ts`
Expected: PASS (all 3 tests)

**Step 5: Commit**

```bash
git add src/services/watchlist.ts src/services/watchlist.test.ts
git commit -m "feat: block promotion when episodes unavailable"
```

---

### Task 3: Add availability check endpoint for UI

**Files:**
- Modify: `src/routes/api/watchlist.ts`

**Step 1: Write the failing test**

Add to `src/services/watchlist.test.ts`:

```typescript
import { checkQueueAvailability } from './watchlist';

describe('checkQueueAvailability', () => {
  it('returns availability status for queued returning shows', async () => {
    const show = await prisma.show.create({
      data: {
        tmdbId: 99996,
        title: 'Returning Test',
        genres: '["Drama"]',
        totalSeasons: 2,
        totalEpisodes: 20,
        episodeRuntime: 45,
        status: 'Returning Series',
      },
    });

    const entry = await prisma.watchlistEntry.create({
      data: {
        showId: show.id,
        status: 'queued',
        currentSeason: 1,
        currentEpisode: 1,
      },
    });

    vi.mocked(tmdb.isEpisodeAvailable).mockResolvedValueOnce({
      available: false,
      airDate: '2099-06-15',
    });

    const result = await checkQueueAvailability();

    expect(result[entry.id]).toEqual({
      available: false,
      airDate: '2099-06-15',
    });

    await prisma.watchlistEntry.delete({ where: { id: entry.id } });
    await prisma.show.delete({ where: { id: show.id } });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- src/services/watchlist.test.ts`
Expected: FAIL with "checkQueueAvailability is not exported"

**Step 3: Add checkQueueAvailability function**

Add to `src/services/watchlist.ts`:

```typescript
export interface QueueAvailabilityMap {
  [entryId: number]: {
    available: boolean;
    airDate: string | null;
  };
}

export async function checkQueueAvailability(): Promise<QueueAvailabilityMap> {
  const queue = await prisma.watchlistEntry.findMany({
    where: { status: 'queued' },
    include: { show: true },
  });

  const result: QueueAvailabilityMap = {};

  for (const entry of queue) {
    // Only check returning series - ended shows are always "available"
    if (entry.show.status === 'Returning Series') {
      const availability = await isEpisodeAvailable(
        entry.show.tmdbId,
        entry.currentSeason,
        entry.currentEpisode
      );
      result[entry.id] = availability;
    } else {
      result[entry.id] = { available: true, airDate: null };
    }
  }

  return result;
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- src/services/watchlist.test.ts`
Expected: PASS

**Step 5: Add API endpoint**

Add to `src/routes/api/watchlist.ts`:

```typescript
import { checkQueueAvailability } from '../../services/watchlist';

router.get('/availability', async (req, res) => {
  try {
    const availability = await checkQueueAvailability();
    res.json(availability);
  } catch (error) {
    res.status(500).json({ error: 'Failed to check availability' });
  }
});
```

**Step 6: Commit**

```bash
git add src/services/watchlist.ts src/routes/api/watchlist.ts
git commit -m "feat: add queue availability check endpoint"
```

---

### Task 4: Update UI to show availability status

**Files:**
- Modify: `src/views/pages/watchlist.ejs`
- Modify: `src/routes/pages.ts` (if needed to pass availability data)

**Step 1: Add availability fetch to page script**

In `src/views/pages/watchlist.ejs`, add to the `<script>` section at top:

```javascript
let queueAvailability = {};

async function loadAvailability() {
  try {
    const res = await fetch('/api/watchlist/availability');
    queueAvailability = await res.json();
    updateAvailabilityBadges();
  } catch (err) {
    console.error('Failed to load availability:', err);
  }
}

function updateAvailabilityBadges() {
  Object.entries(queueAvailability).forEach(([entryId, status]) => {
    const badge = document.getElementById('availability-' + entryId);
    if (badge && !status.available) {
      const dateText = status.airDate
        ? new Date(status.airDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : 'TBA';
      badge.textContent = 'Waiting - ' + dateText;
      badge.classList.remove('hidden');
    }
  });
}

// Load on page ready
document.addEventListener('DOMContentLoaded', loadAvailability);
```

**Step 2: Add availability badge placeholder to queue items**

In the queue section (around line 199-206), after the show title and status badges, add:

```html
<span id="availability-<%= entry.id %>"
      class="hidden text-xs text-yellow-400 ml-1">
</span>
```

**Step 3: Update promote button to show alert on failure**

The existing htmx setup already shows errors via alert. Update the promote button to handle the error response better:

```html
<button type="button"
        hx-post="/api/watchlist/<%= entry.id %>/promote"
        hx-swap="none"
        hx-on::after-request="if(event.detail.failed) { alert(JSON.parse(event.detail.xhr.responseText).error); } else { location.reload(); }"
        class="bg-purple-600 hover:bg-purple-700 px-3 py-1 rounded text-sm">
  Promote
</button>
```

**Step 4: Test manually**

1. Start server: `npm run dev`
2. Navigate to watchlist page
3. Verify "Returning Series" shows in queue show "Waiting - [date]" badges for unavailable episodes
4. Try to promote an unavailable show - should see error alert
5. Promote an available show - should succeed

**Step 5: Commit**

```bash
git add src/views/pages/watchlist.ejs
git commit -m "feat: show availability status in queue UI"
```

---

### Task 5: Skip unavailable shows in scheduler

**Files:**
- Modify: `src/services/scheduler.ts`

**Step 1: Write the failing test**

Create `src/services/scheduler.test.ts`:

```typescript
// ABOUTME: Tests for scheduler service.
// ABOUTME: Verifies unavailable episodes are skipped.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateSchedule, clearSchedule } from './scheduler';
import { prisma } from '../lib/db';
import * as tmdb from './tmdb';

vi.mock('./tmdb', () => ({
  isEpisodeAvailable: vi.fn(),
}));

describe('generateSchedule', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    await clearSchedule();
  });

  it('skips shows with unavailable episodes', async () => {
    // Create a returning series show
    const show = await prisma.show.create({
      data: {
        tmdbId: 88888,
        title: 'Unavailable Show',
        genres: '["Drama"]',
        totalSeasons: 2,
        totalEpisodes: 20,
        episodeRuntime: 30,
        status: 'Returning Series',
      },
    });

    const entry = await prisma.watchlistEntry.create({
      data: {
        showId: show.id,
        status: 'watching',
        currentSeason: 2,
        currentEpisode: 5,
      },
    });

    // Assign to today
    const today = new Date().getDay();
    await prisma.showDayAssignment.create({
      data: {
        watchlistEntryId: entry.id,
        dayOfWeek: today,
      },
    });

    // Mock unavailable
    vi.mocked(tmdb.isEpisodeAvailable).mockResolvedValue({
      available: false,
      airDate: '2099-12-31',
    });

    await generateSchedule();

    // Check no episodes were scheduled
    const scheduled = await prisma.scheduledEpisode.findMany({
      where: { showId: show.id },
    });

    expect(scheduled.length).toBe(0);

    // Cleanup
    await prisma.showDayAssignment.deleteMany({ where: { watchlistEntryId: entry.id } });
    await prisma.watchlistEntry.delete({ where: { id: entry.id } });
    await prisma.show.delete({ where: { id: show.id } });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- src/services/scheduler.test.ts`
Expected: FAIL (episodes get scheduled even though unavailable)

**Step 3: Modify scheduler to check availability**

In `src/services/scheduler.ts`, add import:

```typescript
import { isEpisodeAvailable } from './tmdb';
```

Modify `fillDaySequential` function to check availability before scheduling:

```typescript
async function fillDaySequential(
  dayId: number,
  assignments: (ShowDayAssignment & { watchlistEntry: WatchlistEntry & { show: Show } })[],
  budgetMinutes: number,
  positions: Map<number, { season: number; episode: number }>
): Promise<void> {
  let remainingMinutes = budgetMinutes;
  let order = 0;

  for (const assignment of assignments) {
    if (remainingMinutes <= 0) break;

    const entry = assignment.watchlistEntry;
    const pos = positions.get(entry.id)!;
    const runtime = entry.show.episodeRuntime;

    // Check if episode is available for returning series
    if (entry.show.status === 'Returning Series') {
      const availability = await isEpisodeAvailable(
        entry.show.tmdbId,
        pos.season,
        pos.episode
      );
      if (!availability.available) {
        continue; // Skip this show, try next
      }
    }

    if (remainingMinutes >= runtime && pos.episode <= entry.show.totalEpisodes) {
      await prisma.scheduledEpisode.create({
        data: {
          scheduleDayId: dayId,
          showId: entry.show.id,
          season: pos.season,
          episode: pos.episode,
          runtime,
          order,
        },
      });

      pos.episode++;
      remainingMinutes -= runtime;
      order++;
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- src/services/scheduler.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/services/scheduler.ts src/services/scheduler.test.ts
git commit -m "feat: skip unavailable episodes in scheduler"
```

---

### Task 6: Final integration test and cleanup

**Step 1: Run all tests**

Run: `npm test`
Expected: All tests pass

**Step 2: Manual end-to-end test**

1. Start server: `npm run dev`
2. Add a returning series that's between seasons (e.g., a show you know is on hiatus)
3. Try to promote it → should show error
4. Add a show with available episodes
5. Promote it → should succeed
6. View schedule → unavailable shows should not appear

**Step 3: Commit any fixes if needed**

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat: complete episode availability checking"
```

---

## Summary

This plan implements episode availability checking with:
1. TMDB air date checking function
2. Promotion blocking for unavailable episodes
3. Queue availability API endpoint
4. UI badges showing waiting status
5. Scheduler skipping unavailable episodes

All changes follow TDD with tests before implementation.
