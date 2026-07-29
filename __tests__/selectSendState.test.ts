/**
 * Which stored session we SEND with when several share a device tag.
 *
 * The case that matters: the peer resets. They mint a new receiving inbox and
 * announce it in a fresh init envelope, but they cannot delete our old row — so
 * we hold BOTH a stale confirmed row (pointing at an inbox they have abandoned)
 * and the new one. Picking the stale row sends every message into a black hole
 * while theirs keep arriving, which is exactly what made a one-sided reset fail
 * to propagate.
 */
import { selectSendState } from '../services/crypto/selectSendState';

const ready = (timestamp: number, inbox: string) => ({
  timestamp,
  inboxId: inbox,
  sendingInbox: { inbox_public_key: `pub-${inbox}`, inbox_address: inbox },
});
const unconfirmed = (timestamp: number, inbox: string) => ({
  timestamp,
  inboxId: inbox,
  sendingInbox: { inbox_public_key: '' },
});

describe('selectSendState', () => {
  it('returns undefined when there is no session for the tag', () => {
    expect(selectSendState([])).toBeUndefined();
  });

  it('prefers a send-ready row over an unconfirmed one', () => {
    const chosen = selectSendState([unconfirmed(200, 'old'), ready(100, 'ready')]);
    expect(chosen?.inboxId).toBe('ready');
  });

  it('picks the NEWEST send-ready row after the peer resets', () => {
    // Stale row is first in insertion order — the old code took it and kept
    // sending to the inbox the peer had abandoned.
    const stale = ready(1_000, 'abandoned-inbox');
    const fresh = ready(2_000, 'peer-new-inbox');
    expect(selectSendState([stale, fresh])?.inboxId).toBe('peer-new-inbox');
  });

  it('is independent of array order', () => {
    const stale = ready(1_000, 'abandoned-inbox');
    const fresh = ready(2_000, 'peer-new-inbox');
    expect(selectSendState([fresh, stale])?.inboxId).toBe('peer-new-inbox');
  });

  it('falls back to the newest row when none are send-ready', () => {
    const chosen = selectSendState([unconfirmed(1_000, 'a'), unconfirmed(3_000, 'b')]);
    expect(chosen?.inboxId).toBe('b');
  });

  it('does not mutate the caller array', () => {
    const rows = [ready(1_000, 'a'), ready(2_000, 'b')];
    selectSendState(rows);
    expect(rows.map((r) => r.inboxId)).toEqual(['a', 'b']);
  });

  it('tolerates rows with no timestamp by sorting them last', () => {
    const noTs = { inboxId: 'no-ts', sendingInbox: { inbox_public_key: 'p' } };
    expect(selectSendState([noTs, ready(500, 'has-ts')])?.inboxId).toBe('has-ts');
  });
});
