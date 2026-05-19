# Watchlist bulk actions + genre-driven scheduling

Date: 2026-05-19

## Summary

Three related changes to how Couch Commander organizes shows across the week:

1. **Multi-select bulk actions on the watchlist.** Per-section checkboxes with a sticky action bar so the user can promote, demote, remove, or add-to-rotation many shows at once.
2. **Genre chips on show cards.** Surface the existing TMDB genres in the UI so the user can see what a show is at a glance.
3. **Genre-day affinity in the scheduler.** Let the user tag each day-of-week with one or more genres (e.g., "Tuesday: Comedy, Family"). When the scheduler places shows that are not pinned to specific days, it prefers days whose genres overlap the show's genres.

The third change introduces a clean two-mode model for shows: **pinned** (explicit `ShowDayAssignment` rows, like today) vs. **unpinned** (no day rows; scheduler decides each regen). Promote no longer auto-creates day assignments — shows start unpinned, and the user pins later if they want strict control.

## Motivation

The current model forces every watching show onto specific weekdays at promote time. This makes the watchlist tedious to manage as it grows: the user has to click day toggles for every show, and there's no convenient way to act on multiple shows at once. The scheduler's genre awareness is also stubbed but never used — `Settings.genreRules` and the `'genre'` scheduling mode are scaffolding that never got wired up.

