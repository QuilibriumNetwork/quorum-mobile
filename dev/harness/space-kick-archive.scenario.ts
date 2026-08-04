// Offline. Runtime-falsifies issue #216: "Kicking a member permanently destroys
// the space's pre-kick message archive for everyone."
//
// Why this scenario exists. #216 was produced by code reading — its own header
// says "Nothing here has been runtime-reproduced yet; treat the citations as the
// evidence, not the conclusions." It claims permanent, silent, irreversible loss
// of message history for members who were never the target of the kick. That is
// the highest-blast-radius open claim on mobile, and it rests entirely on
// inference. This scenario converts it to a measurement, either way:
//
//   - if the archive really is orphaned, the defect assertions below pass and
//     #216 stops being a theory;
//   - if some path rescues it, they fail here rather than in production, and
//     #216 gets closed for free.
//
// What it drives, and what is transcribed. The storage half is REAL: this
// imports services/config/spaceStorage unmodified and calls the same
// saveSpaceKey() that kickUser() calls, so the single-slot overwrite is
// exercised, not modelled. The crypto is real too — actual X448 and actual
// inbox encrypt/decrypt from the Rust crate.
//
// The seal/unseal COMPOSITION is transcribed from
// services/crypto/native-provider.ts (sealHubEnvelope ~:744, unsealHubEnvelope
// ~:882) rather than imported, because wasm-provider-shim.ts deliberately stubs
// both as `nativeOnly('space path — out of DM scope')`. Transcribing keeps this
// scenario honest about what it proves: the CLAIM under test is about key
// rotation and storage, and the envelope is only the vehicle. The transcription
// is the config-key branch only — nine lines, and the part that matters is that
// the config key is used DIRECTLY as the X448 keypair, with no derivation step
// that could survive a rotation.
//
// ⚠️ DRIFT RISK, same as the shim's own note: if native-provider's config-key
// branch changes, change sealForConfigKey/unsealForConfigKey below to match.
//
// What this does NOT cover, deliberately (see README's caveats):
//   - the uniffi bridge and the native batch decrypt path — this runs the crate's
//     WASM build, as every scenario here does.
//   - kickUser() end to end. It needs a live client, owner/space/hub keys and a
//     relay round-trip. What is reproduced here is the one operation the issue
//     actually accuses (spaceService.ts:564-578): generate a fresh X448 config
//     keypair and saveSpaceKey it into the same 'config' slot.
//   - whether the SERVER still holds the ciphertext. The issue asserts it does;
//     that is a server question and cannot be answered from here.
//
// Run: npx jest --config jest.harness.config.js space-kick-archive
// Same specifier native-provider.ts:29 uses — the fallback below must derive the
// key the real code would derive, not merely a sha512 from somewhere.
import { sha512 as nobleSha512 } from '@noble/hashes/sha2.js';

import { __resetAllMMKV } from './mmkv-shim';
import { NativeCryptoProvider } from './wasm-provider-shim';
import {
  getSpaceKey,
  getSpaceKeys,
  saveSpaceKey,
} from '@/services/config/spaceStorage';

const SPACE_ID = 'harness-space-kick-archive';

const bytesToHex = (b: number[]) => Buffer.from(b).toString('hex');
const hexToBytes = (h: string) => Array.from(Buffer.from(h, 'hex'));

type Sealed = { ephemeralPublicKeyHex: string; envelope: string };

/**
 * native-provider.ts sealHubEnvelope, config-key branch only.
 *
 * The whole of #216 turns on this line from the real implementation:
 *
 *     if (configKey) { x448PublicKey = configKey.publicKey; }
 *
 * The config key IS the encryption key — not a seed, not an input to a KDF.
 * Nothing about the envelope can be reconstructed from a later key.
 *
 * The Ed448 hub signature step is omitted: it authenticates the envelope, it is
 * not part of decrypting it, and #216 makes no claim about it.
 */
