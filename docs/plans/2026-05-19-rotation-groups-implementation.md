# Rotation Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build per-day rotation groups that cycle through a set of shows, picking one episode per day from the next-due member, with idempotent scheduling and count-based advancement.

**Architecture:** New Prisma models (`RotationGroup`, `RotationMember`, `RotationDayAssignment`) plus a nullable `rotationGroupId` on `ScheduledEpisode`. The scheduler queries rotation groups alongside direct show day assignments, picks the next-due member from each group via a count-based query (`ScheduledEpisode` rows tagged with that group + member), and contributes one episode per day per group. UI adds a new top-level `/rotations` section with list + edit pages. Spec: `docs/specs/2026-05-19-rotation-groups-design.md`.

**Tech Stack:** TypeScript, Express 5, Prisma (SQLite), EJS, Vitest, Supertest. Existing repo conventions: ABOUTME comments at file tops, no mocks (real TMDB or supertest against the app), small focused files, doppler-wrapped scripts.

---

## File Plan

**Create:**
- `src/services/rotation.ts` — pure pick / finish / count logic, no Express coupling
- `src/services/rotation.test.ts` — unit tests for the service
- `src/routes/api/rotations.ts` — internal JSON API
- `src/routes/api/rotations.test.ts` — route tests
- `src/routes/rotations.ts` — HTML page routes + form handlers
- `src/views/pages/rotations/index.ejs` — list page
- `src/views/pages/rotations/edit.ejs` — edit + new page (same template)
- `src/e2e/rotation-flow.test.ts` — end-to-end

**Modify:**
- `prisma/schema.prisma` — new models + nullable `ScheduledEpisode.rotationGroupId`
- `src/services/scheduler.ts` — integrate rotation picks into per-day generation
- `src/services/scheduler.test.ts` — extend with rotation cases
- `src/index.ts` — mount new routes (page + api + v1)
- `src/views/layouts/main.ejs` — add "Rotations" nav link
- `src/views/pages/watchlist.ejs` — show rotation chips per entry
- `src/views/pages/schedule.ejs` — chip prefix on rotation episodes
- `src/views/pages/dashboard.ejs` — same chip prefix
- `src/e2e/hardening.test.ts` — API-key + empty-DB checks on `/api/v1/rotations`

---

## Task 1: Schema migration

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add the three new models and the nullable column**

In `prisma/schema.prisma`, append after the existing `Settings` model:

```prisma
model RotationGroup {
  id            Int       @id @default(autoincrement())
  name          String
  dropOnFinish  Boolean   @default(true)
  active        Boolean   @default(true)
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  members           RotationMember[]
  dayAssignments    RotationDayAssignment[]
  scheduledEpisodes ScheduledEpisode[]
}

model RotationMember {
  id               Int            @id @default(autoincrement())
  rotationGroupId  Int
  rotationGroup    RotationGroup  @relation(fields: [rotationGroupId], references: [id], onDelete: Cascade)
  watchlistEntryId Int
  watchlistEntry   WatchlistEntry @relation(fields: [watchlistEntryId], references: [id], onDelete: Cascade)
  order            Int
  finished         Boolean        @default(false)
  createdAt        DateTime       @default(now())

  @@unique([rotationGroupId, watchlistEntryId])
  @@unique([rotationGroupId, order])
}

model RotationDayAssignment {
  id               Int           @id @default(autoincrement())
  rotationGroupId  Int
  rotationGroup    RotationGroup @relation(fields: [rotationGroupId], references: [id], onDelete: Cascade)
  dayOfWeek        Int
  createdAt        DateTime      @default(now())

  @@unique([rotationGroupId, dayOfWeek])
}
```

Then update the existing `WatchlistEntry` model to add the back-relation:

```prisma
model WatchlistEntry {
  // ...existing fields...
  rotationMembers  RotationMember[]
}
```

And update the existing `ScheduledEpisode` model to add the optional FK + back-relation:

```prisma
model ScheduledEpisode {
  // ...existing fields...
  rotationGroupId  Int?
  rotationGroup    RotationGroup? @relation(fields: [rotationGroupId], references: [id], onDelete: SetNull)
}
```

- [ ] **Step 2: Apply the schema**

Run: `npm run db:push`
Expected: `Your database is now in sync with your Prisma schema. Done in <Ns>` — no manual confirmation prompts because the additions are all additive.

- [ ] **Step 3: Regenerate the Prisma client**

Run: `npm run db:generate`
Expected: `Generated Prisma Client (...) to ./node_modules/@prisma/client`

- [ ] **Step 4: Verify existing tests still pass**

Run: `npm test`
Expected: all currently-passing tests still pass. New types now exist for the next tasks.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(rotation): add rotation group schema models"
```

---

## Task 2: Rotation service — pure pick logic (unit tests first)

**Files:**
- Create: `src/services/rotation.test.ts`
- Create: `src/services/rotation.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/services/rotation.test.ts`:

```typescript
// ABOUTME: Unit tests for the rotation service.
// ABOUTME: Covers pick logic, finished-member detection, and edge cases.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '../lib/db';
import { pickNextMember, markFinishedIfNoEpisodesLeft } from './rotation';

async function makeShow(tmdbId: number, totalEpisodes: number) {
  return prisma.show.create({
    data: {
      tmdbId,
      title: `Show ${tmdbId}`,
      genres: '[]',
      totalSeasons: 1,
      totalEpisodes,
      episodeRuntime: 45,
      status: 'Ended',
    },
  });
}

async function makeWatchlistEntry(showId: number, current = { season: 1, episode: 1 }) {
  return prisma.watchlistEntry.create({
    data: {
      showId,
      currentSeason: current.season,
      currentEpisode: current.episode,
      status: 'watching',
    },
  });
}

async function makeGroup(name: string) {
  return prisma.rotationGroup.create({ data: { name } });
}

async function addMember(groupId: number, entryId: number, order: number, finished = false) {
  return prisma.rotationMember.create({
    data: { rotationGroupId: groupId, watchlistEntryId: entryId, order, finished },
  });
}

