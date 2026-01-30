// ABOUTME: Integration tests for shows API routes.
// ABOUTME: Tests TMDB search endpoint.

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../../index';

describe('Shows API', () => {
  describe('GET /api/shows/search', () => {
    it('returns HTML partial with search results', async () => {
      const res = await request(app)
        .get('/api/shows/search')
        .query({ query: 'Breaking Bad' });

      expect(res.status).toBe(200);
      expect(res.text).toContain('Breaking Bad');
    });

    it('returns empty results for short query', async () => {
      const res = await request(app)
        .get('/api/shows/search')
        .query({ query: 'a' });

      expect(res.status).toBe(200);
    });
  });
});