async function sealForConfigKey(
  crypto: NativeCryptoProvider,
  configPublicKeyHex: string,
  plaintext: string
): Promise<Sealed> {
  const ephemeral = await crypto.generateX448();
  const envelope = (await crypto.encryptInboxMessage({
    inbox_public_key: hexToBytes(configPublicKeyHex),
    ephemeral_private_key: ephemeral.private_key,
    plaintext: Array.from(new TextEncoder().encode(plaintext)),
  } as never)) as string;

  return {
    ephemeralPublicKeyHex: bytesToHex(Array.from(ephemeral.public_key)),
    envelope,
  };
}

/**
 * native-provider.ts unsealHubEnvelope, config-key branch only.
 *
 * Returns the plaintext, or null on any failure. Null rather than throwing
 * because the two crypto backends do not agree on how a decrypt failure
 * surfaces — the WASM provider throws for some errors and returns empty for
 * others (wasm-provider-shim's header documents this, and it cost real time
 * during the DM investigation). Collapsing both into null means the assertions
 * below test "could this be read", which is the actual question, rather than
 * accidentally testing which error shape today's backend happens to produce.
 */
async function unsealForConfigKey(
  crypto: NativeCryptoProvider,
  configPrivateKeyHex: string,
  sealed: Sealed
): Promise<string | null> {
  try {
    const decrypted = (await crypto.decryptInboxMessage({
      inbox_private_key: hexToBytes(configPrivateKeyHex),
      ephemeral_public_key: hexToBytes(sealed.ephemeralPublicKeyHex),
      ciphertext: JSON.parse(sealed.envelope) as Record<string, unknown>,
    } as never)) as number[] | null;

    if (!decrypted || decrypted.length === 0) return null;
    return new TextDecoder().decode(new Uint8Array(decrypted));
  } catch {
    return null;
  }
}

/**
 * The rotation kickUser() performs, reduced to the two lines the issue accuses:
 * generate a fresh X448 config keypair, then saveSpaceKey it under the SAME
 * 'config' keyId (spaceService.ts:564-578).
 *
 * This calls mobile's real saveSpaceKey. If an archive slot were ever added,
 * this function would keep working and the defect assertions below would start
 * failing — which is exactly the signal wanted.
 */
async function rotateConfigKeyAsKickDoes(crypto: NativeCryptoProvider) {
  const next = await crypto.generateX448();
  const publicKey = bytesToHex(Array.from(next.public_key));
  const privateKey = bytesToHex(Array.from(next.private_key));
  saveSpaceKey({ spaceId: SPACE_ID, keyId: 'config', publicKey, privateKey });
  return { publicKey, privateKey };
}

