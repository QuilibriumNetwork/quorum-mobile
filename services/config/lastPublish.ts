/**
 * Mobile's store for the last config publish outcome.
 *
 * Before this existed, a device could not tell whether its config reached the
 * server, for any reason. Sync being off, a refuse-to-publish hold and a genuine
 * successful upload all write the local row and all look identical, so "my
 * setting saved" was never evidence that it synced.
 *
 * Every branch in `saveConfig` already logs, but `logger.*` compiles to a no-op
 * in release builds, so a user hitting a permanently failing publish gets no
 * signal at all — not a toast, not a console line, nothing.
 *
 * That is true of BOTH clients, not just this one: desktop's publish-failure
 * path goes through the same shared `logger.warn` and is equally silent in
 * production. An earlier version of this comment claimed desktop "at least
 * leaves a console entry behind", which is wrong — desktop's one raw
 * `console.warn` is the space-list-shrink diagnostic on the ADOPT path, a
 * different thing entirely.
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
import { logger } from '@quilibrium/quorum-shared';
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
 * the server disliked it. Worth separating because the two differ in whether
 * they are likely to clear on their own: a timeout is usually transient, a
 * rejection usually is not.
 *
 * NOT "will retry versus will not". Mobile retries neither — `saveConfig`'s
 * catch swallows the error and returns, and there is no queue behind it. Only
 * desktop retries, via its action queue, which is why the two clients word the
 * timeout copy differently. See `components/SyncStatusLine.tsx`.
 *
 * ⚠️ Known limitation, shared with desktop: this classifies on the error
 * MESSAGE, so it cannot see where the failure happened. On this client the
 * enclosing try also covers key collection, encryption and signing, so a local
 * crypto fault is classified `rejected` — indistinguishable here from a real
 * server refusal. `saveConfig` compensates by prefixing `detail` with
 * "before send:" when the request never left the device. A proper fix needs a
 * new `PublishOutcome` member in quorum-shared.
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

/**
 * Returns null when nothing has been recorded yet, or the stored value is
 * unusable.
 *
 * Those two cases are deliberately indistinguishable to the CALLER: showing
 * "something is wrong with the record about whether something is wrong" helps
 * nobody, and the state clears itself on the next save, since every
 * `recordLastPublish` overwrites the key wholesale.
 *
 * They are not indistinguishable to a developer, though — the rejection paths
 * trace, so a corrupt record can be found in a dev session instead of looking
 * like a device that has simply never published. `logger.debug` rather than
 * `warn`: there is nothing here for a user to act on.
 */
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
      logger.debug('[ConfigSync] stored publish record has an unusable shape; ignoring it');
      return null;
    }
    return parsed as LastPublish;
  } catch {
    logger.debug('[ConfigSync] stored publish record could not be parsed; ignoring it');
    return null;
  }
}