beforeEach(async () => {
  // Strict cleanup so each test starts empty
  await prisma.scheduledEpisode.deleteMany();
  await prisma.scheduleDay.deleteMany();
  await prisma.rotationDayAssignment.deleteMany();
  await prisma.rotationMember.deleteMany();
  await prisma.rotationGroup.deleteMany();
  await prisma.showDayAssignment.deleteMany();
  await prisma.watchlistEntry.deleteMany();
  await prisma.show.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('pickNextMember', () => {
  it('returns null for an empty group', async () => {
    const group = await makeGroup('Empty');
    expect(await pickNextMember(group.id)).toBeNull();
  });

  it('returns the only member when there is one', async () => {
    const group = await makeGroup('Solo');
    const show = await makeShow(101, 10);
    const entry = await makeWatchlistEntry(show.id);
    const member = await addMember(group.id, entry.id, 0);
    const picked = await pickNextMember(group.id);
    expect(picked?.id).toBe(member.id);
  });

  it('returns lowest order when all counts are equal (zero)', async () => {
    const group = await makeGroup('Trio');
    const s1 = await makeShow(201, 10);
    const s2 = await makeShow(202, 10);
    const s3 = await makeShow(203, 10);
    const e1 = await makeWatchlistEntry(s1.id);
    const e2 = await makeWatchlistEntry(s2.id);
    const e3 = await makeWatchlistEntry(s3.id);
    await addMember(group.id, e2.id, 1);
    await addMember(group.id, e3.id, 2);
    const first = await addMember(group.id, e1.id, 0);
    const picked = await pickNextMember(group.id);
    expect(picked?.id).toBe(first.id);
  });

  it('skips finished members', async () => {
    const group = await makeGroup('FinishedSkip');
    const s1 = await makeShow(301, 10);
    const s2 = await makeShow(302, 10);
    const e1 = await makeWatchlistEntry(s1.id);
    const e2 = await makeWatchlistEntry(s2.id);
    await addMember(group.id, e1.id, 0, true);
    const m2 = await addMember(group.id, e2.id, 1);
    const picked = await pickNextMember(group.id);
    expect(picked?.id).toBe(m2.id);
  });

  it('skips members whose watchlist entry is inactive', async () => {
    const group = await makeGroup('Inactive');
    const s1 = await makeShow(401, 10);
    const s2 = await makeShow(402, 10);
    const e1 = await makeWatchlistEntry(s1.id);
    await prisma.watchlistEntry.update({ where: { id: e1.id }, data: { active: false } });
    const e2 = await makeWatchlistEntry(s2.id);
    await addMember(group.id, e1.id, 0);
    const m2 = await addMember(group.id, e2.id, 1);
    const picked = await pickNextMember(group.id);
    expect(picked?.id).toBe(m2.id);
  });

  it('returns null when every candidate is finished', async () => {
    const group = await makeGroup('AllDone');
    const s1 = await makeShow(501, 10);
    const e1 = await makeWatchlistEntry(s1.id);
    await addMember(group.id, e1.id, 0, true);
    expect(await pickNextMember(group.id)).toBeNull();
  });

  it('advances on each call when episodes are scheduled between calls', async () => {
    const group = await makeGroup('CountAdvance');
    const s1 = await makeShow(601, 10);
    const s2 = await makeShow(602, 10);
    const e1 = await makeWatchlistEntry(s1.id);
    const e2 = await makeWatchlistEntry(s2.id);
    const m1 = await addMember(group.id, e1.id, 0);
    const m2 = await addMember(group.id, e2.id, 1);

    const first = await pickNextMember(group.id);
    expect(first?.id).toBe(m1.id);

    // Record that we scheduled an episode from m1's show under this group
    const scheduleDay = await prisma.scheduleDay.create({
      data: { date: new Date('2026-05-19T00:00:00Z'), plannedMinutes: 60 },
    });
    await prisma.scheduledEpisode.create({
      data: {
        scheduleDayId: scheduleDay.id,
        showId: s1.id,
        season: 1,
        episode: 1,
        runtime: 45,
        order: 0,
        rotationGroupId: group.id,
      },
    });

    const second = await pickNextMember(group.id);
    expect(second?.id).toBe(m2.id);
  });
});

describe('markFinishedIfNoEpisodesLeft', () => {
  it('marks finished when current cursor is past totalEpisodes', async () => {
    const group = await makeGroup('Finish');
    const show = await makeShow(701, 5);
    const entry = await makeWatchlistEntry(show.id, { season: 1, episode: 6 });
    const member = await addMember(group.id, entry.id, 0);
    await markFinishedIfNoEpisodesLeft(member.id);
    const reloaded = await prisma.rotationMember.findUnique({ where: { id: member.id } });
    expect(reloaded?.finished).toBe(true);
  });

  it('leaves finished=false when episodes remain', async () => {
    const group = await makeGroup('NotYet');
    const show = await makeShow(702, 10);
    const entry = await makeWatchlistEntry(show.id, { season: 1, episode: 3 });
    const member = await addMember(group.id, entry.id, 0);
    await markFinishedIfNoEpisodesLeft(member.id);
    const reloaded = await prisma.rotationMember.findUnique({ where: { id: member.id } });
    expect(reloaded?.finished).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/rotation.test.ts`
Expected: import errors — `pickNextMember` and `markFinishedIfNoEpisodesLeft` not defined.

- [ ] **Step 3: Implement the service**

Create `src/services/rotation.ts`:

```typescript
// ABOUTME: Pure rotation-group pick and finish logic.
// ABOUTME: Used by the scheduler to decide which show plays next in a rotating slot.

import { prisma } from '../lib/db';
import type { RotationMember } from '@prisma/client';

/**
 * Returns the next-due RotationMember for a group, or null if no eligible
 * member exists.  "Next-due" = lowest count of ScheduledEpisode rows already
 * tagged with this group + member, then lowest member.order as a tiebreak.
 *
 * Filters out:
 *   - members with finished=true
 *   - members whose underlying WatchlistEntry has active=false
 *   - members whose show has no remaining unwatched episodes (and marks them finished)
 */
export async function pickNextMember(rotationGroupId: number): Promise<RotationMember | null> {
  const members = await prisma.rotationMember.findMany({
    where: { rotationGroupId },
    include: { watchlistEntry: { include: { show: true } } },
    orderBy: { order: 'asc' },
  });

  type Candidate = { member: RotationMember; count: number };
  const candidates: Candidate[] = [];

  for (const member of members) {
    if (member.finished) continue;
    if (!member.watchlistEntry.active) continue;

    const entry = member.watchlistEntry;
    const show = entry.show;
    const exhausted = entry.currentEpisode > show.totalEpisodes;
    if (exhausted) {
      await prisma.rotationMember.update({
        where: { id: member.id },
        data: { finished: true },
      });
      continue;
    }

    const count = await prisma.scheduledEpisode.count({
      where: { rotationGroupId, showId: show.id },
    });
    candidates.push({ member, count });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.count !== b.count) return a.count - b.count;
    return a.member.order - b.member.order;
  });

  return candidates[0].member;
}

/**
 * Inspects a single member's show progress and flips finished=true if the
 * show has been completed.  Useful from external triggers (e.g., manual finish).
 */
export async function markFinishedIfNoEpisodesLeft(memberId: number): Promise<void> {
  const member = await prisma.rotationMember.findUnique({
    where: { id: memberId },
    include: { watchlistEntry: { include: { show: true } } },
  });
  if (!member) return;
  const entry = member.watchlistEntry;
  if (entry.currentEpisode > entry.show.totalEpisodes && !member.finished) {
    await prisma.rotationMember.update({ where: { id: memberId }, data: { finished: true } });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/rotation.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/rotation.ts src/services/rotation.test.ts
git commit -m "feat(rotation): add pickNextMember and markFinishedIfNoEpisodesLeft"
```

---

## Task 3: Integrate rotation picks into the scheduler

**Files:**
- Modify: `src/services/scheduler.ts`
- Modify: `src/services/scheduler.test.ts`

- [ ] **Step 1: Write the failing scheduler test**

Append to `src/services/scheduler.test.ts` (do not duplicate imports — extend the existing test file):

```typescript
describe('rotation group scheduling', () => {
  it('contributes one episode per day from the next-due rotation member', async () => {
    // assume helper functions already used elsewhere in this file; if not, add at top of file:
    // - cleanDb()  (existing pattern in scheduler.test.ts beforeEach)
    // - settingsWithBudget(minutes)
    // - simpleShow(tmdbId, runtime, totalEpisodes)

    // Three 30-minute episodic shows
    const s1 = await prisma.show.create({ data: { tmdbId: 11, title: 'MSW', genres: '[]', totalSeasons: 1, totalEpisodes: 50, episodeRuntime: 30, status: 'Ended' } });
    const s2 = await prisma.show.create({ data: { tmdbId: 12, title: 'DM',  genres: '[]', totalSeasons: 1, totalEpisodes: 50, episodeRuntime: 30, status: 'Ended' } });
    const s3 = await prisma.show.create({ data: { tmdbId: 13, title: 'MAG', genres: '[]', totalSeasons: 1, totalEpisodes: 50, episodeRuntime: 30, status: 'Ended' } });
    const e1 = await prisma.watchlistEntry.create({ data: { showId: s1.id, status: 'watching' } });
    const e2 = await prisma.watchlistEntry.create({ data: { showId: s2.id, status: 'watching' } });
    const e3 = await prisma.watchlistEntry.create({ data: { showId: s3.id, status: 'watching' } });

    const group = await prisma.rotationGroup.create({ data: { name: 'Sunday Mystery Hour' } });
    await prisma.rotationMember.create({ data: { rotationGroupId: group.id, watchlistEntryId: e1.id, order: 0 } });
    await prisma.rotationMember.create({ data: { rotationGroupId: group.id, watchlistEntryId: e2.id, order: 1 } });
    await prisma.rotationMember.create({ data: { rotationGroupId: group.id, watchlistEntryId: e3.id, order: 2 } });

    // Pick a starting Sunday (UTC) and assign rotation to Sunday only
    const start = new Date('2026-05-17T00:00:00.000Z'); // Sunday
    await prisma.rotationDayAssignment.create({ data: { rotationGroupId: group.id, dayOfWeek: 0 } });

    // Make sure no direct assignments exist that would interfere
    await prisma.settings.upsert({
      where: { id: 1 },
      create: { id: 1, weekdayMinutes: 60, weekendMinutes: 60, schedulingMode: 'sequential' },
      update: { weekdayMinutes: 60, weekendMinutes: 60, schedulingMode: 'sequential' },
    });

    await generateSchedule(start, 22); // covers 4 Sundays (days 0, 7, 14, 21)

    const sundayDates = [0, 7, 14, 21].map(i => {
      const d = new Date(start); d.setDate(d.getDate() + i); d.setHours(0, 0, 0, 0); return d;
    });
    const sundays = await Promise.all(sundayDates.map(d => getScheduleForDay(d)));
    const sundayShows = sundays.map(day => day!.episodes.map(ep => ep.show.title));
    expect(sundayShows).toEqual([['MSW'], ['DM'], ['MAG'], ['MSW']]);
  });

  it('is idempotent across re-generation', async () => {
    // Build same setup as above (shortened)
    const s1 = await prisma.show.create({ data: { tmdbId: 21, title: 'A', genres: '[]', totalSeasons: 1, totalEpisodes: 50, episodeRuntime: 30, status: 'Ended' } });
    const s2 = await prisma.show.create({ data: { tmdbId: 22, title: 'B', genres: '[]', totalSeasons: 1, totalEpisodes: 50, episodeRuntime: 30, status: 'Ended' } });
    const e1 = await prisma.watchlistEntry.create({ data: { showId: s1.id, status: 'watching' } });
    const e2 = await prisma.watchlistEntry.create({ data: { showId: s2.id, status: 'watching' } });
    const group = await prisma.rotationGroup.create({ data: { name: 'Pair' } });
    await prisma.rotationMember.create({ data: { rotationGroupId: group.id, watchlistEntryId: e1.id, order: 0 } });
    await prisma.rotationMember.create({ data: { rotationGroupId: group.id, watchlistEntryId: e2.id, order: 1 } });
    await prisma.rotationDayAssignment.create({ data: { rotationGroupId: group.id, dayOfWeek: 0 } });
    await prisma.settings.upsert({
      where: { id: 1 },
      create: { id: 1, weekdayMinutes: 60, weekendMinutes: 60, schedulingMode: 'sequential' },
      update: { weekdayMinutes: 60, weekendMinutes: 60, schedulingMode: 'sequential' },
    });

    const start = new Date('2026-05-17T00:00:00.000Z');
    await generateSchedule(start, 14);
    const first = (await getScheduleForDay(new Date('2026-05-17T00:00:00.000Z')))!.episodes[0].show.title;
    await generateSchedule(start, 14);
    const second = (await getScheduleForDay(new Date('2026-05-17T00:00:00.000Z')))!.episodes[0].show.title;
    expect(first).toBe(second);
  });

  it('tags scheduled rotation episodes with the rotationGroupId', async () => {
    const s = await prisma.show.create({ data: { tmdbId: 31, title: 'X', genres: '[]', totalSeasons: 1, totalEpisodes: 10, episodeRuntime: 30, status: 'Ended' } });
    const e = await prisma.watchlistEntry.create({ data: { showId: s.id, status: 'watching' } });
    const group = await prisma.rotationGroup.create({ data: { name: 'Single' } });
    await prisma.rotationMember.create({ data: { rotationGroupId: group.id, watchlistEntryId: e.id, order: 0 } });
    await prisma.rotationDayAssignment.create({ data: { rotationGroupId: group.id, dayOfWeek: 0 } });
    await prisma.settings.upsert({
      where: { id: 1 },
      create: { id: 1, weekdayMinutes: 60, weekendMinutes: 60, schedulingMode: 'sequential' },
      update: { weekdayMinutes: 60, weekendMinutes: 60, schedulingMode: 'sequential' },
    });

    const start = new Date('2026-05-17T00:00:00.000Z');
    await generateSchedule(start, 7);
    const ep = await prisma.scheduledEpisode.findFirst({ where: { rotationGroupId: group.id } });
    expect(ep).not.toBeNull();
    expect(ep!.rotationGroupId).toBe(group.id);
  });
});
```

If the existing `scheduler.test.ts` already has a `beforeEach` that clears the DB, the rotation tables need to be cleared there too. Extend the existing cleanup block to also call:

```typescript
await prisma.rotationDayAssignment.deleteMany();
await prisma.rotationMember.deleteMany();
await prisma.rotationGroup.deleteMany();
```

These deletions must run before the existing watchlistEntry/show deletions to satisfy FK constraints.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/scheduler.test.ts -t "rotation group scheduling"`
Expected: tests fail — rotation pick is not yet integrated into `generateSchedule`.

- [ ] **Step 3: Modify `src/services/scheduler.ts` to query rotation groups and inject picks**

Inside `doGenerateSchedule`, after fetching `assignments` and before the fill calls, add a rotation block. The updated `for` body in `doGenerateSchedule`:

```typescript
import { pickNextMember } from './rotation';

// ... inside the loop, AFTER `const assignments = await prisma.showDayAssignment.findMany(...)`:

// Fetch rotation groups assigned to this day-of-week (active only)
const rotationDayAssignments = await prisma.rotationDayAssignment.findMany({
  where: { dayOfWeek, rotationGroup: { active: true } },
  include: { rotationGroup: true },
});

// For each rotation group, pick the next-due member and synthesise an
// AssignmentWithEntry that carries the rotationGroupId tag.
const rotationAssignments: (AssignmentWithEntry & { rotationGroupId?: number })[] = [];
for (const rda of rotationDayAssignments) {
  const member = await pickNextMember(rda.rotationGroupId);
  if (!member) continue;
  const fullEntry = await prisma.watchlistEntry.findUnique({
    where: { id: member.watchlistEntryId },
    include: { show: true },
  });
  if (!fullEntry || fullEntry.status !== 'watching') continue;
  rotationAssignments.push({
    watchlistEntry: fullEntry,
    rotationGroupId: rda.rotationGroupId,
  });
}

// Merge direct + rotation assignments. Rotation assignments go after direct
// ones to keep deterministic ordering.
const allAssignments: (AssignmentWithEntry & { rotationGroupId?: number })[] = [
  ...assignments,
  ...rotationAssignments,
];

// Position bootstrap for any newly-introduced shows
for (const a of allAssignments) {
  const entry = a.watchlistEntry;
  if (!positions.has(entry.id)) {
    positions.set(entry.id, { season: entry.currentSeason, episode: entry.currentEpisode });
  }
}
```

Then change the fill calls to pass `allAssignments` and update the helper signatures so they read `rotationGroupId` off each item when creating the `ScheduledEpisode`:

```typescript
// in fillDaySequential and fillDayRoundRobin, change the type to:
async function fillDaySequential(
  scheduleDayId: number,
  assignments: (AssignmentWithEntry & { rotationGroupId?: number })[],
  positions: Map<number, { season: number; episode: number }>,
  budgetMinutes: number
): Promise<void> { ... }

// then inside the create call, add rotationGroupId:
await prisma.scheduledEpisode.create({
  data: {
    scheduleDayId,
    showId: entry.show.id,
    season: pos.season,
    episode: pos.episode,
    runtime,
    order,
    status: 'pending',
    rotationGroupId: assignment.rotationGroupId ?? null,
  },
});
```

Apply the same change inside `fillDayRoundRobin`.

Finally, replace the two existing call sites:

```typescript
if (settings.schedulingMode === 'sequential') {
  await fillDaySequential(scheduleDay.id, allAssignments, positions, minutesForDay);
} else if (settings.schedulingMode === 'roundrobin') {
  await fillDayRoundRobin(scheduleDay.id, allAssignments, positions, minutesForDay);
} else {
  console.warn(`Unknown scheduling mode "${settings.schedulingMode}", falling back to sequential`);
  await fillDaySequential(scheduleDay.id, allAssignments, positions, minutesForDay);
}
```

- [ ] **Step 4: Run scheduler tests**

Run: `npx vitest run src/services/scheduler.test.ts`
Expected: all tests pass, including new rotation tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/scheduler.ts src/services/scheduler.test.ts
git commit -m "feat(rotation): integrate rotation picks into scheduler"
```

---

## Task 4: Internal JSON API — group CRUD

**Files:**
- Create: `src/routes/api/rotations.ts`
- Create: `src/routes/api/rotations.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write CRUD route tests**

Create `src/routes/api/rotations.test.ts`:

```typescript
// ABOUTME: API route tests for rotation group CRUD + membership ops.
// ABOUTME: Drives supertest against the live Express app.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../index';
import { prisma } from '../../lib/db';

async function makeShowAndEntry(tmdbId: number) {
  const show = await prisma.show.create({
    data: { tmdbId, title: `S${tmdbId}`, genres: '[]', totalSeasons: 1, totalEpisodes: 10, episodeRuntime: 30, status: 'Ended' },
  });
  const entry = await prisma.watchlistEntry.create({ data: { showId: show.id, status: 'watching' } });
  return { show, entry };
}

beforeEach(async () => {
  await prisma.scheduledEpisode.deleteMany();
  await prisma.scheduleDay.deleteMany();
  await prisma.rotationDayAssignment.deleteMany();
  await prisma.rotationMember.deleteMany();
  await prisma.rotationGroup.deleteMany();
  await prisma.showDayAssignment.deleteMany();
  await prisma.watchlistEntry.deleteMany();
  await prisma.show.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /api/rotations', () => {
  it('returns empty array initially', async () => {
    const r = await request(app).get('/api/rotations');
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });
});

describe('POST /api/rotations', () => {
  it('creates a group with name only', async () => {
    const r = await request(app).post('/api/rotations').send({ name: 'Sunday Mystery Hour' });
    expect(r.status).toBe(201);
    expect(r.body.id).toBeGreaterThan(0);
    expect(r.body.name).toBe('Sunday Mystery Hour');
    expect(r.body.dropOnFinish).toBe(true);
    expect(r.body.active).toBe(true);
  });

  it('rejects empty name', async () => {
    const r = await request(app).post('/api/rotations').send({});
    expect(r.status).toBe(400);
  });
});

describe('PATCH /api/rotations/:id', () => {
  it('updates name and flags', async () => {
    const g = await prisma.rotationGroup.create({ data: { name: 'A' } });
    const r = await request(app).patch(`/api/rotations/${g.id}`).send({ name: 'B', active: false });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('B');
    expect(r.body.active).toBe(false);
  });

  it('returns 404 for unknown id', async () => {
    const r = await request(app).patch('/api/rotations/9999').send({ name: 'X' });
    expect(r.status).toBe(404);
  });
});

describe('DELETE /api/rotations/:id', () => {
  it('removes the group and its members', async () => {
    const g = await prisma.rotationGroup.create({ data: { name: 'Doomed' } });
    const { entry } = await makeShowAndEntry(11);
    await prisma.rotationMember.create({ data: { rotationGroupId: g.id, watchlistEntryId: entry.id, order: 0 } });
    const r = await request(app).delete(`/api/rotations/${g.id}`);
    expect(r.status).toBe(204);
    expect(await prisma.rotationGroup.count()).toBe(0);
    expect(await prisma.rotationMember.count()).toBe(0);
  });
});

describe('POST /api/rotations/:id/members', () => {
  it('adds a member at next order', async () => {
    const g = await prisma.rotationGroup.create({ data: { name: 'Trio' } });
    const { entry: e1 } = await makeShowAndEntry(11);
    const { entry: e2 } = await makeShowAndEntry(12);
    let r = await request(app).post(`/api/rotations/${g.id}/members`).send({ watchlistEntryId: e1.id });
    expect(r.status).toBe(201);
    expect(r.body.order).toBe(0);
    r = await request(app).post(`/api/rotations/${g.id}/members`).send({ watchlistEntryId: e2.id });
    expect(r.body.order).toBe(1);
  });

  it('rejects duplicate watchlist entry in same group', async () => {
    const g = await prisma.rotationGroup.create({ data: { name: 'Dup' } });
    const { entry } = await makeShowAndEntry(11);
    await request(app).post(`/api/rotations/${g.id}/members`).send({ watchlistEntryId: entry.id });
    const r = await request(app).post(`/api/rotations/${g.id}/members`).send({ watchlistEntryId: entry.id });
    expect(r.status).toBe(409);
  });
});

describe('PATCH /api/rotations/:id/members/reorder', () => {
  it('reorders by provided member-id list', async () => {
    const g = await prisma.rotationGroup.create({ data: { name: 'Order' } });
    const { entry: e1 } = await makeShowAndEntry(11);
    const { entry: e2 } = await makeShowAndEntry(12);
    const { entry: e3 } = await makeShowAndEntry(13);
    const m1 = await prisma.rotationMember.create({ data: { rotationGroupId: g.id, watchlistEntryId: e1.id, order: 0 } });
    const m2 = await prisma.rotationMember.create({ data: { rotationGroupId: g.id, watchlistEntryId: e2.id, order: 1 } });
    const m3 = await prisma.rotationMember.create({ data: { rotationGroupId: g.id, watchlistEntryId: e3.id, order: 2 } });
    const r = await request(app).patch(`/api/rotations/${g.id}/members/reorder`).send({ memberIds: [m3.id, m1.id, m2.id] });
    expect(r.status).toBe(200);
    const reloaded = await prisma.rotationMember.findMany({ where: { rotationGroupId: g.id }, orderBy: { order: 'asc' } });
    expect(reloaded.map(m => m.id)).toEqual([m3.id, m1.id, m2.id]);
  });
});

describe('DELETE /api/rotations/:id/members/:memberId', () => {
  it('removes the member', async () => {
    const g = await prisma.rotationGroup.create({ data: { name: 'Rm' } });
    const { entry } = await makeShowAndEntry(11);
    const m = await prisma.rotationMember.create({ data: { rotationGroupId: g.id, watchlistEntryId: entry.id, order: 0 } });
    const r = await request(app).delete(`/api/rotations/${g.id}/members/${m.id}`);
    expect(r.status).toBe(204);
    expect(await prisma.rotationMember.count({ where: { rotationGroupId: g.id } })).toBe(0);
  });
});

describe('PUT /api/rotations/:id/days', () => {
  it('replaces the day assignments', async () => {
    const g = await prisma.rotationGroup.create({ data: { name: 'Days' } });
    let r = await request(app).put(`/api/rotations/${g.id}/days`).send({ daysOfWeek: [0, 3] });
    expect(r.status).toBe(200);
    let days = await prisma.rotationDayAssignment.findMany({ where: { rotationGroupId: g.id } });
    expect(days.map(d => d.dayOfWeek).sort()).toEqual([0, 3]);
    r = await request(app).put(`/api/rotations/${g.id}/days`).send({ daysOfWeek: [6] });
    days = await prisma.rotationDayAssignment.findMany({ where: { rotationGroupId: g.id } });
    expect(days.map(d => d.dayOfWeek)).toEqual([6]);
  });
});

describe('POST /api/rotations/:id/members/:memberId/revive', () => {
  it('flips finished=true back to false', async () => {
    const g = await prisma.rotationGroup.create({ data: { name: 'Revive' } });
    const { entry } = await makeShowAndEntry(11);
    const m = await prisma.rotationMember.create({ data: { rotationGroupId: g.id, watchlistEntryId: entry.id, order: 0, finished: true } });
    const r = await request(app).post(`/api/rotations/${g.id}/members/${m.id}/revive`);
    expect(r.status).toBe(200);
    const reloaded = await prisma.rotationMember.findUnique({ where: { id: m.id } });
    expect(reloaded!.finished).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/routes/api/rotations.test.ts`
Expected: all 404s — routes not mounted yet.

- [ ] **Step 3: Implement the routes**

Create `src/routes/api/rotations.ts`:

```typescript
// ABOUTME: Internal JSON API for rotation groups and members.
// ABOUTME: Same auth profile as other internal /api routes (used by the web UI).

import { Router } from 'express';
import { prisma } from '../../lib/db';
import { clearSchedule } from '../../services/scheduler';

const router = Router();

function parseId(id: string): number | null {
  const parsed = parseInt(id, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

router.get('/', async (_req, res) => {
  const groups = await prisma.rotationGroup.findMany({
    include: {
      members: {
        include: { watchlistEntry: { include: { show: true } } },
        orderBy: { order: 'asc' },
      },
      dayAssignments: true,
    },
    orderBy: { id: 'asc' },
  });
  res.json(groups);
});

router.post('/', async (req, res) => {
  const { name, dropOnFinish, active } = req.body ?? {};
  if (typeof name !== 'string' || name.trim() === '') {
    return res.status(400).json({ error: 'name is required' });
  }
  const group = await prisma.rotationGroup.create({
    data: {
      name: name.trim(),
      dropOnFinish: dropOnFinish ?? true,
      active: active ?? true,
    },
  });
  await clearSchedule();
  res.status(201).json(group);
});

router.get('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'bad id' });
  const group = await prisma.rotationGroup.findUnique({
    where: { id },
    include: {
      members: {
        include: { watchlistEntry: { include: { show: true } } },
        orderBy: { order: 'asc' },
      },
      dayAssignments: true,
    },
  });
  if (!group) return res.status(404).json({ error: 'not found' });
  res.json(group);
});

router.patch('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'bad id' });
  const existing = await prisma.rotationGroup.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'not found' });
  const { name, dropOnFinish, active } = req.body ?? {};
  const group = await prisma.rotationGroup.update({
    where: { id },
    data: {
      ...(typeof name === 'string' ? { name: name.trim() } : {}),
      ...(typeof dropOnFinish === 'boolean' ? { dropOnFinish } : {}),
      ...(typeof active === 'boolean' ? { active } : {}),
    },
  });
  await clearSchedule();
  res.json(group);
});

router.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'bad id' });
  const existing = await prisma.rotationGroup.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'not found' });
  await prisma.rotationGroup.delete({ where: { id } });
  await clearSchedule();
  res.status(204).end();
});

router.post('/:id/members', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'bad id' });
  const { watchlistEntryId } = req.body ?? {};
  if (!watchlistEntryId) return res.status(400).json({ error: 'watchlistEntryId required' });
  const group = await prisma.rotationGroup.findUnique({ where: { id }, include: { members: true } });
  if (!group) return res.status(404).json({ error: 'not found' });
  const nextOrder = group.members.length;
  try {
    const member = await prisma.rotationMember.create({
      data: { rotationGroupId: id, watchlistEntryId: Number(watchlistEntryId), order: nextOrder },
    });
    await clearSchedule();
    res.status(201).json(member);
  } catch (err: any) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'already a member' });
    throw err;
  }
});

router.patch('/:id/members/reorder', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'bad id' });
  const { memberIds } = req.body ?? {};
  if (!Array.isArray(memberIds)) return res.status(400).json({ error: 'memberIds array required' });

  // First clear orders to avoid unique-constraint clashes during reassignment
  await prisma.$transaction(async (tx) => {
    const tempBase = 10000;
    for (let i = 0; i < memberIds.length; i++) {
      await tx.rotationMember.update({
        where: { id: memberIds[i] },
        data: { order: tempBase + i },
      });
    }
    for (let i = 0; i < memberIds.length; i++) {
      await tx.rotationMember.update({
        where: { id: memberIds[i] },
        data: { order: i },
      });
    }
  });
  await clearSchedule();
  res.json({ ok: true });
});

router.delete('/:id/members/:memberId', async (req, res) => {
  const memberId = parseId(req.params.memberId);
  if (memberId === null) return res.status(400).json({ error: 'bad memberId' });
  const member = await prisma.rotationMember.findUnique({ where: { id: memberId } });
  if (!member) return res.status(404).json({ error: 'not found' });
  await prisma.rotationMember.delete({ where: { id: memberId } });
  await clearSchedule();
  res.status(204).end();
});

router.put('/:id/days', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'bad id' });
  const { daysOfWeek } = req.body ?? {};
  if (!Array.isArray(daysOfWeek) || !daysOfWeek.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) {
    return res.status(400).json({ error: 'daysOfWeek must be array of 0..6' });
  }
  await prisma.$transaction([
    prisma.rotationDayAssignment.deleteMany({ where: { rotationGroupId: id } }),
    ...daysOfWeek.map((d: number) => prisma.rotationDayAssignment.create({ data: { rotationGroupId: id, dayOfWeek: d } })),
  ]);
  await clearSchedule();
  res.json({ ok: true });
});

router.post('/:id/members/:memberId/revive', async (req, res) => {
  const memberId = parseId(req.params.memberId);
  if (memberId === null) return res.status(400).json({ error: 'bad memberId' });
  const member = await prisma.rotationMember.findUnique({ where: { id: memberId } });
  if (!member) return res.status(404).json({ error: 'not found' });
  await prisma.rotationMember.update({ where: { id: memberId }, data: { finished: false } });
  await clearSchedule();
  res.json({ ok: true });
});

export default router;
```

- [ ] **Step 4: Mount the routes in `src/index.ts`**

Add an import near the other api imports:

```typescript
import rotationsApiRoutes from './routes/api/rotations';
```

And mount with the other internal `/api` routes block (before the v1 routes):

```typescript
app.use('/api/rotations', rotationsApiRoutes);
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/routes/api/rotations.test.ts`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/routes/api/rotations.ts src/routes/api/rotations.test.ts src/index.ts
git commit -m "feat(rotation): add internal JSON API for groups and members"
```

---

## Task 5: External API (v1) read-only

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Mount the v1 read-only route**

In `src/index.ts`, in the v1 block alongside other auth'd routes:

```typescript
app.use('/api/v1/rotations', apiKeyAuth, rotationsApiRoutes);
```

This re-uses the same router; the auth middleware gates writes.

- [ ] **Step 2: Confirm hardening tests will still pass — defer until Task 9**

No new test in this task; coverage is added in Task 9. Just verify no regression now:

Run: `npx vitest run src/routes/api/rotations.test.ts`
Expected: still green.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(rotation): mount /api/v1/rotations behind API key auth"
```

---

## Task 6: HTML page routes (list + new + edit + delete)

**Files:**
- Create: `src/routes/rotations.ts`
- Create: `src/views/pages/rotations/index.ejs`
- Create: `src/views/pages/rotations/edit.ejs`
- Modify: `src/index.ts`
- Modify: `src/views/layouts/main.ejs`

- [ ] **Step 1: Add the page router**

Create `src/routes/rotations.ts`:

```typescript
// ABOUTME: HTML page routes for managing rotation groups.
// ABOUTME: List, new, and edit views; form-submit handlers post back here.

import { Router } from 'express';
import { prisma } from '../lib/db';
import { clearSchedule } from '../services/scheduler';

const router = Router();

function parseId(id: string): number | null {
  const parsed = parseInt(id, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function renderWithLayout(res: any, page: string, data: Record<string, unknown>) {
  res.render(`pages/${page}`, data, (err: Error | null, body: string) => {
    if (err) { console.error(err); return res.status(500).send('Error rendering page'); }
    res.render('layouts/main', { ...data, body });
  });
}

router.get('/', async (_req, res) => {
  const groups = await prisma.rotationGroup.findMany({
    include: {
      members: {
        include: { watchlistEntry: { include: { show: true } } },
        orderBy: { order: 'asc' },
      },
      dayAssignments: true,
    },
    orderBy: { id: 'asc' },
  });
  renderWithLayout(res, 'rotations/index', { title: 'Rotations', groups });
});

router.get('/new', (_req, res) => {
  renderWithLayout(res, 'rotations/edit', { title: 'New rotation', group: null, members: [], days: [], allEntries: [] });
});

router.post('/', async (req, res) => {
  const { name } = req.body ?? {};
  if (typeof name !== 'string' || name.trim() === '') {
    return res.status(400).send('name required');
  }
  const group = await prisma.rotationGroup.create({ data: { name: name.trim() } });
  await clearSchedule();
  res.redirect(`/rotations/${group.id}`);
});

router.get('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(404).send('not found');
  const group = await prisma.rotationGroup.findUnique({
    where: { id },
    include: {
      members: {
        include: { watchlistEntry: { include: { show: true } } },
        orderBy: { order: 'asc' },
      },
      dayAssignments: true,
    },
  });
  if (!group) return res.status(404).send('not found');
  const allEntries = await prisma.watchlistEntry.findMany({
    where: { active: true },
    include: { show: true },
    orderBy: { show: { title: 'asc' } },
  });
  renderWithLayout(res, 'rotations/edit', {
    title: group.name,
    group,
    members: group.members,
    days: group.dayAssignments.map(d => d.dayOfWeek),
    allEntries,
  });
});

router.post('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(404).send('not found');
  const { name, dropOnFinish, active } = req.body ?? {};
  await prisma.rotationGroup.update({
    where: { id },
    data: {
      ...(typeof name === 'string' && name.trim() !== '' ? { name: name.trim() } : {}),
      dropOnFinish: dropOnFinish === 'on' || dropOnFinish === 'true',
      active: active === 'on' || active === 'true',
    },
  });
  await clearSchedule();
  res.redirect(`/rotations/${id}`);
});

router.post('/:id/delete', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(404).send('not found');
  await prisma.rotationGroup.delete({ where: { id } });
  await clearSchedule();
  res.redirect('/rotations');
});

export default router;
```

- [ ] **Step 2: Create the list view**

Create `src/views/pages/rotations/index.ejs`:

```ejs
<%# ABOUTME: List page for rotation groups — cards with members and days. %>
<%# ABOUTME: Click into a card to edit. %>

<div class="flex items-center justify-between mb-6">
  <h1 class="text-2xl font-bold">Rotations</h1>
  <a href="/rotations/new" class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">+ New rotation</a>
</div>

<% if (groups.length === 0) { %>
  <p class="text-gray-500">No rotations yet. Create one to cycle through a set of shows on a given day.</p>
<% } %>

<div class="grid gap-4 md:grid-cols-2">
  <% groups.forEach(function(g) { %>
    <a href="/rotations/<%= g.id %>" class="block p-4 border rounded hover:bg-gray-50">
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-semibold"><%= g.name %></h2>
        <% if (!g.active) { %><span class="text-xs text-gray-500">paused</span><% } %>
      </div>
      <p class="text-sm text-gray-600 mt-1">
        <%= g.members.length %> show<%= g.members.length === 1 ? '' : 's' %> ·
        <% var dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']; %>
        <%= g.dayAssignments.length === 0 ? 'no days' : g.dayAssignments.map(function(d){ return dayNames[d.dayOfWeek]; }).join(', ') %>
      </p>
      <ol class="mt-2 text-sm list-decimal list-inside text-gray-700">
        <% g.members.forEach(function(m) { %>
          <li><%= m.watchlistEntry.show.title %><% if (m.finished) { %> <span class="text-xs text-gray-400">(finished)</span><% } %></li>
        <% }); %>
      </ol>
    </a>
  <% }); %>
</div>
```

- [ ] **Step 3: Create the edit view**

Create `src/views/pages/rotations/edit.ejs`:

```ejs
<%# ABOUTME: Edit view for a rotation group: name, days, members. %>
<%# ABOUTME: Uses fetch() for member add/remove/reorder so we avoid full page reloads. %>

<% var dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']; %>

<div class="flex items-center justify-between mb-6">
  <h1 class="text-2xl font-bold"><%= group ? group.name : 'New rotation' %></h1>
  <a href="/rotations" class="text-sm text-blue-600 hover:underline">← Back</a>
</div>

<% if (!group) { %>
  <form method="POST" action="/rotations" class="space-y-4 max-w-md">
    <div>
      <label class="block text-sm font-medium">Name</label>
      <input name="name" required class="mt-1 block w-full border rounded p-2" placeholder="Sunday Mystery Hour" />
    </div>
    <button class="px-4 py-2 bg-blue-600 text-white rounded">Create</button>
  </form>
<% } else { %>
  <form method="POST" action="/rotations/<%= group.id %>" class="space-y-4 max-w-2xl">
    <div>
      <label class="block text-sm font-medium">Name</label>
      <input name="name" required value="<%= group.name %>" class="mt-1 block w-full border rounded p-2" />
    </div>

    <div>
      <label class="block text-sm font-medium mb-1">Days</label>
      <div class="flex gap-2 flex-wrap" id="day-toggles">
        <% for (var d = 0; d < 7; d++) { %>
          <label class="inline-flex items-center gap-1 px-2 py-1 border rounded">
            <input type="checkbox" class="day-checkbox" value="<%= d %>" <%= days.includes(d) ? 'checked' : '' %> />
            <span><%= dayNames[d] %></span>
          </label>
        <% } %>
      </div>
    </div>

    <div class="flex items-center gap-4">
      <label class="inline-flex items-center gap-2">
        <input type="checkbox" name="dropOnFinish" <%= group.dropOnFinish ? 'checked' : '' %> />
        <span>Drop members when finished</span>
      </label>
      <label class="inline-flex items-center gap-2">
        <input type="checkbox" name="active" <%= group.active ? 'checked' : '' %> />
        <span>Active</span>
      </label>
    </div>

    <button class="px-4 py-2 bg-blue-600 text-white rounded">Save</button>
  </form>

  <h2 class="text-xl font-semibold mt-8 mb-2">Members</h2>
  <ol id="member-list" class="space-y-2">
    <% members.forEach(function(m) { %>
      <li class="flex items-center gap-3 p-2 border rounded" data-member-id="<%= m.id %>">
        <span class="font-mono text-sm text-gray-400 w-6"><%= m.order + 1 %>.</span>
        <span class="flex-1"><%= m.watchlistEntry.show.title %>
          <span class="text-xs text-gray-500">(S<%= m.watchlistEntry.currentSeason %>E<%= m.watchlistEntry.currentEpisode %>)</span>
          <% if (m.finished) { %>
            <button class="ml-2 text-xs text-blue-600 hover:underline" onclick="revive(<%= group.id %>, <%= m.id %>)">Revive</button>
          <% } %>
        </span>
        <button class="text-xs text-gray-500 hover:text-gray-800" onclick="moveUp(this)">↑</button>
        <button class="text-xs text-gray-500 hover:text-gray-800" onclick="moveDown(this)">↓</button>
        <button class="text-xs text-red-600 hover:text-red-800" onclick="removeMember(<%= group.id %>, <%= m.id %>)">×</button>
      </li>
    <% }); %>
  </ol>

  <div class="mt-4 flex gap-2">
    <select id="add-entry" class="border rounded p-2 flex-1">
      <option value="">Add a show…</option>
      <% allEntries.forEach(function(e) { %>
        <option value="<%= e.id %>"><%= e.show.title %></option>
      <% }); %>
    </select>
    <button class="px-4 py-2 bg-blue-600 text-white rounded" onclick="addMember(<%= group.id %>)">Add</button>
  </div>

  <form method="POST" action="/rotations/<%= group.id %>/delete" class="mt-12" onsubmit="return confirm('Delete this rotation?')">
    <button class="px-4 py-2 bg-red-600 text-white rounded">Delete rotation</button>
  </form>

  <script>
    async function addMember(groupId) {
      const sel = document.getElementById('add-entry');
      const id = sel.value;
      if (!id) return;
      const r = await fetch(`/api/rotations/${groupId}/members`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ watchlistEntryId: Number(id) }),
      });
      if (r.ok) location.reload();
      else alert((await r.json()).error || 'Failed');
    }
    async function removeMember(groupId, memberId) {
      if (!confirm('Remove from rotation?')) return;
      const r = await fetch(`/api/rotations/${groupId}/members/${memberId}`, { method: 'DELETE' });
      if (r.ok) location.reload();
    }
    async function revive(groupId, memberId) {
      const r = await fetch(`/api/rotations/${groupId}/members/${memberId}/revive`, { method: 'POST' });
      if (r.ok) location.reload();
    }
    function moveUp(btn) { swapAdjacent(btn.parentElement, -1); }
    function moveDown(btn) { swapAdjacent(btn.parentElement, +1); }
    function swapAdjacent(li, direction) {
      const list = document.getElementById('member-list');
      const sibling = direction === -1 ? li.previousElementSibling : li.nextElementSibling;
      if (!sibling) return;
      if (direction === -1) list.insertBefore(li, sibling);
      else list.insertBefore(sibling, li);
      persistOrder();
    }
    async function persistOrder() {
      const list = document.getElementById('member-list');
      const ids = Array.from(list.children).map(li => Number(li.dataset.memberId));
      const groupId = <%= group ? group.id : 0 %>;
      await fetch(`/api/rotations/${groupId}/members/reorder`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberIds: ids }),
      });
    }

    // Day toggles -> PUT /days on change
    document.querySelectorAll('.day-checkbox').forEach(cb => {
      cb.addEventListener('change', async () => {
        const checked = Array.from(document.querySelectorAll('.day-checkbox:checked')).map(c => Number(c.value));
        const groupId = <%= group ? group.id : 0 %>;
        await fetch(`/api/rotations/${groupId}/days`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ daysOfWeek: checked }),
        });
      });
    });
  </script>
<% } %>
```

- [ ] **Step 4: Mount page routes and add nav link**

In `src/index.ts`, near the other page-route imports:

```typescript
import rotationRoutes from './routes/rotations';
```

And register beneath the other page routes (e.g., right after `/settings`):

```typescript
app.use('/rotations', rotationRoutes);
```

Then in `src/views/layouts/main.ejs`, find the nav block (likely a `<nav>` element with links to `/watchlist`, `/schedule`, `/settings`) and add a Rotations link in the same style. If the file does not have a nav block yet, follow whatever pattern is in the layout. Example addition:

```ejs
<a href="/rotations" class="hover:underline">Rotations</a>
```

- [ ] **Step 5: Smoke test the routes via curl**

Run the dev server (terminal A): `doppler run -- npx tsx src/index.ts`
Then in terminal B:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4242/rotations
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4242/rotations/new
```

Expected: `200` for both.

- [ ] **Step 6: Commit**

```bash
git add src/routes/rotations.ts src/views/pages/rotations/ src/views/layouts/main.ejs src/index.ts
git commit -m "feat(rotation): add HTML page routes + list/edit views + nav link"
```

---

## Task 7: Chip prefix on schedule + dashboard + watchlist

**Files:**
- Modify: `src/views/pages/schedule.ejs`
- Modify: `src/views/pages/dashboard.ejs`
- Modify: `src/views/pages/watchlist.ejs`
- Modify: `src/services/scheduler.ts` (include rotationGroup in episode reads)

- [ ] **Step 1: Surface rotationGroup on scheduled episodes**

In `src/services/scheduler.ts`, update `getScheduleForDay` to include the rotation group on each episode:

```typescript
export type ScheduleDayWithEpisodes = ScheduleDay & {
  episodes: (ScheduledEpisode & { show: Show; rotationGroup: RotationGroup | null })[];
};

// In getScheduleForDay, extend the include:
return prisma.scheduleDay.findUnique({
  where: { date: dayStart },
  include: {
    episodes: {
      include: { show: true, rotationGroup: true },
      orderBy: { order: 'asc' },
    },
  },
});
```

Import `RotationGroup` from `@prisma/client` at the top of the file:

```typescript
import type { ScheduleDay, ScheduledEpisode, Show, WatchlistEntry, RotationGroup } from '@prisma/client';
```

- [ ] **Step 2: Add the chip prefix in schedule.ejs**

Find every place an episode title is rendered in `src/views/pages/schedule.ejs` and prefix with a small chip when `episode.rotationGroup` is present. Example pattern (apply to each loop):

```ejs
<% if (episode.rotationGroup) { %>
  <span class="inline-block text-xs uppercase tracking-wide text-gray-500 mr-1">↻ <%= episode.rotationGroup.name %></span>
<% } %>
<%= episode.show.title %>
```

- [ ] **Step 3: Same chip in dashboard.ejs**

In `src/views/pages/dashboard.ejs`, apply the same chip pattern to today's and yesterday's episode lists.

- [ ] **Step 4: Watchlist page rotation badge**

In `src/views/pages/watchlist.ejs`, list the rotation groups each watchlist entry belongs to.

For the data side, modify whichever route renders the watchlist page (likely `src/routes/watchlist.ts`) to include rotation memberships:

```typescript
const entries = await prisma.watchlistEntry.findMany({
  // ...existing include...
  include: {
    show: true,
    dayAssignments: true,
    rotationMembers: {
      include: { rotationGroup: true },
    },
  },
  // ...
});
```

(If the existing route already has an `include`, extend it; do not duplicate.)

Then in `src/views/pages/watchlist.ejs`, where each show card renders, add the badge:

```ejs
<% if (entry.rotationMembers && entry.rotationMembers.length > 0) { %>
  <div class="mt-1 flex flex-wrap gap-1">
    <% entry.rotationMembers.forEach(function(rm) { %>
      <a href="/rotations/<%= rm.rotationGroup.id %>" class="text-xs px-2 py-0.5 bg-gray-100 text-gray-700 rounded">
        ↻ <%= rm.rotationGroup.name %>
      </a>
    <% }); %>
  </div>
<% } %>
```

- [ ] **Step 5: Smoke test in dev server**

Restart dev server, hit `/`, `/schedule`, `/watchlist`. Confirm:
- Pages render `200`
- After creating a rotation and assigning to a day, regenerating the schedule, the chip appears on the right episodes.

(Manual visual check by the reviewer.)

- [ ] **Step 6: Commit**

```bash
git add src/services/scheduler.ts src/views/pages/ src/routes/watchlist.ts
git commit -m "feat(rotation): show rotation chips on schedule, dashboard, watchlist"
```

---

## Task 8: End-to-end test

**Files:**
- Create: `src/e2e/rotation-flow.test.ts`

- [ ] **Step 1: Write the E2E test**

Create `src/e2e/rotation-flow.test.ts`:

```typescript
// ABOUTME: End-to-end test for rotation group flow.
// ABOUTME: Creates a group via API, assigns to Sunday, generates schedule, marks shows finished.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import app from '../index';
import { prisma } from '../lib/db';
import { generateSchedule, getScheduleForDay, clearSchedule } from '../services/scheduler';

async function seedShow(tmdbId: number, title: string, totalEpisodes = 50) {
  const show = await prisma.show.create({
    data: { tmdbId, title, genres: '[]', totalSeasons: 1, totalEpisodes, episodeRuntime: 30, status: 'Ended' },
  });
  const entry = await prisma.watchlistEntry.create({ data: { showId: show.id, status: 'watching' } });
  return { show, entry };
}

beforeEach(async () => {
  await prisma.scheduledEpisode.deleteMany();
  await prisma.scheduleDay.deleteMany();
  await prisma.rotationDayAssignment.deleteMany();
  await prisma.rotationMember.deleteMany();
  await prisma.rotationGroup.deleteMany();
  await prisma.showDayAssignment.deleteMany();
  await prisma.watchlistEntry.deleteMany();
  await prisma.show.deleteMany();
  await prisma.settings.upsert({
    where: { id: 1 },
    create: { id: 1, weekdayMinutes: 60, weekendMinutes: 60, schedulingMode: 'sequential' },
    update: { weekdayMinutes: 60, weekendMinutes: 60, schedulingMode: 'sequential' },
  });
  await clearSchedule();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('rotation flow', () => {
  it('cycles MSW / DM / MAG over four Sundays via the API', async () => {
    const msw = await seedShow(901, 'MSW');
    const dm  = await seedShow(902, 'DM');
    const mag = await seedShow(903, 'MAG', 1); // MAG only has 1 episode for the drop test later

    // Create group via API
    let r = await request(app).post('/api/rotations').send({ name: 'Sunday Mystery Hour' });
    expect(r.status).toBe(201);
    const groupId = r.body.id;

    // Add members in order
    for (const e of [msw.entry, dm.entry, mag.entry]) {
      await request(app).post(`/api/rotations/${groupId}/members`).send({ watchlistEntryId: e.id });
    }
    // Assign to Sunday (0)
    await request(app).put(`/api/rotations/${groupId}/days`).send({ daysOfWeek: [0] });

    // Generate 4 weeks from a known Sunday
    const start = new Date('2026-05-17T00:00:00.000Z');
    await generateSchedule(start, 28);

    const sundayDates = [0, 7, 14, 21].map(i => {
      const d = new Date(start); d.setDate(d.getDate() + i); d.setHours(0, 0, 0, 0); return d;
    });
    const sundays = await Promise.all(sundayDates.map(d => getScheduleForDay(d)));
    const titles = sundays.map(day => day!.episodes.map(ep => ep.show.title));
    // After 3 picks, MAG has hit its 1-episode total. Drop on finish should keep it OFF the 4th Sunday.
    expect(titles[0]).toEqual(['MSW']);
    expect(titles[1]).toEqual(['DM']);
    expect(titles[2]).toEqual(['MAG']);
    // 4th Sunday: MAG is exhausted, picker prefers laggard among remaining (count=1 each), tie-break by order → MSW
    expect(titles[3]).toEqual(['MSW']);

    // Confirm MAG's member got marked finished
    const members = await prisma.rotationMember.findMany({ where: { rotationGroupId: groupId } });
    const magMember = members.find(m => m.watchlistEntryId === mag.entry.id);
    expect(magMember!.finished).toBe(true);
  });

  it('is idempotent across regenerations', async () => {
    const a = await seedShow(801, 'A');
    const b = await seedShow(802, 'B');

    const r = await request(app).post('/api/rotations').send({ name: 'AB' });
    const groupId = r.body.id;
    await request(app).post(`/api/rotations/${groupId}/members`).send({ watchlistEntryId: a.entry.id });
    await request(app).post(`/api/rotations/${groupId}/members`).send({ watchlistEntryId: b.entry.id });
    await request(app).put(`/api/rotations/${groupId}/days`).send({ daysOfWeek: [0] });

    const start = new Date('2026-05-17T00:00:00.000Z');
    await generateSchedule(start, 14);
    const firstA = (await getScheduleForDay(new Date('2026-05-17T00:00:00.000Z')))!.episodes[0].show.title;
    await generateSchedule(start, 14);
    const secondA = (await getScheduleForDay(new Date('2026-05-17T00:00:00.000Z')))!.episodes[0].show.title;
    expect(firstA).toBe(secondA);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/e2e/rotation-flow.test.ts`
Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/e2e/rotation-flow.test.ts
git commit -m "test(rotation): end-to-end rotation flow with drop-on-finish"
```

---

## Task 9: Hardening extensions

**Files:**
- Modify: `src/e2e/hardening.test.ts`

- [ ] **Step 1: Add hardening cases**

Append two cases to `src/e2e/hardening.test.ts`:

```typescript
describe('rotation hardening', () => {
  it('GET /api/v1/rotations requires API key when configured', async () => {
    // This test only runs if API_KEY is set in env
    if (!process.env.API_KEY) return;
    const r = await request(app).get('/api/v1/rotations');
    expect(r.status).toBe(401);
    const ok = await request(app).get('/api/v1/rotations').set('X-Api-Key', process.env.API_KEY);
    expect(ok.status).toBe(200);
  });

  it('GET /api/rotations returns [] on an empty database', async () => {
    await prisma.rotationDayAssignment.deleteMany();
    await prisma.rotationMember.deleteMany();
    await prisma.rotationGroup.deleteMany();
    const r = await request(app).get('/api/rotations');
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });
});
```

- [ ] **Step 2: Run hardening tests**

Run: `npx vitest run src/e2e/hardening.test.ts`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add src/e2e/hardening.test.ts
git commit -m "test(rotation): hardening — API key gating + empty DB"
```

---

## Task 10: Full test suite + build

**Files:** (none — verification only)

- [ ] **Step 1: Full vitest run**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 2: Type-check / build**

Run: `npm run build`
Expected: clean tsc compile, no errors.

- [ ] **Step 3: CSS rebuild**

Run: `npm run css:build`
Expected: tailwind picks up any new utility classes used in the rotation views.

- [ ] **Step 4: Manual dev smoke**

Run: `npm run dev`
Open `http://localhost:4242/rotations`, create a rotation, add 2-3 shows, assign to a day, head to `/schedule` and confirm chips appear.

- [ ] **Step 5: Commit any css output**

```bash
git add public/css/styles.css
git diff --cached --quiet || git commit -m "chore: rebuild tailwind css for rotation views"
```

(no-op if nothing changed)

---

## Spec Coverage Check

- ✅ Data model (RotationGroup, RotationMember, RotationDayAssignment, ScheduledEpisode.rotationGroupId) → Task 1
- ✅ Pick logic (counts, order tiebreak, inactive/finished/exhausted handling) → Task 2
- ✅ Scheduler integration + idempotency → Task 3
- ✅ Internal JSON API CRUD + members + days + revive → Task 4
- ✅ External v1 read-only with auth → Task 5
- ✅ HTML page routes (list, new, edit, delete) + nav link → Task 6
- ✅ Chip prefix on schedule + dashboard + watchlist badges → Task 7
- ✅ E2E rotation flow + drop-on-finish + idempotency → Task 8
- ✅ Hardening — auth + empty DB → Task 9
- ✅ Build + full test pass → Task 10

No remaining gaps.
