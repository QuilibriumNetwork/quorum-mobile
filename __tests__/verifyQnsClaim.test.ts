/**
 * Does a claimed `.q` name actually belong to the account claiming it?
 *
 * This is the whole trust decision, reduced to a pure function so it can be
 * tested without a network, a hook or a render. Everything upstream of it is
 * plumbing; everything downstream is presentation.
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
 * all. If the derivation ever changes, this file goes red.
 */

// No mocks. `deriveAddress` was moved to its own module precisely so this test
// could import the REAL one: reaching it through the key service needed three
// stubs (the mnemonic library, its wordlist, and the native Rust module), and
// each stub is a place a future change breaks this silently.
import { claimedNameBelongsTo } from '../utils/verifyQnsClaim';

/** Invented ed448-shaped public key (57 bytes). Not a real account's. */
const KEY =
  '030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b';

/** What `deriveAddress(KEY)` produces. Hard-coded — see the header. */
const ADDRESS = 'QmRxwsciKWz7fvph4PobmabjChKPZtvkBcE4oALnogXDYW';

/** Somebody else. Shaped like a real address, belongs to nobody. */
const OTHER_ADDRESS = 'QmThemThemThemThemThemThemThemThemThemThemThem';

const record = (over: Record<string, unknown> = {}) => ({
  header: { authorityKey: '0xabc', name: 'alice', parent: null, createdAt: 0, updatedAt: 0 },
  address: '0xsomethingelse',
  resolveKey: KEY,
  metadata: null,
  ...over,
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
    for (const bad of ['', 'zz', 'not-hex-at-all', '0x', KEY.slice(0, 20)]) {
      expect(claimedNameBelongsTo(record({ resolveKey: bad }), ADDRESS)).toBe(false);
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

  it('does not compare addresses case-insensitively', () => {
    // base58 is case-SIGNIFICANT: `QmAbc` and `Qmabc` are different addresses.
    // Lowercasing before comparison, the reflex from hex and Ethereum work,
    // would make near-miss addresses verify against each other.
    expect(claimedNameBelongsTo(record(), ADDRESS.toLowerCase())).toBe(false);
  });
});
