/**
 * `invalidateRoster.test.ts` only proves the helper itself calls
 * `invalidateQueries` correctly — it imports the helper directly and would
 * stay green even if nothing in WebSocketContext.tsx ever called it. This
 * file pins the WIRING: that the helper is actually invoked at each site
 * that writes a member row's name slots.
 *
 * Why source-text rather than a rendered/behavioural test: these handlers
 * live inside a `useEffect` in a ~7000-line provider wired to the websocket,
 * MMKV, SQLite and native crypto module — there is no harness that can drive
 * a join/update-profile control message through it. Same approach
 * `profileRebroadcastClaimOrdering.test.ts` and `receiptWiring.test.ts` take
 * for this same file.
 *
 * Sites deliberately NOT wired (leave / kick / verify-kicked / rekey-kick):
 * each writes `{ ...existingRow, inbox_address: '', isKicked?: true }` —
 * a spread of a row already in storage, with no name field touched. Wiring
 * them would be a no-op refetch of unchanged data. The exact-count
 * assertion below locks that decision in, so a future edit that adds a call
 * at one of those sites (or drops one of the three real sites) fails loudly
 * instead of silently drifting.
 */

import * as fs from 'fs';
import * as path from 'path';

const SOURCE_PATH = path.join(__dirname, '..', 'context', 'WebSocketContext.tsx');
const source = fs.readFileSync(SOURCE_PATH, 'utf8');

const CALL = 'invalidateRosterCaches(queryClient, spaceId)';

describe('invalidateRosterCaches wiring in WebSocketContext', () => {
  it('is imported from the identity helper', () => {
    expect(source).toContain("import { invalidateRosterCaches } from '@/identity/invalidateRoster';");
  });

  it('runs right after the join handler writes a member row (a join can carry a global rename)', () => {
    const idx = source.indexOf('await adapter.saveSpaceMember(spaceId, memberRow);');
    expect(idx).toBeGreaterThan(-1);
    const after = source.slice(idx, idx + 300);
    expect(after).toContain(CALL);
  });

  it('runs right after the JS-path update-profile handler writes the merged row', () => {
    // This marker follows only the JS-path save, not the batch-path one,
    // which lets the two identical `saveSpaceMember(spaceId, merged)` calls
    // be told apart.
    const marker = '// Update React Query members cache. Insert if missing.';
    const markerIdx = source.indexOf(marker);
    expect(markerIdx).toBeGreaterThan(-1);
    const before = source.slice(Math.max(0, markerIdx - 300), markerIdx);
    expect(before).toMatch(/await adapter\.saveSpaceMember\(spaceId, merged\);/);
    expect(before).toContain(CALL);
  });

  it('runs right after the batch update-profile handler writes the merged row', () => {
    const marker = '// Member rows changed — refresh the verification member memo.';
    const markerIdx = source.indexOf(marker);
    expect(markerIdx).toBeGreaterThan(-1);
    const before = source.slice(Math.max(0, markerIdx - 300), markerIdx);
    expect(before).toMatch(/await adapter\.saveSpaceMember\(spaceId, merged\);/);
    expect(before).toContain(CALL);
  });

  it('is called from exactly three sites — the join and the two update-profile handlers', () => {
    const count = source.split(CALL).length - 1;
    expect(count).toBe(3);
  });
});
