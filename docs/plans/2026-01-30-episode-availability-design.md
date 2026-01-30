# Episode Availability Check Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ensure returning shows can only be promoted/scheduled when episodes have actually aired.

**Architecture:** On-demand TMDB air date checks at promotion time and during schedule generation.

**Tech Stack:** TMDB API (season endpoint), TypeScript

---

## Problem

A "Returning Series" in TMDB doesn't mean episodes are currently available. The show could be:
- Between seasons waiting for the next one
- Mid-season with weekly releases where user has caught up

We need to check actual episode air dates before allowing promotion or scheduling.

## Design

### 1. TMDB Episode Data Fetching

Add to `src/services/tmdb.ts`:

```typescript
export async function isEpisodeAvailable(
  tmdbId: number,
  season: number,
  episode: number
): Promise<{ available: boolean; airDate: string | null }>
```

- Calls TMDB `/tv/{id}/season/{season}` endpoint
- Finds target episode, checks if `air_date <= today`
- Returns availability status and next air date if known

Also add helper to check if show has any available episodes from current position.

### 2. Integration Points

**Promotion (promoteFromQueue):**
- Check if user's current episode is available before promoting
- If not, reject with message: "No episodes available yet. Next episode airs [date]" or "No air date announced"

**Scheduler (fillDaySequential):**
- Skip shows where next episode hasn't aired
- Show stays "watching" but not scheduled until episodes available

**NOT checked:**
- Adding to queue (can add unreleased shows)
- Demoting (always allowed)
- Finishing (existing logic handles returning → queue)

### 3. UI Feedback

**Promotion failure:**
- API returns 400 with `{ error: "...", nextAirDate: "2026-03-15" | null }`
- UI shows alert with message

**Queue indicators:**
- Check availability on page load for "Returning Series" shows in queue
- Show badge: "Waiting - Mar 15" or "Waiting - TBA"
- No indicator if episodes available (ready to promote)

**Watching shows:**
- No indicator needed - scheduler silently skips if caught up

### 4. Testing

**Unit tests:**
- `isEpisodeAvailable` with mocked TMDB responses
- Cases: past date (available), future date (waiting), no date (TBA), missing episode, API error

**Integration tests:**
- Promote unavailable show → 400 error
- Promote available show → success
- Scheduler skips unavailable, includes available

---

*Designed 2026-01-30*