describe('#216 — does a kick orphan the pre-kick space archive? (offline, real X448)', () => {
  let crypto: NativeCryptoProvider;

  beforeEach(async () => {
    __resetAllMMKV();
    crypto = new NativeCryptoProvider();

    // Seed the space's config key v1, the way create/join leaves it.
    const v1 = await crypto.generateX448();
    saveSpaceKey({
      spaceId: SPACE_ID,
      keyId: 'config',
      publicKey: bytesToHex(Array.from(v1.public_key)),
      privateKey: bytesToHex(Array.from(v1.private_key)),
    });
  });

  afterEach(() => {
    __resetAllMMKV();
  });

  // ---- controls ----
  // These come first and they are not decoration. Every "cannot be decrypted"
  // assertion below is trivially satisfiable by a scenario that simply cannot
  // decrypt ANYTHING — a wrong hex conversion, a shim that returns empty, a
  // typo in the envelope shape. Without these controls the defect assertions
  // would pass just as happily against a completely broken harness, which is
  // the failure mode README finding #4 already burned this suite once.

  it('CONTROL: a message sealed to the config key round-trips with that same key', async () => {
    const v1 = getSpaceKey(SPACE_ID, 'config');
    expect(v1).not.toBeNull();

    const sealed = await sealForConfigKey(crypto, v1!.publicKey, 'pre-kick history');
    expect(await unsealForConfigKey(crypto, v1!.privateKey, sealed)).toBe('pre-kick history');
  });

  it('CONTROL: after rotation, a NEWLY sealed message round-trips with the stored key', async () => {
    await rotateConfigKeyAsKickDoes(crypto);

    const current = getSpaceKey(SPACE_ID, 'config')!;
    const sealed = await sealForConfigKey(crypto, current.publicKey, 'post-kick message');
    expect(await unsealForConfigKey(crypto, current.privateKey, sealed)).toBe('post-kick message');
  });

  // ---- the claim ----

  it('documents the defect: rotation overwrites the single config slot, keeping no archive', async () => {
    const before = getSpaceKey(SPACE_ID, 'config')!;
    await rotateConfigKeyAsKickDoes(crypto);

    const after = getSpaceKey(SPACE_ID, 'config')!;
    expect(after.publicKey).not.toBe(before.publicKey);

    // The storage half of #216, measured rather than read: exactly one 'config'
    // entry exists, so the previous key is not merely superseded — it is gone.
    //
    // WHEN #216 IS FIXED this assertion inverts, and that is the intended
    // signal: retained keys are the whole fix, so a red line here means the
    // archive slots landed. Update it then; do not delete it.
    const configSlots = getSpaceKeys(SPACE_ID).filter((k) => k.keyId.startsWith('config'));
    expect(configSlots).toHaveLength(1);
    expect(configSlots[0].publicKey).toBe(after.publicKey);
  });

  it('documents the defect: pre-kick messages become unreadable to a REMAINING member', async () => {
    // The point of the issue. Not the kicked user — a member who stayed, whose
    // device holds whatever storage holds after the rotation.
    const v1 = getSpaceKey(SPACE_ID, 'config')!;
    const archive = await sealForConfigKey(crypto, v1.publicKey, 'pre-kick history');

    // Sanity: readable BEFORE the kick. If this ever fails, the assertion below
    // proves nothing at all.
    expect(await unsealForConfigKey(crypto, v1.privateKey, archive)).toBe('pre-kick history');

    await rotateConfigKeyAsKickDoes(crypto);

    // Everything the device can still reach, tried against the archive.
    const held = getSpaceKeys(SPACE_ID);
    const recovered = await Promise.all(
      held.map((k) => unsealForConfigKey(crypto, k.privateKey, archive))
    );

    // WHEN #216 IS FIXED this inverts too: one retained key should recover it.
    expect(recovered.every((r) => r === null)).toBe(true);
  });

  // Not a defect marker — this one stays green after the fix too, verified by
  // simulating archive slots and watching the two above flip while this did not.
  // It closes an escape hatch rather than recording the bug.
  it('NO RESCUE: the legacy hub-derived fallback cannot open the archive either', async () => {
    // unsealHubEnvelope falls back to SHA-512(hub ed448 private key) when no
    // config key is passed. Worth pinning: if that path could open a
    // config-sealed envelope, the archive would survive by accident and the
    // issue's impact section would be wrong. It cannot — the envelope was
    // sealed to the config public key, and the hub-derived key is unrelated —
    // but "obviously true" is exactly the kind of claim this scenario exists to
    // stop taking on faith.
    const v1 = getSpaceKey(SPACE_ID, 'config')!;
    const archive = await sealForConfigKey(crypto, v1.publicKey, 'pre-kick history');
    await rotateConfigKeyAsKickDoes(crypto);

    const hubEd448 = await crypto.generateEd448();
    const derived = bytesToHex(
      Array.from(nobleSha512(new Uint8Array(hubEd448.private_key)).slice(0, 56))
    );

    expect(await unsealForConfigKey(crypto, derived, archive)).toBeNull();
  });

  // ---- negative control on the harness itself ----

  it('CONTROL: an unrelated fresh key cannot read a message it never sealed', async () => {
    // Guards the inverse mistake: if unsealForConfigKey returned a plaintext for
    // ANY key, every "unreadable" result above would be meaningless. This is the
    // cheapest possible check that decrypt actually discriminates.
    const v1 = getSpaceKey(SPACE_ID, 'config')!;
    const archive = await sealForConfigKey(crypto, v1.publicKey, 'pre-kick history');

    const stranger = await crypto.generateX448();
    const strangerPriv = bytesToHex(Array.from(stranger.private_key));
    expect(await unsealForConfigKey(crypto, strangerPriv, archive)).toBeNull();
  });
});
