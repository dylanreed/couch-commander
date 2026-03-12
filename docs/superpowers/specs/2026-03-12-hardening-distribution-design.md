# Couch Commander: Hardening & Distribution

**Date:** 2026-03-12
**Status:** Approved
**Phase:** 1 of 3 (Hardening → Plex Integration → ARR Integration)

## Goal

Make Couch Commander a reliable, self-contained Docker container that anyone can add to their *arr stack (Sonarr, Radarr, Prowlarr) with a single `docker compose` entry. Follow Servarr community conventions so tools like Homepage, Organizr, and Homarr can auto-discover and display it.

## Scope

Three workstreams, all equally important:

1. Container hardening — stop crashing, handle errors gracefully
2. Servarr-style API — versioned routes, API key auth, system endpoints
3. Distribution polish — docs, labels, example configs

### Out of Scope (Later Phases)

- Plex watch status sync (phase 2)
- Sonarr/Radarr API integration (phase 3)
- Multi-user support

---

## 1. Container Hardening

### 1.1 Graceful Shutdown

Add `SIGTERM`/`SIGINT` handlers in `index.ts`:

- Stop accepting new HTTP connections
- Wait for in-flight requests to finish (5s timeout)
- Disconnect Prisma client (`prisma.$disconnect()`)
- Exit cleanly

This prevents SQLite corruption when Docker stops the container.

### 1.2 Healthcheck Fix

**Current problem:** The Docker healthcheck hits `/` which calls `generateSchedule(today, 14)` — a heavy write operation — every 30 seconds. This contributes to SQLite locking.

**Fix:** Change the healthcheck in the Dockerfile to hit `GET /ping` instead. The `/ping` endpoint returns `{ status: "ok" }` with no DB access.

```dockerfile
healthcheck:
  test: ["CMD", "node", "-e", "require('http').get('http://localhost:4242/ping', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"]
  interval: 30s
  timeout: 10s
  retries: 3
  start_period: 15s
```

Add `start_period` so the container has time to run migrations before the first check.

### 1.3 Startup Resilience

Wrap the Prisma schema push (CMD in Dockerfile) so a failed migration doesn't silently leave the app running against a broken schema. Add retry logic:

```sh
npx prisma db push --skip-generate || { echo "DB migration failed"; exit 1; }
```

The PRAGMA configuration in `db.ts` already catches and logs failures without crashing — that stays.

### 1.4 SQLite Pragmas

Already implemented (this session):

- `busy_timeout = 5000` — wait instead of failing on contention
- `journal_mode = WAL` — concurrent reads while writing

Add one more:

- `PRAGMA synchronous = NORMAL` — safe with WAL mode, better write performance on NAS filesystems (BTRFS, ext4 over SMB)

### 1.5 Error Handling in Routes

Wrap all page routes (`/`, `/watchlist`, `/schedule`, `/settings`) in try-catch blocks that render a user-friendly error page instead of returning raw 500 text. API routes already return JSON errors — those are fine.

Create `src/views/pages/error.ejs` — simple page showing "Something went wrong" with a retry link.

### 1.6 Schedule Generation Guard

**Current problem:** Every visit to `/` regenerates 14 days of schedule, even if nothing changed. Every visit to `/schedule` regenerates 7 days.

**Fix:** Before generating, check if a schedule already exists for the requested window. Only regenerate if:
- No schedule exists for the date range
- The schedule was invalidated (via `clearSchedule()` from watchlist changes)

Add a `scheduleStale` flag (in-memory boolean, defaults to `true` on startup). `clearSchedule()` sets it to `true`. After successful generation, set to `false`. Page routes check the flag before calling `generateSchedule`.

---

## 2. Servarr-Style API

### 2.1 Route Structure

Move all API routes under `/api/v1/`:

| Current | New | Notes |
|---------|-----|-------|
| `GET /api/shows/search` | `GET /api/v1/shows/search` | Show search |
| `POST /api/watchlist` | `POST /api/v1/watchlist` | Add show |
| `DELETE /api/watchlist/:id` | `DELETE /api/v1/watchlist/:id` | Remove show |
| `POST /api/watchlist/:id/promote` | `POST /api/v1/watchlist/:id/promote` | Promote |
| `POST /api/watchlist/:id/finish` | `POST /api/v1/watchlist/:id/finish` | Finish |
| `POST /api/watchlist/:id/demote` | `POST /api/v1/watchlist/:id/demote` | Demote |
| `PUT /api/watchlist/:id/days` | `PUT /api/v1/watchlist/:id/days` | Set days |
| `PUT /api/watchlist/:id/episode` | `PUT /api/v1/watchlist/:id/episode` | Update position |
| `GET /api/watchlist/availability` | `GET /api/v1/watchlist/availability` | Check queue |
| `POST /api/checkin` | `POST /api/v1/checkin` | Daily check-in |
| (new) | `GET /api/v1/system/status` | System info |
| (new) | `GET /api/v1/health` | Health checks |
| (new) | `GET /ping` | Unauthenticated ping |

