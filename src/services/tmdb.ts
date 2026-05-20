// ABOUTME: TMDB API client for searching and fetching TV show data.
// ABOUTME: Handles API authentication and response transformation.

import { gunzipSync, constants as zlibConstants } from 'zlib';

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

// Some TMDB CDN cache entries serve gzipped bytes that Node's fetch fails
// to auto-decompress (the Content-Encoding header is set but the body
// arrives still compressed). Detect the gzip magic bytes and manually
// gunzip when needed. Falls back to .json() for mocked Response shims
// in tests that don't implement arrayBuffer().
async function tmdbFetchJSON<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`TMDB API error: ${response.status}`);
  }
  if (typeof response.arrayBuffer === 'function') {
    const buf = Buffer.from(await response.arrayBuffer());
    const text =
      buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b
        ? gunzipSync(buf, { finishFlush: zlibConstants.Z_SYNC_FLUSH }).toString('utf-8')
        : buf.toString('utf-8');
    return JSON.parse(text) as T;
  }
  return (await response.json()) as T;
}

interface TMDBSearchResult {
  id: number;
  name: string;
  overview: string;
  poster_path: string | null;
  first_air_date: string;
  vote_average: number;
  genre_ids: number[];
}

interface TMDBSearchResponse {
  page: number;
  results: TMDBSearchResult[];
  total_pages: number;
  total_results: number;
}

export interface ShowSearchResult {
  id: number;
  name: string;
  overview: string;
  posterPath: string | null;
  firstAirDate: string;
  voteAverage: number;
  genreIds: number[];
}

function getApiKey(): string {
  const key = process.env.TMDB_API_KEY;
  if (!key || key === 'your_tmdb_api_key_here') {
    throw new Error('TMDB_API_KEY environment variable is not set');
  }
  return key;
}

export async function searchShows(query: string): Promise<ShowSearchResult[]> {
  const apiKey = getApiKey();
  const url = `${TMDB_BASE_URL}/search/tv?api_key=${apiKey}&query=${encodeURIComponent(query)}`;

  const data = await tmdbFetchJSON<TMDBSearchResponse>(url);

  return data.results.map((show) => ({
    id: show.id,
    name: show.name,
    overview: show.overview,
    posterPath: show.poster_path,
    firstAirDate: show.first_air_date,
    voteAverage: show.vote_average,
    genreIds: show.genre_ids,
  }));
}

interface TMDBShowDetails {
  id: number;
  name: string;
  overview: string;
  poster_path: string | null;
  genres: { id: number; name: string }[];
  number_of_seasons: number;
  number_of_episodes: number;
  episode_run_time: number[];
  status: string;
  first_air_date: string;
}

interface TMDBSeasonDetails {
  episodes: { runtime: number | null }[];
}

export interface ShowDetails {
  id: number;
  name: string;
  overview: string;
  posterPath: string | null;
  genres: string[];
  totalSeasons: number;
  totalEpisodes: number;
  episodeRuntime: number;
  status: string;
  firstAirDate: string;
}

async function fetchRuntimeFromSeason(tmdbId: number, apiKey: string): Promise<number | null> {
  // Fetch season 1 data to get episode runtimes
  const url = `${TMDB_BASE_URL}/tv/${tmdbId}/season/1?api_key=${apiKey}`;

  try {
    const data = await tmdbFetchJSON<TMDBSeasonDetails>(url);

    // Extract runtimes from episodes, filtering out null values
    const runtimes = data.episodes
      .map((ep) => ep.runtime)
      .filter((runtime): runtime is number => runtime !== null && runtime > 0);

    if (runtimes.length === 0) {
      return null;
    }

    // Return average runtime
    return Math.round(runtimes.reduce((a, b) => a + b, 0) / runtimes.length);
  } catch {
    return null;
  }
}

export async function getShowDetails(tmdbId: number): Promise<ShowDetails> {
  const apiKey = getApiKey();
  const url = `${TMDB_BASE_URL}/tv/${tmdbId}?api_key=${apiKey}`;

  const data = await tmdbFetchJSON<TMDBShowDetails>(url);

  // Calculate average runtime using multiple fallback strategies
  let avgRuntime: number;
  if (data.episode_run_time.length > 0) {
    // First try: show-level episode_run_time array
    avgRuntime = Math.round(
      data.episode_run_time.reduce((a, b) => a + b, 0) / data.episode_run_time.length
    );
  } else {
    // Second try: fetch runtime from season 1 episode data
    const seasonRuntime = await fetchRuntimeFromSeason(tmdbId, apiKey);
    if (seasonRuntime !== null) {
      avgRuntime = seasonRuntime;
    } else {
      // Last resort: default to 45 minutes
      avgRuntime = 45;
    }
  }

  return {
    id: data.id,
    name: data.name,
    overview: data.overview,
    posterPath: data.poster_path,
    genres: data.genres.map((g) => g.name),
    totalSeasons: data.number_of_seasons,
    totalEpisodes: data.number_of_episodes,
    episodeRuntime: avgRuntime,
    status: data.status,
    firstAirDate: data.first_air_date,
  };
}

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
    const data = await tmdbFetchJSON<{
      episodes?: Array<{ episode_number: number; air_date: string | null }>;
    }>(url);
    const episodeData = data.episodes?.find(
      (ep) => ep.episode_number === episode
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
