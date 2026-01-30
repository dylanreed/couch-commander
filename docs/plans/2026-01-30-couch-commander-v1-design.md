# Couch Commander v1 Design

**Date**: 2026-01-30
**Status**: Approved
**Type**: Personal tool (single user, no auth)

## Overview

A personal TV scheduling app that fights binge-watching by generating daily viewing schedules based on your watchlist, available hours, and preferred watching style. Each day you check in, confirm what you watched, and the schedule adapts.

## Core Concept

You add shows to a watchlist, set how many hours you want to watch each day, pick a scheduling mode, and Couch Commander generates a rolling schedule of what to watch. Daily check-ins let you mark what you watched or skipped, and the schedule regenerates accordingly.

## Data Model

### Show
Cached from TMDB. Contains title, total episodes, episode runtime, genre tags, poster image URL, TMDB ID.

### WatchlistEntry
A show you want to watch. Links to a Show, tracks:
- Starting point (S1E1, or custom like S2E5)
- Priority (ordering in queue)
- Per-show mode preference (optional override)

### ScheduleDay
A generated day in your schedule:
- Date
- List of ScheduledEpisodes
- Total planned runtime

### ScheduledEpisode
An episode slotted into a ScheduleDay:
- Show reference
- Season/episode number
- Runtime
- Status: pending / watched / skipped

### Settings
User configuration:
- Hours per weekday (default)
- Hours per weekend (default)
- Custom hours per specific day (optional overrides)
- Default scheduling mode
- Genre rules
- Staggered start enabled/disabled

## Scheduling Logic

### Three Modes

1. **Sequential** - Watch highest-priority show until done, then next. Staggered start option offsets when lower-priority shows begin.

2. **Round-robin** - Cycle through all active shows, one episode each per rotation.

3. **Genre-slotted** - Define rules like "comedy on weekdays" or "no horror Mon-Thu". Scheduler only places matching shows in those slots.

### Filling a Day

1. Check time budget for day type (weekday/weekend/custom)
2. Apply genre rules for that day
3. Pick episodes based on mode until time is filled
4. Handle overflow: long episodes spill to next day or get skipped for shorter content

### Regeneration Triggers

Schedule regenerates when:
- Shows added/removed from watchlist
- Settings changed
- Episodes marked watched/skipped via check-in
- Manual refresh requested

## User Interface

### Pages

**Dashboard (home)**
- Today's schedule: episodes lined up with posters, titles, runtimes
- Check-in prompt if yesterday has unwatched episodes

**Watchlist**
- Queue of shows to watch
- Add shows (TMDB search), set starting point, reorder priority
- Per-show preferences, remove shows

**Schedule View**
- Week-at-a-glance calendar
- Click day for details
- See when shows will finish

**Settings**
- Daily hour budgets
- Default scheduling mode
- Genre rules
- Staggered start toggle

### Daily Check-in Flow

1. Modal/banner: "Yesterday's schedule - did you watch?"
2. List episodes with quick actions: Watched / Skipped / Later
3. Skipped/Later episodes rescheduled to upcoming days
4. Confirm, schedule regenerates

### Adding a Show

Search TMDB → Select → Set starting point → Set priority → Add → Schedule regenerates

## Technical Architecture

### Stack

- **Runtime**: Node.js + TypeScript
- **Framework**: Express.js
- **Database**: SQLite via Prisma
- **Templating**: EJS
- **Interactivity**: htmx
- **Styling**: Tailwind CSS
- **API**: TMDB (fetch wrapper)

### Project Structure

```
src/
  index.ts              # Express app entry
  routes/
    dashboard.ts        # Home/today's schedule
    watchlist.ts        # Manage shows
    schedule.ts         # Week view
    settings.ts         # User config
    api/
      shows.ts          # TMDB search, show details
      checkin.ts        # Mark episodes watched
  services/
    tmdb.ts             # TMDB API client
    scheduler.ts        # Core scheduling logic
    cache.ts            # Show data caching
  views/
    layouts/
    partials/
    pages/
prisma/
  schema.prisma
public/
  css/
  js/
```

### Key Decisions

- TMDB data cached in Shows table to minimize API calls
- Scheduler runs on-demand, not as background job
- No auth layer - personal tool
- **Port: 5055**

## Scope

### V1 (Build Now)

- TMDB search and show caching
- Watchlist management (add, remove, reorder, set start point)
- Daily hour budget settings (weekday/weekend)
- All three scheduling modes
- Genre rules configuration
- Staggered start option
- Daily check-in flow
- Dashboard, watchlist, schedule, settings pages
- Episode tracking (watched/skipped/pending)

### Deferred

- Does the Dog Die content warnings
- Google Calendar sync
- Specific clock-time scheduling
- Browser/email notifications
- Multi-user accounts
- Multi-part episode handling
- Per-show "to finish?" toggle

## Testing Strategy

- **Unit tests**: Scheduler logic (core brain)
- **Integration tests**: TMDB caching, API routes
- **E2E tests**: Add show → generate schedule → check in flow

Real SQLite test database, real TMDB calls (or cached snapshots). No mocks.
