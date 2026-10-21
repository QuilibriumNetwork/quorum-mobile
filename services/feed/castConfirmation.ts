/**
 * Has a cast the app sent actually reached the network?
 *
 * Hypersnap answers `/v1/submitMessage` once the message passes validation and
 * the node's mempool takes it. That isn't the cast being in a block: it can
 * still fail to propagate or be dropped from the mempool. The pending-cast
 * queue (`context/FeedOptimisticContext.tsx`) holds a sent cast as
 * `confirming` and looks it up by hash until it shows up, before calling it
 * posted.
 *
 * A retry has to re-sign (the timestamp must be fresh, so the hash changes),
 * which means an earlier copy could still land after it. Every copy's hash is
 * kept and checked, before a re-sign and while confirming.
 */
import { getDefaultHypersnapClient } from '@quilibrium/quorum-shared';

/** How often a confirming cast is looked up. */
export const CONFIRM_POLL_MS = 3_000;
/** How long after Hypersnap accepts a cast it may take to show up before the
 *  cast is marked as not posted. Blocks are about a second apart. */
export const CONFIRM_TIMEOUT_MS = 60_000;

export type LandedCopy =
  /** A copy is on the network, under this hash. */
  | { landed: string }
  /** Hypersnap answered for every copy: none is there. */
  | 'absent'
  /** No copy found, but at least one lookup failed, so it can't be ruled out. */
  | 'unknown';

/** Whether any of `hashes` (copies of one cast by `fid`) is on the network. */
export async function findLandedCopy(fid: number, hashes: string[]): Promise<LandedCopy> {
  let unknown = false;
  for (const hash of hashes) {
    try {
      const cast = await getDefaultHypersnapClient().getCastByHash(fid, hash);
      if (cast) return { landed: hash };
      unknown = true;
    } catch (e) {
      if ((e as { status?: number }).status !== 404) unknown = true;
    }
  }
  return unknown ? 'unknown' : 'absent';
}
