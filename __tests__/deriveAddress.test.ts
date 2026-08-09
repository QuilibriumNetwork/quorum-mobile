/**
 * Pins the address derivation, so consolidating its copies cannot change it.
 *
 * `deriveAddress` defines what a Quorum address IS: sha256 the ed448 public
 * key, wrap the digest in a multihash, base58-encode it. It decides where space
 * inbox messages are sent and which member a roster row belongs to.
 *
 * ## Why this file exists
 *
 * The function was hand-copied into five other modules, because the canonical
 * one used to live behind a module that pulls mnemonic generation and the
 * native Rust crypto module. Those copies are being replaced with imports.
 *
 * A refactor like that is exactly the kind that "obviously cannot change
 * behaviour" and then does: the failure mode is not a crash but a DIFFERENT
 * address, which routes messages to an inbox nobody reads and makes roster rows
 * stop matching their members. Silent, and not something using the app would
 * reveal quickly.
 *
 * So the expectations below are hard-coded literals, computed once and checked
 * in. Deriving them in the test with the function under test would assert
 * nothing at all. If a consolidation changes the output, this goes red.
 *
 * The fixtures are invented byte patterns, not anyone's real key.
 */

import { deriveAddress } from '../utils/deriveAddress';

/** Invented ed448-shaped public key (57 bytes), as raw bytes. */
const KEY_BYTES = new Uint8Array(57);
for (let i = 0; i < 57; i++) KEY_BYTES[i] = (i * 7 + 3) % 256;

/** The same key as hex. */
const KEY_HEX =
  '030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b';

/** What the canonical implementation produces for that key. Checked in. */
const EXPECTED = 'QmRxwsciKWz7fvph4PobmabjChKPZtvkBcE4oALnogXDYW';

describe('deriveAddress', () => {
  it('derives the pinned address from raw key bytes', () => {
    // Uint8Array is the shape all five hand-rolled copies took, so this is the
    // call signature the consolidation has to preserve exactly.
    expect(deriveAddress(KEY_BYTES)).toBe(EXPECTED);
  });

  it('derives the same address from the hex form of the same key', () => {
    expect(deriveAddress(KEY_HEX)).toBe(EXPECTED);
  });

  it('accepts a 0x-prefixed hex key as the same key', () => {
    expect(deriveAddress(`0x${KEY_HEX}`)).toBe(EXPECTED);
  });

  it('produces a Qm-prefixed base58 address', () => {
    // The multihash wrapper is what makes it `Qm…`; dropping it would still
    // produce a plausible-looking base58 string that is not an address.
    expect(deriveAddress(KEY_BYTES)).toMatch(/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/);
  });

  it('gives different addresses for keys differing in one byte', () => {
    const other = Uint8Array.from(KEY_BYTES);
    other[0] ^= 0x01;
    expect(deriveAddress(other)).not.toBe(EXPECTED);
  });
});
