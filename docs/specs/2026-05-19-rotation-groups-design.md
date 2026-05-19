# Rotation Groups — Design

**Status:** Approved (2026-05-19)
**Author:** Dylan + Cosmo
**Implements:** Per-slot rotating show selection (e.g., Sundays cycle through Murder She Wrote → Diagnosis Murder → Magnum P.I.)

## Goal

Let a single day-of-week assignment cycle through several shows instead of being tied to one. The active show advances each time the slot fires (i.e., each time the scheduler picks an episode from the group), not on a calendar timer.

## Non-Goals

- Calendar-week-based rotation.
- Per-rotation watch progress. Rotations share the show's global cursor.
- Manual "play this next" override. (Future work.)
- Plex integration. Tracked separately; rotation groups will feed it later.

## Mental Model

A `RotationGroup` is a peer to a show on day assignments. A day-of-week can be assigned to any mix of individual shows and rotation groups. When the scheduler generates a day, each rotation group contributes **one episode** — picked from the next member due, where "next due" means the member with the fewest episodes already scheduled from this group.

The active member is **derived from data**, not stored. Counting tagged `ScheduledEpisode` rows gives a self-healing, idempotent cursor.

## Data Model

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
  order            Int            // 0-based position
  finished         Boolean        @default(false)

  @@unique([rotationGroupId, watchlistEntryId])
  @@unique([rotationGroupId, order])
}

model RotationDayAssignment {
  id               Int           @id @default(autoincrement())
  rotationGroupId  Int
  rotationGroup    RotationGroup @relation(fields: [rotationGroupId], references: [id], onDelete: Cascade)
  dayOfWeek        Int           // 0=Sunday..6=Saturday

  @@unique([rotationGroupId, dayOfWeek])
}

