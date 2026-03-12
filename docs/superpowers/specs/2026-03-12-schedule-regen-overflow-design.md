# Schedule Regeneration & "Doesn't Fit" Overflow

## Goal

Let users manually regenerate the weekly schedule and see which promoted shows couldn't be scheduled due to time budget constraints.

## Context

Currently, the schedule auto-regenerates when stale (settings change, schedule cleared). But after reassigning show days on the watchlist page, users have no way to trigger a fresh schedule without navigating to settings and saving. Additionally, when a day's time budget is exceeded, overflow shows are silently omitted with no visibility.

## Design

### Regenerate Button

- A "Regenerate" button in the schedule page header, next to the "Weekly Schedule" title.
- Uses HTMX: `hx-post="/api/schedule/regenerate"` with `hx-on::after-request="location.reload()"` and `hx-swap="none"` to trigger a full page reload after the schedule is rebuilt.
- The endpoint clears only future schedule days (today and forward), preserving watched/skipped status on past days, then calls `generateSchedule(today, 7)`.
- Returns 200 on success so the HTMX after-request handler reloads the page with fresh data.
- Button shows a loading indicator class while the request is in flight.

### "Doesn't Fit" Overflow Section

- After the weekly day cards, a section titled "Doesn't Fit" appears listing shows that are promoted (status: `watching`) and assigned to at least one day but received zero scheduled episodes across the entire 7-day window.
- Excludes shows that have no remaining episodes (i.e., `currentEpisode > totalEpisodes`) — those aren't overflow, they're done.
- Each overflow entry shows: show title, poster thumbnail, episode runtime, and which days it's assigned to.
- The section is hidden when all watching shows fit in the schedule.
- This is informational only — the user's action path is to adjust day assignments or time budgets elsewhere, then hit Regenerate.

### Computing Overflow

Overflow is computed at query time in the schedule route, not stored and not inside the scheduler:

1. Get all `watching` watchlist entries that have at least one day assignment AND have remaining episodes (`currentEpisode <= show.totalEpisodes`).
2. Get all unique `showId` values from `ScheduledEpisode` records within the schedule window (today through today+6).
3. Any entry from step 1 whose `showId` does NOT appear in step 2 is overflow.

This avoids schema changes and keeps the scheduler focused on generation only.

**Assumption:** The overflow window always matches the schedule window (currently hardcoded at 7 days). If the schedule window becomes configurable, overflow detection must use the same value.

### Data Flow

```
User clicks "Regenerate"
  → POST /api/schedule/regenerate
  → Delete future ScheduledEpisode/ScheduleDay records (today+)
  → generateSchedule(today, 7)
  → 200 response → HTMX reloads page

Schedule page loads
  → Generate schedule if stale (existing behavior)
  → Query 7 days of schedule data (existing behavior)
  → Compute overflow shows (new)
  → Render weekly grid + "Doesn't Fit" section
```

### Files Changed

- **`src/routes/schedule.ts`** — Add POST `/regenerate` endpoint (clears future schedule, regenerates). Add overflow computation to GET `/` handler. The overflow logic lives here in the route, not in the scheduler service.
- **`src/views/pages/schedule.ejs`** — Add regenerate button in header. Add "Doesn't Fit" section below day cards.

### Files NOT Changed

- No schema changes.
- No changes to `doGenerateSchedule()` internals — overflow is computed after the fact by the route.
- No changes to settings, watchlist, or dayAssignment services.

## Non-Goals

- No inline actions on overflow shows (no "move to Monday" buttons). Users adjust via the watchlist page.
- No per-day overflow breakdown — one flat list for the whole week.
- No persistence of overflow state — computed fresh each page load.

## Testing

- Unit test overflow computation: given shows assigned to days but not enough budget, verify correct shows returned and completed shows excluded.
- Integration test regenerate endpoint: POST returns 200, schedule is regenerated, past watched episodes preserved.
- E2E: schedule page with overflow shows renders the "Doesn't Fit" section; without overflow, section is hidden.
