// Offline. Proves mobile's join gate accepts a join built and signed exactly the
// way DESKTOP builds and signs one — using the real ed448 implementation from the
// Rust channel crate, not a mocked verifier.
//
// Why this scenario exists. `verifyJoinParticipant` reconstructs the 10-field blob
// desktop signs and verifies it. If that reconstruction drifts by one field, one
// separator or one encoding, the failure is not "a forged join slips through" — it
// is "EVERY REAL JOIN IS REJECTED", silently, on the happy path of every new
// member. The unit tests in __tests__/spaceControlOwnerAuth.test.ts pin the blob's
// SHAPE, but they mock the verifier, so they cannot catch a construction that is
// self-consistently wrong on both sides.
//
// This closes that gap: the blob is built HERE from desktop's own expression
// (MessageService's join branch / InvitationService's send side, transcribed
// independently below), signed with real ed448, and handed to mobile's gate with
// the real verifier wired in. Agreement is then evidence, not assertion.
//
// What it still does NOT cover, deliberately (see README's caveats):
//   - the uniffi bridge. This runs the crate's WASM build; the app calls the same
//     Rust through uniffi, where `parseVerifyResult` string-sniffs the native
//     reply. A native response like "invalid: bad key length" throws there and
//     returns false here.
//   - anything above the gate: real hub delivery, real ratchet state, the peer
//     maps, storage.
//
// Run: yarn harness:join   (or: npx jest --config jest.harness.config.js join-parity)
import { deriveInboxAddress } from '@quilibrium/quorum-shared';
import { verifyJoinParticipant } from '../../services/space/spaceMessageAuth';
import { initHarnessCrypto } from './wasm-provider-shim';

type Ed448Wasm = {
  /** Returns JSON `{public_key: number[], private_key: number[]}` — raw bytes, not base64. */
  js_generate_ed448(): string;
  js_sign_ed448(key: string, message: string): string;
};

const wasm = () => initHarnessCrypto() as unknown as Ed448Wasm;

/** The crate returns JSON-quoted strings on success, bare error text on failure. */
function unquote(result: string, what: string): string {
  try {
    return JSON.parse(result) as string;
  } catch {
    throw new Error(`[harness] ${what} failed: ${result}`);
  }
}

const bytesToHex = (b: number[]) => Buffer.from(b).toString('hex');
const bytesToB64 = (b: number[]) => Buffer.from(b).toString('base64');
const utf8ToB64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64');

/**
 * Desktop's signed blob, transcribed from its own source rather than imported
 * from mobile's `buildJoinSignedBlob`. Importing mobile's version would make this
 * a tautology — it would agree with itself no matter how wrong it was.
 *
 * Desktop (MessageService, join branch):
 *   Buffer.from(participant.address + participant.id + participant.inboxAddress +
 *     participant.pubKey + participant.inboxKey + participant.identityKey +
 *     participant.preKey + participant.userIcon + participant.displayName +
 *     participant.joinedAt, 'utf-8').toString('base64')
 */
function desktopSignedBlob(p: Record<string, unknown>): string {
  return utf8ToB64(
    String(p.address) +
      String(p.id) +
      String(p.inboxAddress) +
      String(p.pubKey) +
      String(p.inboxKey) +
      String(p.identityKey) +
      String(p.preKey) +
      String(p.userIcon) +
      String(p.displayName) +
      String(p.joinedAt)
  );
}

/**
 * A participant announcement signed with a real ed448 key, desktop-style.
 *
 * TWO SEPARATE KEYPAIRS, because that is what desktop actually sends and getting
 * this wrong is not hypothetical — the first version of this fixture derived
 * `inboxAddress` from `inboxPubKey`, which made the payload self-consistent in a
 * way no real desktop payload ever is. It therefore could not catch a gate that
 * required them to match, and one shipped that rejected every genuine desktop
 * join. A fixture that is tidier than production is a fixture that tests nothing.
 *
 *   inboxAddress  <- a FRESH per-space ed448 keypair (InvitationService ~:625)
 *   inboxPubKey   <- the DEVICE keyset's inbox key, which also signs (~:812, ~:855)
 */