// Existing model — add one nullable column:
model ScheduledEpisode {
  // ...existing fields...
  rotationGroupId  Int?
  rotationGroup    RotationGroup? @relation(fields: [rotationGroupId], references: [id], onDelete: SetNull)
}
```

A show may belong to multiple rotation groups (no global uniqueness on `watchlistEntryId`). Per-group uniqueness still applies — a show cannot appear twice in the same group.

A show in a rotation shares the same `WatchlistEntry.currentSeason/currentEpisode` it uses everywhere else. If MSW is in two groups, both advance the same cursor. This is the simpler model and matches the "the show progresses, regardless of which slot fires it" intuition.

## Scheduler Behavior

For each day in the schedule window:

1. Collect direct show assignments for that day-of-week (unchanged).
2. Collect rotation group assignments for that day-of-week (new).
3. For each rotation group on this day, **pick the next-up member**:
   - Filter members where `finished = false` AND the underlying watchlist entry is `active = true` AND the show has at least one unwatched episode.
   - Sort by `(count of ScheduledEpisodes from this group for this member ASC, order ASC)`.
   - Take the first. Generate one episode using existing per-show logic.
   - Tag `ScheduledEpisode.rotationGroupId = group.id`.
   - If a candidate has no unwatched episodes, set `finished = true` and re-pick.
   - If no candidates remain, log a warning and skip the slot for this day.

The count-based pick makes regeneration **idempotent**. Running the scheduler N times in a row over the same window yields the same schedule. No cursor field needed; no double-advancement bug possible.

Existing time-budget and overflow logic apply unchanged. Rotation episodes can spill into the "Doesn't Fit" section like any other episode.

## UI Surface

**New nav item: "Rotations"** alongside Watchlist and Schedule.

`/rotations` — list page. Cards per group: name, ordered member list (with each member's current S/E), day badges, active/inactive flag.

`/rotations/:id` — edit page:
- Name field
- Member list: drag/drop reorder; add via watchlist-entry-only search; remove via × button. Each member shows the show's current S/E.
- Day assignment: Sun-Sat checkboxes
- `Drop members from rotation when finished` toggle
- `Active` toggle (pause without deleting)
- Delete (with confirm)
- "Revive" button next to finished members so a user can put them back in rotation manually.

`/rotations/new` — same form, empty state.

**Touchpoints to existing pages:**
- **Watchlist:** each show card displays a small chip per rotation group it belongs to, e.g. "↻ Sunday Mystery Hour" linking to the group edit page.
- **Schedule (today/week views):** episodes with a `rotationGroupId` get a chip prefix above the title, e.g. *"Sunday Mystery Hour"* — *Murder, She Wrote S2E14*. The chip is visually subordinate to the show title.
- **Dashboard:** same chip treatment as Schedule.

**Settings:** no changes.

## API

Page routes (HTML, no API key):

| Method | Path                       | Purpose                |
| ------ | -------------------------- | ---------------------- |
| GET    | `/rotations`               | List page              |
| GET    | `/rotations/new`           | New form               |
| POST   | `/rotations`               | Create                 |
| GET    | `/rotations/:id`           | Edit page              |
| POST   | `/rotations/:id`           | Update via form submit |
| POST   | `/rotations/:id/delete`    | Delete                 |

Internal JSON API (same auth as existing `/api/*`):

| Method | Path                                          | Body                              |
| ------ | --------------------------------------------- | --------------------------------- |
| GET    | `/api/rotations`                              | —                                 |
| POST   | `/api/rotations`                              | `{ name, dropOnFinish?, active? }` |
| GET    | `/api/rotations/:id`                          | —                                 |
| PATCH  | `/api/rotations/:id`                          | partial body                       |
| DELETE | `/api/rotations/:id`                          | —                                 |
| POST   | `/api/rotations/:id/members`                  | `{ watchlistEntryId, order? }`    |
| PATCH  | `/api/rotations/:id/members/reorder`          | `{ memberIds: [id1, id2, …] }`    |
| DELETE | `/api/rotations/:id/members/:memberId`        | —                                 |
| PUT    | `/api/rotations/:id/days`                     | `{ daysOfWeek: [0..6] }`          |
| POST   | `/api/rotations/:id/members/:memberId/revive` | —                                 |

External API (`/api/v1/`, API-key auth):

| Method | Path                | Purpose                                |
| ------ | ------------------- | -------------------------------------- |
| GET    | `/api/v1/rotations` | Read-only, for Homepage-style consumers |

## Edge Cases

1. **Watchlist entry deleted.** `RotationMember` cascades. If the group is now empty, the scheduler skips it; the group stays in the UI for repopulation.
2. **Watchlist entry deactivated** (`active=false`). The scheduler filters it out of the pick the same way it does for direct assignments.
3. **Show finishes mid-window.** The picker detects "no unwatched episodes," sets `finished=true`, re-picks the next member in the same pass.
4. **All members finished.** If `dropOnFinish=true`, the group is effectively dead. Scheduler logs once per regen and skips. UI offers "Revive" to restart.
5. **New member added to a long-running rotation.** It starts at count=0 and dominates the next picks until counts equalize. A tooltip on Add will explain this.
6. **Time budget overflow.** Rotation episodes spill into "Doesn't Fit" like any others. Existing overflow handling unchanged.
7. **Idempotent regeneration.** Count-based pick is naturally idempotent. Deleting a scheduled episode (manual cleanup) decrements the count and self-heals on the next regen.

## Migration

New tables: `RotationGroup`, `RotationMember`, `RotationDayAssignment`. New nullable column `rotationGroupId` on `ScheduledEpisode`. SQLite handles all of this with `prisma db push --skip-generate`, matching the existing release command. No data backfill required.

## Testing

TDD discipline per `CLAUDE.md`. Tests first.

**Unit — `src/services/rotation.test.ts` (new):**
- `pickNextMember(group)`:
  - Single member → returns that member.
  - Multiple members, all count=0 → returns lowest `order`.
  - One member ahead in count → returns the laggard.
  - Tied counts → returns lowest `order`.
  - One member finished → skipped.
  - All members finished → returns null, logs once.
  - Member's watchlist entry inactive → skipped.
  - Member's show has no unwatched episodes → marks `finished=true`, re-picks.
- `markFinishedIfNoEpisodesLeft(member)` standalone.

**Scheduler integration — extend `src/services/scheduler.test.ts`:**
- Day with only a rotation group assigned → one rotation episode appears.
- Day with rotation + direct show → both contribute, time budget respected.
- Regeneration over the same window is idempotent.
- 14-day window with a 3-member rotation → counts increment evenly.

**Route — `src/routes/api/rotations.test.ts` (new):**
- CRUD; member add/remove/reorder; day-assignment PUT; revive; 404/400 error paths.

**E2E — `src/e2e/rotation-flow.test.ts` (new):**
- Create 3 stubbed shows; build a Sunday Mystery Hour rotation; generate 4 weeks.
- Assert Sundays cycle MSW / DM / Magnum / MSW.
- Mark all Magnum episodes watched via checkin → 5th Sunday is DM (Magnum dropped).
- Regenerate → no double-advancement.

**Hardening — extend `src/e2e/hardening.test.ts`:**
- API-key required on `/api/v1/rotations`.
- Empty DB → `GET /api/rotations` returns `[]`.

## Open Questions

None blocking. Future-work items:
- Manual "skip next show in rotation" / "play X next" override.
- Per-rotation progress cursor (Option Y), if comfort-rewatch use cases emerge.
- Plex playlist integration that groups rotation episodes by their `rotationGroupId`.
