// ABOUTME: Vitest setup file to configure test environment.
// ABOUTME: Uses separate test database to avoid affecting dev data.

// Override DATABASE_URL to use a separate test database
process.env.DATABASE_URL = 'file:./test.db';

// Pin timezone to UTC so date-based scheduling tests are deterministic
// regardless of the host machine's local timezone.
process.env.TZ = 'UTC';