Combining the three features lets the user run their week the way most TV viewers actually think about it: "Tuesday is comedy night, Friday is drama, and on the other days fit whatever has space." Shows they care strongly about (sports, kids' shows on Saturday morning) still pin to specific days; everything else flows.

## Data model

### New: `DayGenrePreference`

```prisma
model DayGenrePreference {
  id        Int    @id @default(autoincrement())
  dayOfWeek Int    // 0=Sunday … 6=Saturday
  genre     String

  @@unique([dayOfWeek, genre])
}
```

One row per (day-of-week, genre) pair. A day with zero rows means "no preference, anything goes." Many rows allowed per day.

### Removed

- `Settings.genreRules` field — never read by anything that matters.
- `'genre'` value from `Settings.schedulingMode` — replaced by the new affinity-based placement, which is always on for unpinned shows regardless of mode.
- `findBestDayForShow` and `getDayGenres` helpers in `src/services/dayAssignment.ts` — auto-day-picking on promote goes away with the unpinned model.

### Unchanged

- `Show.genres` (JSON array of TMDB genre names) — already populated, used as-is.
- `ShowDayAssignment` — still the pin mechanism; just no longer auto-created on promote.

## Feature 1: Multi-select bulk actions

### UI

Watchlist page (`/watchlist`), both sections (Currently Watching and Queue) get:

- A checkbox column at the left of each row.
- A "select all in section" checkbox in the section header.
- A sticky action bar inside the section, hidden until at least one item is selected. It shows: `N selected` + the buttons valid for that section.

**Queue section action bar:** `Promote` · `Remove` · `Add to rotation ▾`
**Watching section action bar:** `Demote` · `Remove` · `Add to rotation ▾`

`Add to rotation ▾` is a dropdown listing the user's existing rotations plus an "+ New rotation…" item that opens the New Rotation form pre-filled. Selecting a rotation adds every selected entry as a member (skipping any that are already members, no error).

Selection is per-section: checking boxes in the queue doesn't affect the watching action bar and vice versa. Mental model: each section is its own bulk-edit surface.

### API

All endpoints accept `{ entryIds: number[] }` in the JSON body. All call `clearSchedule()` after their mutation so the next page load regenerates.

- `POST /api/watchlist/bulk/promote` — for each entry, set `status='watching'`. **Does not create any `ShowDayAssignment` rows.** Returns `{ promoted: number[] }`.
- `POST /api/watchlist/bulk/demote` — set `status='queued'` and delete all `ShowDayAssignment` rows for those entries. Returns `{ demoted: number[] }`.
- `POST /api/watchlist/bulk/remove` — delete the `WatchlistEntry` rows. Cascades through rotation membership and day assignments as today. Returns `{ removed: number[] }`.
- `POST /api/watchlist/bulk/rotation/:rotationId` — for each entry, create a `RotationMember` (skipping P2002 unique-constraint conflicts silently). Returns `{ added: number[], skipped: number[] }`.

### Behavior notes

- Bulk promote leaves entries unpinned; the next schedule regen places them via the affinity algorithm (Feature 3).
- Bulk demote clears day assignments so a future re-promote starts from a clean unpinned state.
- The single-row Remove / Promote / Demote buttons stay; bulk endpoints are purely additive.

## Feature 2: Genre chips on show cards

A new `.genre-chip` CSS class (small pill, similar visual weight to the existing `.rotation-chip`). The chip is rendered for each entry in `Show.genres` on:

- Watchlist cards (both sections)
- Dashboard "tonight's episodes" list
- Schedule day cards (next to each scheduled episode's title)
- Rotation edit page (next to each member)

Chips are read-only. Clicking does nothing. No filter UI in this iteration — chips exist purely for at-a-glance awareness, especially to help the user understand why a show landed on a given day under the new affinity model.

## Feature 3: Genre-day affinity + unpinned scheduling

### Settings UI

A new section on `/settings` titled "Day themes." A 7-row grid, one row per day-of-week, each row showing:

- Day name (Sun, Mon, …)
- A horizontal multi-select chip picker. The available chips are the union of all genres on shows currently in the watchlist (status `watching` or `queued`). The active state for each chip reflects whether a `DayGenrePreference` row exists for that (day, genre) pair.

Toggling a chip fires `PUT /api/settings/day-genres` with `{ dayOfWeek, genres: string[] }`. The endpoint replaces all rows for that day with the new set (transactional delete + insert). `clearSchedule()` is called so the next regen picks up the change.

### Scheduler change

`doGenerateSchedule` in `src/services/scheduler.ts` gains a two-pass placement step.

**Pass 1: pinned shows + rotations.** Unchanged from today. For each day, gather `ShowDayAssignment`-based assignments (watching shows pinned to that weekday) and rotation picks, then fill with `fillDaySequential` / `fillDayRoundRobin`. The existing logic continues to apply.

**Pass 2: unpinned shows.** A new step that runs after Pass 1 fills the days that have pinned demand.

For each unpinned show (status=`watching`, zero `ShowDayAssignment` rows), and for each day in the requested window:

- Skip the day if `remainingCapacityMinutes < show.episodeRuntime` (won't fit an episode).
- Score the day:
  - `+1000` × number of show genres that appear in the day's `DayGenrePreference` rows
  - `+remainingCapacityMinutes` (so when nothing matches, capacity decides; spreads shows toward emptier days)

Place the show on the highest-scoring day. Iterate one episode per show per pass through all unpinned shows, similar to round-robin, until no more episodes fit anywhere.

Soft preference: if no day has matching genres, the show still gets scheduled — just on whichever day has the most remaining capacity.

### Pinning UX (unchanged surface, new meaning)

The existing day-checkbox row on watchlist cards stays. After a fresh promote, no boxes are checked → unpinned → affinity-based placement. Checking any box → pinned → that show only appears on those days. Clearing all boxes → returns to unpinned.

This is the same `PUT /api/watchlist/:id/days` endpoint that exists today. We just stop treating "no rows" as a degenerate state and start treating it as the meaningful "unpinned" state.

## Boundaries / file organization

- **`src/services/dayGenre.ts`** (new) — CRUD for `DayGenrePreference`, plus the affinity scoring helper used by the scheduler.
- **`src/services/scheduler.ts`** (modified) — add Pass 2 for unpinned-show placement. No change to Pass 1.
- **`src/services/dayAssignment.ts`** (modified) — delete `findBestDayForShow`, `getDayGenres`, and the variety-bonus code. Keep `getDayCapacity` (still used by the schedule-page header).
- **`src/services/watchlist.ts`** (modified) — `promoteFromQueue` no longer calls `findBestDayForShow` or creates a day assignment.
- **`src/services/settings.ts`** (modified) — remove `genreRules` getter/setter and `GenreRule` type.
- **`src/routes/api/watchlist.ts`** (modified) — add the four `/bulk/*` endpoints.
- **`src/routes/api/settings.ts`** (modified/new) — add `PUT /api/settings/day-genres`.
- **`src/routes/settings.ts`** — page route stays as-is; data fetched server-side as before.
- **`src/views/pages/watchlist.ejs`** (modified) — checkboxes, section action bars, genre chips.
- **`src/views/pages/settings.ejs`** (modified) — new "Day themes" section.
- **`src/views/pages/schedule.ejs`** + **`src/views/pages/dashboard.ejs`** + **`src/views/pages/rotations/edit.ejs`** (modified) — render `.genre-chip` next to show titles.
- **`prisma/schema.prisma`** (modified) — add `DayGenrePreference`, drop `Settings.genreRules`, and tighten the `schedulingMode` comment to no longer mention `'genre'`.

## Error handling

- Bulk endpoints validate `entryIds` is a non-empty array of integers; return 400 otherwise.
- Bulk endpoints look up entries in one query and silently skip IDs that don't exist (no partial-failure surfacing — bulk actions are best-effort).
- `POST /api/watchlist/bulk/rotation/:rotationId` skips entries already in that rotation (Prisma P2002) without erroring; reports them in `skipped`.
- `PUT /api/settings/day-genres` validates `dayOfWeek` is `0..6` and `genres` is an array of strings; 400 otherwise.
- The scheduler's Pass 2 is purely additive — if anything throws (it shouldn't; the data is plain reads + Prisma writes), Pass 1's results are still persisted because each day's `scheduleDay.upsert` already committed.

## Testing

Following the project's TDD discipline. New tests:

- **Service tests** (`src/services/dayGenre.test.ts`): CRUD + scoring helper unit tests.
- **Scheduler tests** (extend `src/services/scheduler.test.ts` or new `scheduler-affinity.test.ts`):
  - Unpinned show with one genre lands on the day whose preference matches.
  - Two unpinned shows with conflicting genre preferences both get scheduled, each on their best day.
  - Unpinned show with no matching day still gets scheduled (on the emptiest day).
  - Pinned shows continue to land on their pinned day regardless of genre preferences.
- **Watchlist API bulk tests** (extend `src/routes/api/watchlist.test.ts`): one happy-path test per bulk endpoint, plus a validation test for malformed input.
- **E2E test** (`src/e2e/genre-affinity-flow.test.ts`): full flow — set "Tuesday: Comedy", promote (unpinned) a comedy show, regen, assert episode lands on Tuesday.
- **E2E test** (extend `src/e2e/schedule-flow.test.ts` or `rotation-flow.test.ts`): bulk-promote three queued shows, regen, assert all three appear on the schedule (placed via affinity).

## Out of scope

- Filtering or searching the watchlist by genre.
- User-editable show genres (per-show overrides).
- Weighted/ranked genre preferences per day.
- Genre tags on rotations or rotation-level genre preferences.
- Migration of existing data — pinning model is backwards compatible; existing `ShowDayAssignment` rows just mean those shows stay pinned.
