import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import { logger } from '@quilibrium/quorum-shared';
import {
  limitUserVisibility,
  removeUserVisibilityRestriction,
  saveBlockedFids,
  saveMutedFids,
} from '@/services/farcaster/socialGraph';

const BLOCKED_KEY = 'farcaster-blocked-fids';
const MUTED_KEY = 'farcaster-muted-fids';

export interface UserVisibilityActions {
  /** True once we have a Farcaster token to act with. */
  canAct: boolean;
  mute: (targetFid: number) => Promise<void>;
  unmute: (targetFid: number) => Promise<void>;
  block: (targetFid: number) => Promise<void>;
  /** Clears any restriction (the API has one "remove" for both). */
  unblock: (targetFid: number) => Promise<void>;
}

/**
 * Mute / block / unmute / unblock a Farcaster user. There's no protocol-level
 * support, so these hit the same authed web-client endpoints the official app
 * uses (`/v2/limit-visibility`). Each action optimistically updates the
 * cached blocked/muted FID sets (keyed the same as {@link useBlockedFids} /
 * {@link useMutedFids}) so the profile menu and thread filtering react
 * immediately, then invalidates to resync. On failure we roll the optimistic
 * change back.
 */
export function useUserVisibilityActions(): UserVisibilityActions {
  const queryClient = useQueryClient();
  const { user, farcasterAuthToken } = useAuth();
  const fid = user?.farcaster?.fid;

  // Optimistically add/remove `targetFid` from a cached FID-set query and
  // mirror the result to MMKV. Returns a revert thunk.
  const patchSet = useCallback(
    (key: string, targetFid: number, add: boolean): (() => void) => {
      const queryKey = [key, fid];
      const prev = (queryClient.getQueryData<number[]>(queryKey) ?? []).slice();
      const nextSet = new Set(prev);
      if (add) nextSet.add(targetFid);
      else nextSet.delete(targetFid);
      const next = Array.from(nextSet);
      queryClient.setQueryData<number[]>(queryKey, next);
      if (fid) {
        if (key === BLOCKED_KEY) saveBlockedFids(fid, next);
        else saveMutedFids(fid, next);
      }
      return () => {
        queryClient.setQueryData<number[]>(queryKey, prev);
        if (fid) {
          if (key === BLOCKED_KEY) saveBlockedFids(fid, prev);
          else saveMutedFids(fid, prev);
        }
      };
    },
    [queryClient, fid],
  );

  const run = useCallback(
    async (
      targetFid: number,
      apply: (token: string) => Promise<void>,
      reverts: Array<() => void>,
      invalidateKeys: string[],
    ) => {
      if (!farcasterAuthToken) {
        reverts.forEach((r) => r());
        throw new Error('Not signed in to Farcaster');
      }
      try {
        await apply(farcasterAuthToken);
      } catch (e) {
        reverts.forEach((r) => r());
        logger.warn(
          '[visibility] action failed:',
          e instanceof Error ? e.message : e,
        );
        throw e;
      } finally {
        invalidateKeys.forEach((k) =>
          queryClient.invalidateQueries({ queryKey: [k, fid] }),
        );
      }
    },
    [farcasterAuthToken, queryClient, fid],
  );

  const mute = useCallback(
    (targetFid: number) =>
      run(
        targetFid,
        (t) => limitUserVisibility(t, targetFid, false),
        [patchSet(MUTED_KEY, targetFid, true)],
        [MUTED_KEY],
      ),
    [run, patchSet],
  );

  const block = useCallback(
    (targetFid: number) =>
      run(
        targetFid,
        (t) => limitUserVisibility(t, targetFid, true),
        // Blocking supersedes muting; reflect that locally too.
        [
          patchSet(BLOCKED_KEY, targetFid, true),
          patchSet(MUTED_KEY, targetFid, false),
        ],
        [BLOCKED_KEY, MUTED_KEY],
      ),
    [run, patchSet],
  );

  // Unmute and unblock are the same server call (remove the restriction);
  // we just clear whichever set(s) the user was in.
  const unmute = useCallback(
    (targetFid: number) =>
      run(
        targetFid,
        (t) => removeUserVisibilityRestriction(t, targetFid),
        [patchSet(MUTED_KEY, targetFid, false)],
        [MUTED_KEY],
      ),
    [run, patchSet],
  );

  const unblock = useCallback(
    (targetFid: number) =>
      run(
        targetFid,
        (t) => removeUserVisibilityRestriction(t, targetFid),
        [
          patchSet(BLOCKED_KEY, targetFid, false),
          patchSet(MUTED_KEY, targetFid, false),
        ],
        [BLOCKED_KEY, MUTED_KEY],
      ),
    [run, patchSet],
  );

  return { canAct: Boolean(farcasterAuthToken), mute, unmute, block, unblock };
}
