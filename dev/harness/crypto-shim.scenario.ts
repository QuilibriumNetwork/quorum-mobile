// Offline. Proves the crypto seam end to end: two parties establish a real X3DH
// session and exchange double-ratchet messages THROUGH THE SHIM, using the same
// CryptoProvider interface mobile's own code calls.
//
// This is the keystone for every later slice. If mobile's crypto abstraction
// works headlessly, the rest is transport and storage wiring. If it does not,
// nothing above it is worth building.
//
// Run: yarn harness
import { NativeCryptoProvider } from './wasm-provider-shim';

const SESSION_KEY_LENGTH = 96; // 32 session + 32 sending header + 32 receiving header

const b64ToBytes = (b64: string) => Array.from(Buffer.from(b64, 'base64'));

describe('crypto shim (offline)', () => {
  it('establishes a real X3DH session and round-trips double-ratchet messages', async () => {
    const alice = new NativeCryptoProvider();
    const bob = new NativeCryptoProvider();

    // Long-term identity + signed pre-keys, and Alice's one-shot ephemeral.
    const aliceIdentity = await alice.generateX448();
    const bobIdentity = await bob.generateX448();
    const bobSignedPre = await bob.generateX448();
    const aliceEphemeral = await alice.generateX448();

    // Both sides derive the SAME 96-byte secret from opposite directions. This
    // is the real agreement — if the two backends disagreed on anything, the
    // keys would differ here and every later assertion would be meaningless.
    const aliceSecret = await alice.senderX3DH({
      sending_identity_private_key: aliceIdentity.private_key,
      sending_ephemeral_private_key: aliceEphemeral.private_key,
      receiving_identity_key: bobIdentity.public_key,
      receiving_signed_pre_key: bobSignedPre.public_key,
      session_key_length: SESSION_KEY_LENGTH,
    });
    const bobSecret = await bob.receiverX3DH({
      sending_identity_private_key: bobIdentity.private_key,
      sending_signed_private_key: bobSignedPre.private_key,
      receiving_identity_key: aliceIdentity.public_key,
      receiving_ephemeral_key: aliceEphemeral.public_key,
      session_key_length: SESSION_KEY_LENGTH,
    });

    expect(aliceSecret).toBe(bobSecret);

    const secret = b64ToBytes(aliceSecret);
    const sessionKey = secret.slice(0, 32);
    const sendingHeaderKey = secret.slice(32, 64);
    const nextReceivingHeaderKey = secret.slice(64, 96);

    let aliceState = await alice.newDoubleRatchet({
      session_key: sessionKey,
      sending_header_key: sendingHeaderKey,
      next_receiving_header_key: nextReceivingHeaderKey,
      is_sender: true,
      sending_ephemeral_private_key: aliceEphemeral.private_key,
      receiving_ephemeral_key: bobSignedPre.public_key,
    });
    let bobState = await bob.newDoubleRatchet({
      session_key: sessionKey,
      sending_header_key: sendingHeaderKey,
      next_receiving_header_key: nextReceivingHeaderKey,
      is_sender: false,
      sending_ephemeral_private_key: bobSignedPre.private_key,
      receiving_ephemeral_key: aliceEphemeral.public_key,
    });

    // A→B
    const plaintext = 'harness: mobile crypto running headlessly';
    const sent = await alice.doubleRatchetEncrypt({
      ratchet_state: aliceState,
      message: Array.from(new TextEncoder().encode(plaintext)),
    });
    aliceState = sent.ratchet_state;

    const received = await bob.doubleRatchetDecrypt({
      ratchet_state: bobState,
      envelope: sent.envelope,
    });
    bobState = received.ratchet_state;

    expect(new TextDecoder().decode(new Uint8Array(received.message))).toBe(plaintext);

    // B→A, which forces a DH ratchet turn — the step where the two sides would
    // diverge if state handling were wrong. A one-way test would miss it.
    const replyText = 'and back again';
    const reply = await bob.doubleRatchetEncrypt({
      ratchet_state: bobState,
      message: Array.from(new TextEncoder().encode(replyText)),
    });
    const replyOut = await alice.doubleRatchetDecrypt({
      ratchet_state: aliceState,
      envelope: reply.envelope,
    });

    expect(new TextDecoder().decode(new Uint8Array(replyOut.message))).toBe(replyText);
  });

  it('refuses the native-only batch paths loudly instead of degrading silently', async () => {
    const provider = new NativeCryptoProvider();

    // A scenario that silently fell back to per-message decrypt here would
    // "pass" while never touching the batch path — which is both mobile's DM
    // receive fast path and a live suspect. Failing loudly is the point.
    await expect(provider.batchProcessMessages()).rejects.toThrow(/native-only/);
    await expect(provider.batchUnsealEnvelopes()).rejects.toThrow(/native-only/);
  });

  it('can be constructed repeatedly (WASM init is once-per-process)', () => {
    // initSync throws if called twice, so scenarios must be free to construct
    // providers without coordinating. Guard regression would break every later
    // slice in a confusing way.
    expect(() => {
      new NativeCryptoProvider();
      new NativeCryptoProvider();
    }).not.toThrow();
  });
});
