/**
 * An address prefix is not a name. Stamping `senderAddress.substring(0, 8)`
 * into the row's displayName poisons the ladder's locallyKnownNames tier
 * (identity/identityFromMaps.ts reads conversation rows as a NAME source),
 * which then blocks the honest truncated-address fallback AND wins over a
 * real name arriving later only in surfaces that read the row raw.
 */
import * as fs from 'fs';
import * as path from 'path';

const src = fs.readFileSync(
  path.join(__dirname, '..', 'context', 'WebSocketContext.tsx'),
  'utf8',
);

it('no DM row write uses an address slice as a display name', () => {
  expect(src).not.toMatch(/senderAddress\.substring\(0,\s*8\)/);
  expect(src).not.toMatch(/resolvedSenderAddress\.substring\(0,\s*8\)/);
});
