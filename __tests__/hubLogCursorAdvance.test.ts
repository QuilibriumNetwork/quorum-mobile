/**
 * The hub-log cursor steps over entries that carry nothing to apply.
 *
 * ## The regression this pins
 *
 * The per-hub cursor advances only along a contiguous run of seqs that have
 * been through the decrypt/persist drain, and stops at the first gap so the
 * next `log-since` refetches it. An entry with no `payload.data` was skipped
 * at ingest and never queued, so its seq never appeared in a drained batch:
 * the cursor stopped in front of it permanently, and every later `log-update`
 * re-fetched the log from that seq to the head — re-downloading and
 * re-decrypting everything after it, on every new message, forever.
 *
 * ## What is asserted
 *
 * - An empty entry received inside a run no longer blocks the cursor.
 * - What must still block it does: a seq not received yet (an overflow drop,
 *   a page in flight) and a seq queued but not yet drained. Losing a message
 *   is worse than re-downloading one, so these are the control arms.
 * - The wiring, from the provider source: ingest records empty entries as
 *   passable instead of silently skipping them, and both cursor advances
 *   (after a drained batch, and right after ingest) honour that record.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  advanceHubCursor,
  hubLogEntryIsEmpty,
  PassableHubSeqs,
} from '../services/space/hubLogCursorAdvance';

const HUB = 'QmHub';

describe('advanceHubCursor', () => {
  it('steps over an empty entry between two persisted ones', () => {
    // 11 and 13 were drained; 12 arrived with no payload.
    const passable = new PassableHubSeqs();
    passable.add(HUB, 12);
    expect(advanceHubCursor(10, [11, 13], passable.get(HUB))).toBe(13);
  });

  it('shows the old stall: without the passable record the cursor stops at 11', () => {
    // Exactly the pre-fix outcome — and the reason every log-update after it
    // refetched from 11.
    expect(advanceHubCursor(10, [11, 13])).toBe(11);
  });

  it('moves past a run of empty entries at the cursor with nothing drained', () => {
    const passable = new PassableHubSeqs();
    passable.add(HUB, 11);
    passable.add(HUB, 12);
    expect(advanceHubCursor(10, [], passable.get(HUB))).toBe(12);
  });

  it('still stops at a seq that was never received', () => {
    // 12 was dropped by queue overflow (or its page is still in flight): it
    // must be refetched, so the cursor waits at 11.
    const passable = new PassableHubSeqs();
    passable.add(HUB, 13);
    expect(advanceHubCursor(10, [11, 14], passable.get(HUB))).toBe(11);
  });

  it('still stops at a seq that is queued but not yet drained', () => {
    // Empty 11 is passable, but 12 sits in the queue: its batch has not been
    // persisted, so the cursor may only reach 11.
    const passable = new PassableHubSeqs();
    passable.add(HUB, 11);
    expect(advanceHubCursor(10, [], passable.get(HUB))).toBe(11);
  });

  it('never moves backwards', () => {
    expect(advanceHubCursor(20, [5, 6, 7])).toBe(20);
  });
});

describe('PassableHubSeqs', () => {
  it('keeps hubs apart', () => {
    const passable = new PassableHubSeqs();
    passable.add('a', 1);
    expect(passable.get('b').has(1)).toBe(false);
  });

  it('forgets seqs the cursor has passed', () => {
    const passable = new PassableHubSeqs();
    passable.add(HUB, 3);
    passable.add(HUB, 9);
    passable.prune(HUB, 5);
    expect([...passable.get(HUB)]).toEqual([9]);
  });
});

describe('hubLogEntryIsEmpty', () => {
  it('flags entries with no sealed envelope', () => {
    expect(hubLogEntryIsEmpty({ seq: 1, payload: { data: '' } })).toBe(true);
    expect(hubLogEntryIsEmpty({ seq: 1, payload: {} })).toBe(true);
    expect(hubLogEntryIsEmpty({ seq: 1, payload: null })).toBe(true);
  });

  it('passes entries that have one', () => {
    expect(hubLogEntryIsEmpty({ seq: 1, payload: { data: { envelope: 'x' } } })).toBe(false);
    expect(hubLogEntryIsEmpty({ seq: 1, payload: { data: '{"envelope":"x"}' } })).toBe(false);
  });
});

describe('WebSocketContext wiring', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'context', 'WebSocketContext.tsx'),
    'utf8',
  );

  function section(startAnchor: string, endAnchor: string): string {
    const start = source.indexOf(startAnchor);
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf(endAnchor, start);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it('records an empty entry as passable instead of only skipping it', () => {
    const ingest = section('const ingestEntries = (', 'const unsubscribe = registerLogFrameHandler');
    expect(ingest).toContain('hubLogEntryIsEmpty(entry)');
    expect(ingest).toMatch(/passableHubSeqsRef\.current\.add\(hubAddress, entry\.seq\)/);
    // The bare skip that stalled the cursor.
    expect(ingest).not.toMatch(/if \(!sealedEnvelope\) continue;/);
  });

  it('settles the cursor over passable seqs right after ingest', () => {
    const ingest = section('const ingestEntries = (', 'const unsubscribe = registerLogFrameHandler');
    expect(ingest).toMatch(/advanceHubCursor\(prior, \[\], passableHubSeqsRef\.current\.get\(hubAddress\)\)/);
  });

  it('lets the post-drain advance step over passable seqs', () => {
    const drain = section('// Per-hub log cursor advance', '// Yield between drains');
    expect(drain).toMatch(/advanceHubCursor\(prior, seqs, passableHubSeqsRef\.current\.get\(hub\)\)/);
  });
});
