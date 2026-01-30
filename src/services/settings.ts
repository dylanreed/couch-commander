// ABOUTME: Manages user settings for scheduling preferences.
// ABOUTME: Handles time budgets, scheduling modes, and genre rules.

import { prisma } from '../lib/db';
import type { Settings } from '@prisma/client';

export async function getSettings(): Promise<Settings> {
  let settings = await prisma.settings.findUnique({
    where: { id: 1 },
  });

  if (!settings) {
    settings = await prisma.settings.create({
      data: { id: 1 },
    });
  }

  return settings;
}

export async function updateSettings(
  data: Partial<Omit<Settings, 'id' | 'createdAt' | 'updatedAt'>>
): Promise<Settings> {
  return prisma.settings.upsert({
    where: { id: 1 },
    update: data,
    create: { id: 1, ...data },
  });
}

const DAY_OVERRIDES: Record<number, keyof Settings> = {
  0: 'sundayMinutes',
  1: 'mondayMinutes',
  2: 'tuesdayMinutes',
  3: 'wednesdayMinutes',
  4: 'thursdayMinutes',
  5: 'fridayMinutes',
  6: 'saturdayMinutes',
};

export async function getMinutesForDay(date: Date): Promise<number> {
  const settings = await getSettings();
  const dayOfWeek = date.getDay();

  // Check for day-specific override
  const overrideKey = DAY_OVERRIDES[dayOfWeek];
  const override = settings[overrideKey] as number | null;
  if (override !== null) {
    return override;
  }

  // Weekend: Saturday (6) or Sunday (0)
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  return isWeekend ? settings.weekendMinutes : settings.weekdayMinutes;
}

export interface GenreRule {
  genre: string;
  allowedDays: number[]; // 0-6, Sunday-Saturday
  blocked: boolean;
}

export async function getGenreRules(): Promise<GenreRule[]> {
  const settings = await getSettings();
  return JSON.parse(settings.genreRules);
}

export async function updateGenreRules(rules: GenreRule[]): Promise<Settings> {
  return updateSettings({ genreRules: JSON.stringify(rules) });
}
