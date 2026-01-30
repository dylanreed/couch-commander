// ABOUTME: Tests for TMDB API service functions.
// ABOUTME: Uses mocked fetch for isEpisodeAvailable, real API for other tests.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { searchShows, getShowDetails, isEpisodeAvailable } from './tmdb';

describe('TMDB Service', () => {
  describe('searchShows', () => {
    it('returns an array of show results for a valid query', async () => {
      const results = await searchShows('Breaking Bad');

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]).toHaveProperty('id');
      expect(results[0]).toHaveProperty('name');
    });

    it('returns empty array for nonsense query', async () => {
      const results = await searchShows('xyznonexistentshow123456');

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(0);
    });
  });

  describe('getShowDetails', () => {
    it('returns detailed show info including episode count', async () => {
      // Breaking Bad TMDB ID
      const details = await getShowDetails(1396);

      expect(details).toHaveProperty('id', 1396);
      expect(details).toHaveProperty('name', 'Breaking Bad');
      expect(details).toHaveProperty('totalSeasons');
      expect(details).toHaveProperty('totalEpisodes');
      expect(details).toHaveProperty('episodeRuntime');
      expect(details).toHaveProperty('genres');
      expect(details.totalSeasons).toBeGreaterThan(0);
      expect(details.totalEpisodes).toBeGreaterThan(0);
    });

    it('throws error for invalid show ID', async () => {
      await expect(getShowDetails(999999999)).rejects.toThrow();
    });

    it('fetches runtime from season data when episode_run_time is empty', async () => {
      // The Office (2316) has 22-min episodes but empty episode_run_time
      const details = await getShowDetails(2316);
      expect(details.episodeRuntime).toBeLessThan(30);
    });
  });

  describe('isEpisodeAvailable', () => {
    const originalFetch = global.fetch;
    const mockFetch = vi.fn();

    beforeEach(() => {
      global.fetch = mockFetch;
      mockFetch.mockReset();
      vi.stubEnv('TMDB_API_KEY', 'test-api-key');
    });

    afterEach(() => {
      global.fetch = originalFetch;
      vi.unstubAllEnvs();
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
          episodes: [{ episode_number: 1, air_date: '2020-01-01' }],
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
});