function makeSignedJoin(over: Record<string, unknown> = {}) {
  const w = wasm();
  const gen = () =>
    JSON.parse(w.js_generate_ed448()) as { public_key: number[]; private_key: number[] };

  const deviceInboxKey = gen(); // announced as inboxPubKey, and signs the blob
  const spaceInboxKey = gen(); // only its address is announced

  // Same encodings the wire uses: the key is hex, the signature base64.
  const inboxPubKey = bytesToHex(deviceInboxKey.public_key);
  const inboxPrivateKeyB64 = bytesToB64(deviceInboxKey.private_key);

  const participant = {
    address: 'QmJoinerAddressForHarnessRun',
    id: 2,
    // Deliberately NOT derived from inboxPubKey — see the note above.
    inboxAddress: deriveInboxAddress(bytesToHex(spaceInboxKey.public_key)),
    inboxPubKey,
    pubKey: 'aa'.repeat(56),
    inboxKey: 'bb'.repeat(56),
    identityKey: 'cc'.repeat(56),
    preKey: 'dd'.repeat(56),
    // Non-ASCII on purpose: the blob is UTF-8 base64, and a latin1 `btoa` would
    // diverge here rather than on plain names. Mobile's send side hit exactly
    // this and the comment there still warns about it.
    userIcon: '',
    displayName: 'Ada Lovelace è ù 🌐',
    joinedAt: 1_700_000_000_000,
    ...over,
  };

  const signature = unquote(
    w.js_sign_ed448(inboxPrivateKeyB64, desktopSignedBlob(participant)),
    'sign_ed448'
  );
  return { participant: { ...participant, signature } };
}

describe('join gate vs a real desktop-shaped join (offline, real ed448)', () => {
  it('ACCEPTS a join built and signed exactly as desktop builds and signs one', async () => {
    const { participant } = makeSignedJoin();
    expect(await verifyJoinParticipant(participant)).toBe('valid');
  });

  it('accepts one with an empty display name and icon (the omitted-field shape)', async () => {
    const { participant } = makeSignedJoin({ displayName: '', userIcon: '' });
    expect(await verifyJoinParticipant(participant)).toBe('valid');
  });

  // ---- negative controls ----
  // Without these, "valid" above proves nothing: a gate that returned 'valid'
  // unconditionally would pass the two tests above.

  it('REJECTS a join whose display name was altered after signing', async () => {
    const { participant } = makeSignedJoin();
    expect(
      await verifyJoinParticipant({ ...participant, displayName: 'Mallory' })
    ).toBe('signature-invalid');
  });

  it('REJECTS a join whose joinedAt was altered after signing', async () => {
    const { participant } = makeSignedJoin();
    expect(await verifyJoinParticipant({ ...participant, joinedAt: 1 })).toBe(
      'signature-invalid'
    );
  });

  it('REJECTS a signature made by a different key than the one announced', async () => {
    const a = makeSignedJoin();
    const b = makeSignedJoin();
    // b's signature over b's blob, presented with a's key and a's blob.
    expect(
      await verifyJoinParticipant({ ...a.participant, signature: b.participant.signature })
    ).toBe('signature-invalid');
  });

  it('ACCEPTS despite inboxAddress not deriving from inboxPubKey — desktop parity', async () => {
    // The regression this pins. Desktop announces an inboxAddress from one
    // keypair and an inboxPubKey from another; requiring them to match rejected
    // every real desktop join. Desktop's own verify does not check this, and
    // neither may mobile.
    const { participant } = makeSignedJoin();
    expect(deriveInboxAddress(participant.inboxPubKey)).not.toBe(participant.inboxAddress);
    expect(await verifyJoinParticipant(participant)).toBe('valid');
  });

  it('still REJECTS if inboxAddress is altered after signing (it IS in the blob)', async () => {
    // Not free-form: inboxAddress is one of the ten signed fields, so it cannot
    // be swapped even though it is unrelated to the signing key.
    const { participant } = makeSignedJoin();
    expect(
      await verifyJoinParticipant({ ...participant, inboxAddress: deriveInboxAddress('ab'.repeat(57)) })
    ).toBe('signature-invalid');
  });

  it('REJECTS an unsigned join', async () => {
    const { participant } = makeSignedJoin();
    expect(
      await verifyJoinParticipant({ ...participant, signature: undefined })
    ).toBe('proof-missing');
  });
});
