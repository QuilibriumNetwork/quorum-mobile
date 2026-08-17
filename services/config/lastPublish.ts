/**
 * Mobile's store for the last config publish outcome.
 *
 * Before this existed, a device could not tell whether its config reached the
 * server, for any reason. Sync being off, a refuse-to-publish hold and a genuine
 * successful upload all write the local row and all look identical, so "my
 * setting saved" was never evidence that it synced.
 *
 * Mobile needs it more than desktop does: every branch in `saveConfig` already
 * logs, but `logger.*` compiles to a no-op in release builds, so a user hitting
 * a permanently failing publish today gets no signal at all — not a toast, not a
 * console line, nothing. Desktop at least leaves a console entry behind.
 *
 * The shape lives in quorum-shared so both clients agree; only the storage is
 * per-platform (MMKV here, localStorage on desktop). The record is device-local
 * and never enters UserConfig — in the synced blob it would broadcast a
 * per-device fact to every other device, rewrite the blob on every save, and
 * grow the very payload this instrument exists to watch.
 *
 * See 2026-08-08-record-and-show-what-the-last-config-publish-actually-did.md
 * in quorum-desktop for the full design.
 */

import { createMMKV, type MMKV } from 'react-native-mmkv';
import type { PublishOutcome, LastPublish } from '@quilibrium/quorum-shared';

export type { PublishOutcome, LastPublish };

// Deliberately the same store `configService` uses, so clearing config storage
// on an account reset takes the record with it: a publish record describes one
// device's relationship with one account's server row, and outliving that
// account would make it a lie rather than a stale reading. A separate instance
// rather than an import, because configService imports this module.
const storage: MMKV = createMMKV({ id: 'quorum-config' });

const KEY = 'quorum:sync:lastPublish';

/**
 * A rejection whose message says the request never completed, rather than that
 * the server disliked it. Worth separating because the two mean opposite things
 * to a user: a timeout is "will retry", a rejection is "this will not work".
 *
 * Mirrors desktop's `src/utils/lastPublish.ts`. Kept identical on purpose — if
 * the two classifiers drift, the same failure reads as different states on a
 * phone and a laptop, which is precisely the confusion this instrument exists
 * to remove.
 */
export function classifyPublishError(error: unknown): 'rejected' | 'timeout' {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|ETIMEDOUT|ECONNABORTED|aborted|network error/i.test(message)
    ? 'timeout'
    : 'rejected';
}

/**
 * Never throws. An instrument that can break the path it measures is worse than
 * no instrument — the whole point is that config sync keeps working.
 */
export function recordLastPublish(
  outcome: PublishOutcome,
  details: Omit<LastPublish, 'at' | 'outcome'> = {}
): void {
  try {
    const entry: LastPublish = { at: Date.now(), outcome, ...details };
    storage.set(KEY, JSON.stringify(entry));
  } catch {
    // A full disk, a serialisation edge — losing one reading is fine, and is
    // never worth failing the save that produced it.
  }
}

/** Returns null when nothing has been recorded yet, or the stored value is unusable. */
export function readLastPublish(): LastPublish | null {
  try {
    const raw = storage.getString(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as LastPublish).at !== 'number' ||
      typeof (parsed as LastPublish).outcome !== 'string'
    ) {
      return null;
    }
    return parsed as LastPublish;
  } catch {
    return null;
  }
}
