/**
 * How far a hub-log cursor may advance.
 *
 * The cursor (hubLogCursor.ts) only moves along a contiguous run of seqs from
 * where it stands, and only once those entries have been through the decrypt
 * and persist pipeline. A gap means an entry we have not handled yet — a
 * queue-overflow drop, a page still in flight — and the cursor waits at it so
 * the next `log-since` refetches it. That rule is deliberate and stays.
 *
 * The flaw was in what counted as handled. An entry that arrives with no
 * payload is skipped at ingest and never queued, so its seq never shows up
 * in a drained batch, and the cursor stopped in front of it for good. Every
 * later `log-update` then re-fetched the log from that point to the head,
 * re-downloading and re-decrypting everything after it, forever.
 *
 * Such an entry has nothing to apply now and never will: refetching returns
 * the same empty entry. So its seq is recorded as passable, and the contiguous
 * run may step over it. Nothing else is: an entry that is queued, in a batch
 * being processed, or not yet received still stops the cursor exactly as
 * before. (An entry that was queued and then failed to decrypt already
 * advances it today — the drain counts every log entry in the batch,
 * successful or not — so failures need no handling here.)
 */

/** A `log-since-result` entry as it arrives on the socket. */
export interface HubLogEntryLike {
  seq: number;
  payload?: { data?: unknown } | null;
}

/** True for an entry that carries no sealed envelope to decrypt. */
export function hubLogEntryIsEmpty(entry: HubLogEntryLike): boolean {
  return !entry.payload?.data;
}

/**
 * The cursor after stepping along `prior + 1, prior + 2, …` while each seq is
 * either one that was just persisted (`handled`) or one with nothing to apply
 * (`passable`). Stops at the first seq that is neither.
 */
export function advanceHubCursor(
  prior: number,
  handled: Iterable<number>,
  passable: ReadonlySet<number> = new Set(),
): number {
  const done = new Set(handled);
  let cursor = prior;
  while (done.has(cursor + 1) || passable.has(cursor + 1)) cursor += 1;
  return cursor;
}

/**
 * Per-hub record of seqs that were received with nothing to apply. In memory
 * only: if the app restarts first, the next `log-since` from the stored
 * cursor returns the same empty entries and records them again.
 */
export class PassableHubSeqs {
  private readonly byHub = new Map<string, Set<number>>();

  add(hub: string, seq: number): void {
    let set = this.byHub.get(hub);
    if (!set) {
      set = new Set();
      this.byHub.set(hub, set);
    }
    set.add(seq);
  }

  get(hub: string): ReadonlySet<number> {
    return this.byHub.get(hub) ?? EMPTY;
  }

  /** Forget seqs the cursor has already passed, so the sets stay small. */
  prune(hub: string, cursor: number): void {
    const set = this.byHub.get(hub);
    if (!set) return;
    set.forEach((seq) => {
      if (seq <= cursor) set.delete(seq);
    });
    if (set.size === 0) this.byHub.delete(hub);
  }
}

const EMPTY: ReadonlySet<number> = new Set();
