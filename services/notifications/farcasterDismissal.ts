/**
 * Farcaster notification dismissal.
 *
 * Farcaster rows are NOT stored on device — they are two live remote feeds
 * (farcaster.xyz `notifications-for-tab` + haatz) re-polled every 60s and
 * rendered straight from the React Query cache. Neither can be cleared
 * server-side: the only Farcaster write endpoint we have is
 * `mark-all-notifications-read`, which flips read state, not list membership,
 * and haatz mirrors protocol-level hub events (a like/reply/follow is a record
 * on the network — there is nothing there to delete).
 *
 * So "clear" is a LOCAL dismissal: we remember the instant the user cleared and
 * hide every Farcaster item at or below it. One number, bounded, no growth.
 *
 * Why a watermark and not a set of dismissed ids:
 *  - haatz synthesizes ids from `type:actor:castHash:timestamp`, so they aren't
 *    stable across polls.
 *  - the official feed AGGREGATES ("X and 5 others liked"), so a group's shape
 *    and id shift as activity accrues.
 *  - an id set grows unbounded and would need a cap, which re-introduces the
 *    reappearance it was meant to prevent.
 *
 * The watermark also gets aggregation right for free: the normalizer keys a
 * group off `latestTimestamp`, so a cleared like-group whose cast gets a NEW
 * like rises back above the watermark and correctly reappears.
 *
 * Device-local by design, matching the mention log and the chat log.
 */

import { createMMKV, type MMKV } from 'react-native-mmkv';
import { useEffect, useState } from 'react';

const storage: MMKV = createMMKV({ id: 'quorum-farcaster-dismissal' });

const KEY_CLEARED_BEFORE = 'farcaster.clearedBefore';

type Listener = () => void;
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) {
    try { l(); } catch { /* swallow per-listener errors */ }
  }
}

// --- pure helpers (unit-testable without MMKV) ------------------------------

/**
 * Is this Farcaster item covered by the dismissal watermark?
 *
 * `clearedBefore === 0` means "never cleared" — nothing is dismissed, so users
 * who have never tapped clear see no behavior change at all.
 */
export function isDismissed(timestamp: number, clearedBefore: number): boolean {
  if (!clearedBefore) return false;
  return timestamp <= clearedBefore;
}

/**
 * Have we paged back past the dismissal point?
 *
 * Pages arrive newest-first, so as soon as ANY fetched item falls at or below
 * the watermark, every older page is dismissed too and there is nothing left
 * worth fetching. Callers use this to stop infinite scroll from grinding
 * through pages that would be 100% filtered out.
 *
 * Takes the RAW fetched items, not the filtered ones — the filtered list has
 * by definition dropped exactly the evidence this needs.
 */
export function reachedWatermark(
  items: readonly { timestamp: number }[],
  clearedBefore: number,
): boolean {
  if (!clearedBefore) return false;
  return items.some((i) => i.timestamp <= clearedBefore);
}

// --- persistence shim -------------------------------------------------------

export function getFarcasterClearedBefore(): number {
  const v = storage.getString(KEY_CLEARED_BEFORE);
  if (!v) return 0;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

/** Dismiss every Farcaster notification visible right now. */
export function clearFarcasterNotifications(): void {
  storage.set(KEY_CLEARED_BEFORE, String(Date.now()));
  emit();
}

/** Un-dismiss everything. Exists for tests and a possible future undo. */
export function resetFarcasterDismissal(): void {
  storage.remove(KEY_CLEARED_BEFORE);
  emit();
}

/**
 * Force the watermark to an exact value. For the dev snapshot tool, which has
 * to put back the value a snapshot was taken at — not just clear it.
 */
export function setFarcasterClearedBefore(ts: number): void {
  if (ts > 0) storage.set(KEY_CLEARED_BEFORE, String(ts));
  else storage.remove(KEY_CLEARED_BEFORE);
  emit();
}

/**
 * React subscription helper — re-renders consumers when the watermark moves.
 * Mirrors the pattern used by the notification + mention logs.
 */
export function useFarcasterClearedBefore(): number {
  const [clearedBefore, setClearedBefore] = useState<number>(() => getFarcasterClearedBefore());
  useEffect(() => {
    const listener = () => setClearedBefore(getFarcasterClearedBefore());
    listeners.add(listener);
    // Re-read on mount: the value may have moved between the initial useState
    // and the subscription being registered.
    listener();
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return clearedBefore;
}
