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
 *
 * ---------------------------------------------------------------------------
 * PER-ITEM DISMISSAL (the row trash button), added on top of the watermark.
 *
 * "Clear all" is one instant; hiding a single row is not, so the watermark
 * alone cannot express it. The three objections above are what shape the
 * design, and each is answered rather than waived:
 *
 *  - NOT keyed by `n.id`. Keyed by the SEMANTIC dedup key the blend already
 *    computes (`farcasterDismissKey` in partitionNotifications.ts), which is
 *    stable across polls and identical for the same event arriving from both
 *    sources. Keying on `n.id` would hide the official aggregate and leave the
 *    haatz per-actor duplicates behind the moment the official feed stopped
 *    covering them — the exact resurfacing bug the blend order guards against.
 *
 *  - Aggregation still works, because we store an INSTANT per key, not a
 *    boolean, and hide only `timestamp <= dismissedAt`. That is the watermark
 *    rule applied to one key: a dismissed like-group whose cast gets a new like
 *    rises above its own dismissal instant and correctly reappears, exactly as
 *    it does for the global watermark.
 *
 *  - Growth is bounded twice over. Any key dismissed at or before the global
 *    watermark is pruned, because the watermark already hides a superset of
 *    what it hid; and the survivors are capped at DISMISSED_CAP newest. So a
 *    "Clear all" collapses the whole map back to nothing, which is the common
 *    case and the reason this stays small in practice.
 *
 * Device-local, same as the watermark.
 */

import { createMMKV, type MMKV } from 'react-native-mmkv';
import { useEffect, useMemo, useState } from 'react';

const storage: MMKV = createMMKV({ id: 'quorum-farcaster-dismissal' });

const KEY_CLEARED_BEFORE = 'farcaster.clearedBefore';
const KEY_DISMISSED = 'farcaster.dismissedKeys';

/**
 * Cap on remembered per-item dismissals.
 *
 * Evicting the oldest dismissal lets that row reappear, so the cap has to sit
 * far above any plausible working set. The panel shows tens of rows and the
 * pruning rule empties this map on every "Clear all", so 300 is effectively
 * unreachable — it exists as a bound, not as a policy.
 */
const DISMISSED_CAP = 300;

/** Dismiss key → the instant it was dismissed (ms epoch). */
export type DismissedKeys = Readonly<Record<string, number>>;

/** Shared empty map, so a no-dismissals read keeps a stable identity and does
 *  not invalidate the memo that partitions the whole feed. */
const NO_DISMISSALS: DismissedKeys = Object.freeze({});

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

/**
 * Has this specific item been dismissed by its own row trash?
 *
 * `timestamp <= dismissedAt` rather than a bare key lookup, so an aggregate
 * that gains new activity comes back. See the header note: this is the
 * watermark rule scoped to one key.
 *
 * Deliberately NOT consulted by `reachedWatermark`. Per-item dismissals are
 * sparse and scattered through the feed, so hitting one says nothing about
 * whether older pages are worth fetching — treating it as a floor would stop
 * infinite scroll dead at the first hidden row.
 */
export function isItemDismissed(
  key: string | undefined,
  timestamp: number,
  dismissed: DismissedKeys,
): boolean {
  if (!key) return false;
  const at = dismissed[key];
  if (at == null) return false;
  return timestamp <= at;
}

/**
 * Drop what the global watermark already covers, then cap.
 *
 * A key dismissed at or before `clearedBefore` can only hide items at or below
 * its own (lower) instant, every one of which the watermark hides too — so it
 * is pure redundancy. This is what makes "Clear all" reset the map to empty.
 */
export function pruneDismissed(
  dismissed: DismissedKeys,
  clearedBefore: number,
): DismissedKeys {
  const kept = Object.entries(dismissed)
    .filter(([, at]) => Number.isFinite(at) && at > clearedBefore)
    .sort((a, b) => b[1] - a[1])
    .slice(0, DISMISSED_CAP);
  return Object.fromEntries(kept);
}

function parseDismissed(raw: string | undefined): DismissedKeys {
  if (!raw) return NO_DISMISSALS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return NO_DISMISSALS;
    // Numeric values only. A corrupted or hand-edited entry that parsed to a
    // string would compare false against every timestamp and silently stop
    // hiding its row, which reads as the trash button not working.
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return NO_DISMISSALS;
  }
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
  // Every per-item dismissal is now subsumed by the watermark, which sits at or
  // above all of them. Dropping the map here is what keeps it from growing
  // across repeated clears — see the header note on bounding.
  storage.remove(KEY_DISMISSED);
  emit();
}

/** Un-dismiss everything — the watermark AND the per-item dismissals. Exists
 *  for tests and for the dev panel's Reset. */
export function resetFarcasterDismissal(): void {
  storage.remove(KEY_CLEARED_BEFORE);
  storage.remove(KEY_DISMISSED);
  emit();
}

// --- per-item dismissal ------------------------------------------------------

export function getFarcasterDismissedKeys(): DismissedKeys {
  return parseDismissed(storage.getString(KEY_DISMISSED));
}

/**
 * Hide one Farcaster row. `key` is the semantic dismiss key
 * (`farcasterDismissKey`), never the raw notification id — see the header.
 */
export function dismissFarcasterNotification(key: string): void {
  if (!key) return;
  const next = pruneDismissed(
    { ...getFarcasterDismissedKeys(), [key]: Date.now() },
    getFarcasterClearedBefore(),
  );
  storage.set(KEY_DISMISSED, JSON.stringify(next));
  emit();
}

/** Force the whole map. For the dev snapshot restore, same as
 *  `setFarcasterClearedBefore` does for the watermark. */
export function setFarcasterDismissedKeys(dismissed: DismissedKeys): void {
  if (Object.keys(dismissed).length === 0) storage.remove(KEY_DISMISSED);
  else storage.set(KEY_DISMISSED, JSON.stringify(dismissed));
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

/**
 * Per-item dismissals, as a React subscription.
 *
 * Held as the RAW stored string and parsed in a memo, so the returned object
 * keeps a stable identity while the stored value is unchanged. The panel feeds
 * this straight into the dependency array that partitions the entire feed, and
 * a freshly-parsed object on every emit would re-run that work for nothing.
 */
export function useFarcasterDismissedKeys(): DismissedKeys {
  const [raw, setRaw] = useState<string>(() => storage.getString(KEY_DISMISSED) ?? '');
  useEffect(() => {
    const listener = () => setRaw(storage.getString(KEY_DISMISSED) ?? '');
    listeners.add(listener);
    // Re-read on mount, for the same reason the watermark hook does.
    listener();
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return useMemo(() => parseDismissed(raw), [raw]);
}
