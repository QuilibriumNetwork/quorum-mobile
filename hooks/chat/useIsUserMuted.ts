/**
 * useIsUserMuted — reactive read of MODERATION mute state for a space.
 *
 * Subscribes to the module-level modMuteStorage version so any consumer (the
 * composer disable, the UserProfileModal mute row, a member list) updates the
 * instant a mute/unmute is applied — including one RECEIVED from a moderator on
 * another device — without a remount. Mirrors the useSyncExternalStore shape
 * useDMMute uses.
 *
 * Returns callbacks (not booleans) so a single subscription serves many targets
 * in one screen; the version snapshot drives re-render, the callbacks re-read.
 */

import { useCallback, useSyncExternalStore } from 'react';
import {
  subscribeMutes,
  getMutesVersion,
  isUserMuted as readIsUserMuted,
  getMuteRecord as readMuteRecord,
  type MutedUserRecord,
} from '@/services/space/modMuteStorage';

export function useIsUserMuted(spaceId: string | undefined) {
  // Re-render on any mute write; the version number is the snapshot.
  useSyncExternalStore(subscribeMutes, getMutesVersion);

  const isUserMuted = useCallback(
    (targetUserId: string): boolean =>
      !!spaceId && readIsUserMuted(spaceId, targetUserId),
    [spaceId],
  );

  const getMuteRecord = useCallback(
    (targetUserId: string): MutedUserRecord | null =>
      spaceId ? readMuteRecord(spaceId, targetUserId) : null,
    [spaceId],
  );

  return { isUserMuted, getMuteRecord };
}
