/**
 * Does a claimed `.q` name actually belong to the account claiming it?
 *
 * This is the whole trust decision, reduced to a pure function so it can be
 * tested without a network, a hook or a render. Everything upstream of it is
 * plumbing; everything downstream is presentation.
 *
 * ## The predicate now comes from `@quilibrium/quorum-shared`
 *
 * Mobile shipped its own copy first, in `utils/`, desktop then needed the same
 * check, and rather than keep a third the check moved to shared — where
 * `deriveAddress` and `resolveName` already lived. Mobile's copy is gone.
 *
 * **This file did not go with it, and deliberately so.** The predicate is now
 * built and released in another repo, so without a test here mobile's suite
 * would report green while the one check the whole feature rests on changed
 * underneath it. The tests below are mobile's contract with that package: if a
 * shared release breaks any of them, it fails on the bump, in this repo, before
 * it can reach a build.
 *
 * ## Why every ambiguous case must return FALSE
 *
 * The `.q` suffix is the only signal a viewer gets that a name is verified —
 * there is no badge and there is deliberately never going to be one. So the
 * suffix carries the entire claim by itself, and the cost of the two errors is
 * wildly asymmetric:
 *
 * - Withholding a `.q` from its real owner is invisible and self-correcting.
 *   They render under their global name until the next lookup succeeds.
 * - Granting a `.q` to somebody who does not own it is an impersonation that
 *   the recipient cannot detect by looking, and a screenshot of it is
 *   permanent.
 *
 * So: no record, no key, a malformed key, an unparseable address — every one of
 * them is `false`. "I could not tell" and "no" must produce the same output,
 * which is why this function returns a boolean rather than a tri-state. A
 * caller that could distinguish them would eventually be tempted to render the
 * uncertain case optimistically.
 *
 * ## The fixture
 *
 * `KEY` is invented — 57 bytes of an arithmetic pattern, not anyone's real
 * key — and `ADDRESS` is what the app's own `deriveAddress` produces from it.
 * The pair is hard-coded rather than derived in the test on purpose: computing
 * the expectation with the same function under test would assert nothing at
 * all. If the derivation ever changes, on either side, this file goes red.
 */

// No mocks, on either import. `deriveAddress` was moved to its own module
// precisely so this test could use the REAL one: reaching it through the key
// service needed three stubs (the mnemonic library, its wordlist, and the
// native Rust module), and each stub is a place a future change breaks this
// silently.
import {
  claimedNameBelongsTo,
  deriveAddress as sharedDeriveAddress,
} from '@quilibrium/quorum-shared';
import { deriveAddress as mobileDeriveAddress } from '../utils/deriveAddress';

/** Invented ed448-shaped public key (57 bytes). Not a real account's. */
const KEY =
  '030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b';

/** What `deriveAddress(KEY)` produces. Hard-coded — see the header. */
const ADDRESS = 'QmRxwsciKWz7fvph4PobmabjChKPZtvkBcE4oALnogXDYW';

/** Somebody else. Shaped like a real address, belongs to nobody. */
const OTHER_ADDRESS = 'QmThemThemThemThemThemThemThemThemThemThemThem';

/** Bytes to lowercase hex, so the same key can be fed down both entry points. */
const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const record = (over: Record<string, unknown> = {}) => ({
  header: { authorityKey: '0xabc', name: 'alice', parent: null, createdAt: 0, updatedAt: 0 },
  address: '0xsomethingelse',
  resolveKey: KEY,
  metadata: null,
  ...over,
});

/**
 * Two address derivations now run inside one app, and they MUST agree.
 *
 * The predicate above derives with shared's `deriveAddress`; everything else in
 * mobile — space inbox addressing, roster row matching, `resolveSelfName` —
 * derives with `utils/deriveAddress`. They are genuinely different code:
 * mobile uses `multihashes` + `bs58`, shared hand-builds the multihash header
 * and uses `multiformats`' base58btc.
 *
 * If they ever diverge, nothing crashes. The claimant's real address simply
 * stops matching the address derived from their key, so every `.q` silently
 * stops verifying — the exact "looks like the feature was never built" failure
 * this area keeps producing. Neither repo's own tests can catch it, because
 * each is self-consistent. Only a test holding both at once can.
 */
