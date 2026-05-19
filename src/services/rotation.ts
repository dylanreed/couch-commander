// ABOUTME: Pure rotation-group pick and finish logic.
// ABOUTME: Used by the scheduler to decide which show plays next in a rotating slot.

import { prisma } from '../lib/db';
import type { RotationMember } from '@prisma/client';

/**
 * Returns the next-due RotationMember for a group, or null if no eligible
 * member exists.  "Next-due" = lowest count of ScheduledEpisode rows already
 * tagged with this group + member, then lowest member.order as a tiebreak.
 *
 * Filters out:
 *   - members with finished=true
 *   - members whose underlying WatchlistEntry has active=false
 *   - members whose show has no remaining unwatched episodes (and marks them finished)
 */
export async function pickNextMember(rotationGroupId: number): Promise<RotationMember | null> {
  const members = await prisma.rotationMember.findMany({
    where: { rotationGroupId },
    include: { watchlistEntry: { include: { show: true } } },
    orderBy: { order: 'asc' },
  });

  type Candidate = { member: RotationMember; count: number };
  const candidates: Candidate[] = [];

  for (const member of members) {
    if (member.finished) continue;
    if (!member.watchlistEntry.active) continue;

    const entry = member.watchlistEntry;
    const show = entry.show;
    const exhausted = entry.currentEpisode > show.totalEpisodes;
    if (exhausted) {
      await prisma.rotationMember.update({
        where: { id: member.id },
        data: { finished: true },
      });
      continue;
    }

    const count = await prisma.scheduledEpisode.count({
      where: { rotationGroupId, showId: show.id },
    });

    // All remaining episodes are already scheduled — mark finished and skip.
    const remainingEpisodes = show.totalEpisodes - entry.currentEpisode + 1;
    if (count >= remainingEpisodes) {
      await prisma.rotationMember.update({
        where: { id: member.id },
        data: { finished: true },
      });
      continue;
    }

    candidates.push({ member, count });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.count !== b.count) return a.count - b.count;
    return a.member.order - b.member.order;
  });

  return candidates[0].member;
}

/**
 * Inspects a single member's show progress and flips finished=true if the
 * show has been completed.  Useful from external triggers (e.g., manual finish).
 */
export async function markFinishedIfNoEpisodesLeft(memberId: number): Promise<void> {
  const member = await prisma.rotationMember.findUnique({
    where: { id: memberId },
    include: { watchlistEntry: { include: { show: true } } },
  });
  if (!member) return;
  const entry = member.watchlistEntry;
  if (entry.currentEpisode > entry.show.totalEpisodes && !member.finished) {
    await prisma.rotationMember.update({ where: { id: memberId }, data: { finished: true } });
  }
}
