/**
 * Mobile's store for the last config publish outcome.
 *
 * Before this existed, a device could not tell whether its config reached the
 * server, for any reason. Sync being off, a refuse-to-publish hold and a genuine
 * successful upload all write the local row and all look identical, so "my
 * setting saved" was never evidence that it synced.
 *
 * Every branch in `saveConfig` already logs, but a log is not a signal a user
 * can receive. On mobile it goes to the device console, which needs a cable and
 * `adb logcat` to read, so a user hitting a permanently failing publish gets
 * nothing they could ever see — not a toast, not a line in the app, nothing.
 *
 * ⚠️ Be careful with the older framing of this, which said `logger.*` "compiles
 * to a no-op in release builds". That was true of the shared logger's default
 * and is no longer true of this app: `installLoggingPolicy` (index.js) runs at
 * the entry point and reconfigures it to `enabled: true, minLevel: 'warn'` in
 * production, so warn and error DO reach the device console in a release build
 * (PR #227, 2026-08-04). The claim survived in several comments long after the
 * fix landed. What justifies this record is the reach of a console line, not
 * its absence.
 *
 * The two clients genuinely differ here, so do not carry a conclusion across.
 * Desktop has `src/utils/productionLogControl.ts`, but `installLogControl` only
 * attaches a diagnostics hatch to a global — nothing calls `enable()` at
 * startup, so the shared logger's `__DEV__` default stands and desktop's
 * publish-failure warning really is discarded in production until a user opens
 * the hatch by hand. Mobile's policy is installed unconditionally. Same shared
 * logger, opposite defaults.
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
