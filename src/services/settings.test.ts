// ABOUTME: Tests for settings service.
// ABOUTME: Covers getting and updating user settings.

import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../lib/db';
import { getSettings, updateSettings, getMinutesForDay } from './settings';

describe('Settings Service', () => {
  beforeEach(async () => {
    await prisma.settings.deleteMany();
  });

  describe('getSettings', () => {
    it('returns default settings when none exist', async () => {
      const settings = await getSettings();

      expect(settings.weekdayMinutes).toBe(120);
      expect(settings.weekendMinutes).toBe(240);
      expect(settings.schedulingMode).toBe('sequential');
    });

    it('returns existing settings', async () => {
      await prisma.settings.create({
        data: {
          id: 1,
          weekdayMinutes: 90,
          schedulingMode: 'roundrobin',
        },
      });

      const settings = await getSettings();
      expect(settings.weekdayMinutes).toBe(90);
      expect(settings.schedulingMode).toBe('roundrobin');
    });
  });

  describe('updateSettings', () => {
    it('updates specific settings', async () => {
      await getSettings(); // Ensure settings exist

      const updated = await updateSettings({
        weekdayMinutes: 60,
        staggeredStart: true,
      });

      expect(updated.weekdayMinutes).toBe(60);
      expect(updated.staggeredStart).toBe(true);
      expect(updated.weekendMinutes).toBe(240); // Unchanged
    });
  });

  describe('getMinutesForDay', () => {
    it('returns weekday minutes for Monday', async () => {
      await getSettings();
      const monday = new Date('2026-02-02'); // A Monday

      const minutes = await getMinutesForDay(monday);
      expect(minutes).toBe(120);
    });

    it('returns weekend minutes for Saturday', async () => {
      await getSettings();
      const saturday = new Date('2026-02-07'); // A Saturday

      const minutes = await getMinutesForDay(saturday);
      expect(minutes).toBe(240);
    });

    it('returns day-specific override when set', async () => {
      await updateSettings({ mondayMinutes: 180 });
      const monday = new Date('2026-02-02');

      const minutes = await getMinutesForDay(monday);
      expect(minutes).toBe(180);
    });
  });
});