Keep current `/api/*` routes as aliases during transition so the existing HTMX frontend doesn't break. The frontend templates get updated to use `/api/v1/` paths.

### 2.2 API Key Authentication

New middleware: `src/middleware/apiKey.ts`

- Reads `API_KEY` env var
- If `API_KEY` is set, all `/api/v1/*` routes require `X-Api-Key` header matching the value
- If `API_KEY` is not set, auth is disabled (single-user home network default)
- `GET /ping` is always unauthenticated
- Page routes (`/`, `/watchlist`, etc.) are unauthenticated — they're the web UI

This matches Sonarr/Radarr behavior: API key protects the API, web UI is open.

### 2.3 System Endpoints

**`GET /api/v1/system/status`**

```json
{
  "appName": "Couch Commander",
  "version": "1.0.0",
  "startupPath": "/app",
  "runtimeVersion": "22.x.x",
  "databaseType": "sqlite",
  "uptime": 3600
}
```

Version read from `package.json`. Uptime calculated from process start.

**`GET /api/v1/health`**

```json
{
  "checks": [
    { "source": "database", "type": "ok", "message": "SQLite responding" },
    { "source": "tmdb", "type": "warning", "message": "TMDB_API_KEY not configured" }
  ]
}
```

Checks:
- Database: run `SELECT 1` via Prisma
- TMDB: verify `TMDB_API_KEY` env var exists (don't call the API on every health check)

**`GET /ping`**

```json
{ "status": "ok" }
```

No auth, no DB, instant response. For Docker healthchecks and load balancers.

---

## 3. Distribution Polish

### 3.1 Dockerfile Labels

Add OCI labels for GHCR package display:

```dockerfile
LABEL org.opencontainers.image.title="Couch Commander"
LABEL org.opencontainers.image.description="TV viewing schedule manager for your *arr stack"
LABEL org.opencontainers.image.url="https://github.com/dylanreed/couch-commander"
LABEL org.opencontainers.image.source="https://github.com/dylanreed/couch-commander"
LABEL org.opencontainers.image.licenses="MIT"
```

### 3.2 Example Docker Compose

Create `docker-compose.example.yml` with full comments:

```yaml
services:
  couch-commander:
    image: ghcr.io/dylanreed/couch-commander:latest
    container_name: couch-commander
    restart: unless-stopped
    ports:
      - "4242:4242"
    volumes:
      - ./couch-commander-data:/data  # SQLite database lives here
    environment:
      - TMDB_API_KEY=your_key_here    # Required: get one at https://www.themoviedb.org/settings/api
      - API_KEY=                       # Optional: set to protect API endpoints
      - PORT=4242                      # Optional: change the port
```

### 3.3 README

Rewrite `README.md` with these sections:

1. **What it is** — one paragraph, no throat-clearing
2. **Quick start** — docker run one-liner + docker compose snippet
3. **Configuration** — env var table (name, required/optional, default, description)
4. **Adding to your *arr stack** — how it fits alongside Sonarr/Radarr/Plex
5. **API** — brief overview with link to system/status and health endpoints
6. **Screenshots** — existing screenshots from `docs/`
7. **Development** — how to run locally, run tests

### 3.4 Package Visibility

Set GHCR package to public after first successful push. This requires a one-time manual step in GitHub package settings (can't be automated via workflow).

### 3.5 Version Tagging

Update the GitHub Actions workflow to also tag images with the version from `package.json`:

```yaml
tags: |
  type=raw,value=latest
  type=sha,prefix=
  type=raw,value={{version}}
```

This gives users `ghcr.io/dylanreed/couch-commander:1.0.0` for pinning.

---

## Files Changed

| File | Change |
|------|--------|
| `src/index.ts` | Graceful shutdown, schedule guard, `/ping` endpoint, mount v1 routes |
| `src/lib/db.ts` | Add `synchronous = NORMAL` pragma |
| `src/middleware/apiKey.ts` | New — API key auth middleware |
| `src/routes/api/v1/*.ts` | New — versioned route files (or re-export existing) |
| `src/routes/api/system.ts` | New — system/status and health endpoints |
| `src/services/scheduler.ts` | Add `scheduleStale` flag, export `isScheduleStale()` |
| `src/views/pages/error.ejs` | New — error page template |
| `Dockerfile` | OCI labels, healthcheck pointing to `/ping`, `start_period` |
| `docker-compose.yml` | Update healthcheck |
| `docker-compose.example.yml` | New — documented example for distribution |
| `.github/workflows/docker-publish.yml` | Add version tag |
| `README.md` | Full rewrite |
| `package.json` | Add `version` field (already 1.0.0) |

## Testing

- Unit tests for API key middleware (with key, without key, wrong key, no key configured)
- Unit tests for system/status and health endpoints
- Integration test for `/ping`
- Integration test for schedule guard (doesn't regenerate when not stale)
- Existing tests continue to pass unchanged