describe('shared and mobile derive the same address', () => {
  it('agrees on the pinned fixture, from hex', () => {
    expect(sharedDeriveAddress(KEY)).toBe(ADDRESS);
    expect(mobileDeriveAddress(KEY)).toBe(ADDRESS);
  });

  it('agrees across many keys, on the BYTE path and the HEX path', () => {
    // Both arguments matter, and an earlier version of this test only had the
    // first — which made it much weaker than it looked. Both implementations
    // short-circuit on `typeof publicKey === 'string'`, so passing a
    // `Uint8Array` skips hex parsing entirely in both and exercises only
    // sha256 → multihash → base58. Hex parsing is where they actually differ
    // (mobile uses `@noble`'s `hexToBytes`, shared hand-rolls one), so a loop
    // that never passes a string cannot catch a divergence there at all.
    for (let n = 0; n < 200; n++) {
      const bytes = new Uint8Array(57);
      for (let i = 0; i < 57; i++) bytes[i] = (i * 31 + n * 17 + 5) % 256;
      const hex = toHex(bytes);

      expect(sharedDeriveAddress(bytes)).toBe(mobileDeriveAddress(bytes));
      expect(sharedDeriveAddress(hex)).toBe(mobileDeriveAddress(hex));
      expect(sharedDeriveAddress(`0x${hex}`)).toBe(mobileDeriveAddress(`0x${hex}`));
      // The two entry points must also agree with EACH OTHER, or a caller that
      // happens to hold bytes verifies a different address from one holding hex.
      expect(sharedDeriveAddress(hex)).toBe(sharedDeriveAddress(bytes));
    }
  });

  it('DIVERGES on malformed hex — pinned, because the guard is what saves us', () => {
    // Not a bug being tolerated: a real, MEASURED difference in behaviour that
    // the predicate is built around. Shared's hand-rolled `hexToBytes` left-pads
    // odd-length input and coerces non-hex characters to 0, so it returns a
    // plausible-looking address for garbage. Mobile's throws instead.
    //
    // Shared is safe anyway because `readKeyAsHex` validates even-length,
    // all-hex BEFORE calling `deriveAddress` — that guard, not the derivation,
    // is what makes a malformed key fail closed. Pinned here so that if anyone
    // ever "simplifies" the guard away on the grounds that `deriveAddress`
    // surely throws, this test explains why it does not.
    for (const bad of ['abc', '0xabc', 'zzzz', 'a'.repeat(113)]) {
      expect(() => mobileDeriveAddress(bad)).toThrow();
      expect(typeof sharedDeriveAddress(bad)).toBe('string');
    }

    // And the property that actually matters: none of it reaches a verdict.
    for (const bad of ['abc', '0xabc', 'zzzz', 'a'.repeat(113)]) {
      expect(claimedNameBelongsTo({ resolveKey: bad }, ADDRESS)).toBe(false);
    }
  });
});

describe('claimedNameBelongsTo', () => {
  it('accepts a name whose resolve key derives to the claimant address', () => {
    expect(claimedNameBelongsTo(record(), ADDRESS)).toBe(true);
  });

  it('rejects a name that resolves to somebody else', () => {
    // The impersonation case: the name is real and registered, it just is not
    // theirs. This is the single most important row in the table.
    expect(claimedNameBelongsTo(record(), OTHER_ADDRESS)).toBe(false);
  });

  it('rejects when the name did not resolve at all', () => {
    // A 404 from the batch endpoint arrives as a null slot, not an error.
    expect(claimedNameBelongsTo(null, ADDRESS)).toBe(false);
  });

  it('rejects a record carrying no resolve key', () => {
    // Registered and resolvable, but never pointed at a Quorum identity. Common
    // for names held on the Ethereum side; unverifiable by construction.
    expect(claimedNameBelongsTo(record({ resolveKey: undefined }), ADDRESS)).toBe(false);
  });

  it('rejects a malformed resolve key instead of throwing', () => {
    // Fails closed, and does not take the render path down with it. A throw
    // here would surface as a blank message list, which is a far worse outcome
    // than a name rendering without its suffix.
    //
    // Shared rejects these by VALIDATING the hex up front rather than by
    // catching a throw from `deriveAddress`, because shared's `deriveAddress`
    // coerces unparseable hex to zero bytes instead of throwing. Same answers,
    // reached by construction rather than by luck — see the note in shared's
    // `readKeyAsHex`.
    for (const bad of ['', 'zz', 'not-hex-at-all', '0x', KEY.slice(0, 20)]) {
      expect(claimedNameBelongsTo(record({ resolveKey: bad }), ADDRESS)).toBe(false);
    }
  });

  it('rejects a non-string key field instead of throwing', () => {
    // A record is parsed JSON behind a cast — nothing validates it at runtime,
    // so a field typed `string | null` can arrive as a number or an object.
    // Mobile's retired copy called `.trim()` on it directly and threw a
    // TypeError that escaped into the render path; this was the live latent
    // crash that adopting shared fixed, so it is pinned here rather than left
    // to shared's own suite.
    for (const bad of [12345, {}, [], true]) {
      expect(claimedNameBelongsTo(record({ resolveKey: bad }), ADDRESS)).toBe(false);
      expect(
        claimedNameBelongsTo(record({ resolveKey: undefined, resolve_key: bad }), ADDRESS),
      ).toBe(false);
    }
  });

  it('rejects an empty or missing claimant address', () => {
    // Nothing to compare against is not a pass.
    expect(claimedNameBelongsTo(record(), '')).toBe(false);
    expect(claimedNameBelongsTo(record(), '   ')).toBe(false);
    expect(claimedNameBelongsTo(record(), undefined)).toBe(false);
  });

  it('tolerates a 0x prefix on the resolve key', () => {
    // Production returns the key bare, but the app sends it prefixed when
    // registering and the reverse-lookup parameter is prefixed too. Accepting
    // both costs one `replace` and removes a whole class of silent mismatch.
    expect(claimedNameBelongsTo(record({ resolveKey: `0x${KEY}` }), ADDRESS)).toBe(true);
  });

  it('tolerates an uppercase resolve key', () => {
    expect(claimedNameBelongsTo(record({ resolveKey: KEY.toUpperCase() }), ADDRESS)).toBe(true);
  });

  it('accepts the base64 resolve_key a bucket lookup returns', () => {
    // The two spellings carry the same key in different encodings — `resolveKey`
    // hex from /resolve, `resolve_key` base64 from /bucket. Treating the second
    // as absent would silently unverify every record that came the bucket way,
    // and the symptom would be "my own name has no .q" with nothing logged.
    const base64 = Buffer.from(KEY, 'hex').toString('base64');
    expect(
      claimedNameBelongsTo(record({ resolveKey: undefined, resolve_key: base64 }), ADDRESS),
    ).toBe(true);
  });

  it('falls back to the base64 spelling when the hex one is unreadable', () => {
    // Shared reads the two spellings with `??` rather than a truthiness test, so
    // a record carrying a GARBAGE `resolveKey` alongside a valid `resolve_key`
    // still verifies. Mobile's retired copy stranded that record and rejected a
    // claim whose key was right there. Pinned because it is a behaviour mobile
    // GAINED in the migration, and a future simplification could lose it.
    const base64 = Buffer.from(KEY, 'hex').toString('base64');
    expect(
      claimedNameBelongsTo(record({ resolveKey: 'not-hex', resolve_key: base64 }), ADDRESS),
    ).toBe(true);
  });

  it('does not compare addresses case-insensitively', () => {
    // base58 is case-SIGNIFICANT: `QmAbc` and `Qmabc` are different addresses.
    // Lowercasing before comparison, the reflex from hex and Ethereum work,
    // would make near-miss addresses verify against each other.
    expect(claimedNameBelongsTo(record(), ADDRESS.toLowerCase())).toBe(false);
  });
});
