// The crypto seam. This is what lets mobile's client code run in Node at all.
//
// The app talks to the Rust `channel` crate through uniffi — `libchannel.so`,
// ARM machine code, reached via Expo's native module bridge. A Node process on a
// PC cannot load that: there is no Android runtime and the wrong CPU. So
// `requireNativeModule('QuorumCrypto')` fails before any harness code runs.
//
// The SAME Rust crate also has a WASM build (that is what desktop/web use), and
// WASM runs in any JS engine. `quorum-shared` already models exactly this split:
// `CryptoProvider` is the interface, `NativeCryptoProvider` and
// `WasmCryptoProvider` are its two backends. Swapping one for the other is the
// architecture working as designed, not a hack.
//
// Named `NativeCryptoProvider` deliberately: every call site in the app does a
// bare `new NativeCryptoProvider()`, so aliasing the module in
// jest.harness.config.js swaps the backend with ZERO app changes.
//
// ⚠️ WHAT THIS COSTS — do not let a green harness be read as "mobile is healthy":
//   - the uniffi bridge is NOT exercised (parseNativeResult's error sniffing,
//     the base64/JSON round-trips, ratchet-mutex under real native async timing)
//   - the native-only BATCH decrypt path cannot run here at all
//   - anything that is a defect in the .so rather than in the crate is invisible
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// Same specifier native-provider.ts uses for its own sha512, so the legacy
// hub-derived branch of unsealHubEnvelope below derives the key the real code
// would derive rather than a lookalike from elsewhere.
import { sha512 as nobleSha512 } from '@noble/hashes/sha2.js';
import { channel_raw } from '@quilibrium/quilibrium-js-sdk-channels';
import { WasmCryptoProvider, type ChannelWasmModule } from '@quilibrium/quorum-shared';

// The published SDK package ships no .wasm; it is resolved from the SDK source
// checkout, the same convention desktop's harness uses. Override with SDK_WASM.
const WASM_PATH =
  process.env.SDK_WASM ??
  resolve(
    __dirname,
    '../../../quorum-desktop/node_modules/@quilibrium/quilibrium-js-sdk-channels/src/wasm/channelwasm_bg.wasm'
  );

let initialised = false;
let wrapped: Record<string, unknown> | null = null;

/**
 * Initialise the crate's WASM binding exactly once per process.
 *
 * `channel_raw` and the high-level `channel` API are one bundle sharing a single
 * `wasm` var, so this initialises both. Calling initSync twice throws, hence the
 * guard — scenarios construct providers freely and must not have to coordinate.
 */
/**
 * The crate signals failure by RETURNING an error string, and quorum-shared's
 * parseWasmResult only recognises some of them — it tests for `invalid`/`error`
 * prefixes and the substrings `failed`/`Error`. A crate error outside that set
 * (e.g. one beginning "Decryption ...") falls through to JSON.parse and reaches
 * the app as a bare `SyntaxError: Unexpected token 'D'`, with no indication of
 * which crypto call produced it.
 *
 * This wrapper does not change behaviour — a failure is still a failure — it
 * makes it SAY WHERE IT CAME FROM, by prefixing unrecognised non-JSON returns
 * with `error:` and the function name. Diagnosing a decrypt failure without this
 * means bisecting a dozen candidate calls by hand.
 */
// A Proxy cannot do this: the wasm bindings are non-writable, non-configurable
// data properties, and a `get` trap returning anything other than the actual
// value violates a proxy invariant (it throws at the first access). So build a
// plain object of wrapped functions instead.
function nameCrateErrors(mod: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(mod)) {
    const value = mod[key];
    if (typeof value !== 'function' || !key.startsWith('js_')) {
      out[key] = value;
      continue;
    }
    out[key] = (...args: unknown[]) => {
      const result = (value as (...a: unknown[]) => unknown).apply(mod, args);
      if (typeof result !== 'string') return result;
      // Valid JSON, or a quoted string: a normal success return.
      try {
        JSON.parse(result);
        return result;
      } catch {
        /* not JSON — fall through */
      }
      if (result.startsWith('"')) return result;
      if (process.env.HARNESS_CRYPTO_DEBUG === '1') {
        // eslint-disable-next-line no-console
        console.error(`[harness] ${key} returned a crate error: ${result.slice(0, 300)}`);
      }
      // Already recognisable to parseWasmResult? Leave it exactly as the crate
      // wrote it, so error text the app may match on is not altered.
      if (
        result.startsWith('invalid') ||
        result.startsWith('error') ||
        result.includes('failed') ||
        result.includes('Error')
      ) {
        return result;
      }
      return `error: ${key}: ${result}`;
    };
  }
  return out;
}

export function initHarnessCrypto(): ChannelWasmModule {
  if (!initialised) {
    channel_raw.initSync(readFileSync(WASM_PATH));
    initialised = true;
    wrapped = nameCrateErrors(channel_raw as unknown as Record<string, unknown>);
  }
  return wrapped as unknown as ChannelWasmModule;
}

/** Methods that exist ONLY in the native module — no WASM or JS equivalent. */
function nativeOnly(name: string): never {
  throw new Error(
    `[harness] ${name}() is native-only (uniffi → Rust) and has no WASM equivalent, ` +
      `so it cannot run headlessly. A scenario reaching this is silently routing ` +
      `around the very code it means to test — force the per-message path instead. ` +
      `See dev/harness/README.md "What it deliberately does NOT test".`
  );
}

/**
 * Drop-in for services/crypto/native-provider's NativeCryptoProvider.
 *
 * Inherits the whole CryptoProvider surface from WasmCryptoProvider — key
 * generation, X3DH, double and triple ratchet, inbox encrypt/decrypt — because
 * both implement the same interface against the same crate.
 */
export class NativeCryptoProvider extends WasmCryptoProvider {
  constructor() {
    super(initHarnessCrypto());
  }

  // ---- methods NativeCryptoProvider has that WasmCryptoProvider lacks ----
  //
  // The two backends are not symmetric: mobile's provider adds ten methods on
  // top of the shared CryptoProvider interface. Of those, all but the batch pair
  // are ordinary JS built on interface primitives, so they are reproduced here.
  //
  // ⚠️ DRIFT RISK, stated plainly: these mirror
  // services/crypto/native-provider.ts. They are small and stable, but if that
  // file's versions change, change these to match. The alternative — importing
  // the real class — is impossible, since importing it loads the native module.

  /** Base64 in, base64 out. Registration signs with this. */
  async signEd448(privateKey: string, message: string): Promise<string> {
    const wasm = initHarnessCrypto() as unknown as {
      js_sign_ed448(k: string, m: string): string;
    };
    const result = wasm.js_sign_ed448(privateKey, message);
    try {
      return JSON.parse(result) as string;
    } catch {
      // The crate returns a bare error string on failure. Fail here rather than
      // pass an unusable "signature" on to a peer that cannot verify it.
      throw new Error(`[harness] signEd448 failed: ${result}`);
    }
  }

  /**
   * The two backends disagree on how a decrypt FAILURE is reported, and mobile's
   * app code is written against the native one.
   *
   *   native: returns { ratchet_state: <unchanged>, message: [], decryptionError }
   *           and never throws — encryption-service checks exactly that shape and
   *           falls through to the next decryption strategy.
   *   wasm:   parseWasmResult() THROWS on strings it recognises as errors, and
   *           JSON.parses anything else — so a crate error it does not recognise
   *           (e.g. one starting "Decryption ...") surfaces as a bare SyntaxError
   *           from deep inside the provider.
   *
   * Either way mobile's graceful fallback never runs, and a recoverable failure
   * is turned into a hard one. Presenting the native convention here is what
   * makes the harness faithful to the app's own error handling.
   */
  async doubleRatchetDecrypt(
    stateAndEnvelope: { ratchet_state: string; envelope: string }
  ): Promise<{ ratchet_state: string; message: number[]; decryptionError?: string }> {
    const wasm = initHarnessCrypto() as unknown as {
      js_double_ratchet_decrypt(input: string): string;
    };
    const result = wasm.js_double_ratchet_decrypt(
      JSON.stringify({
        ratchet_state: stateAndEnvelope.ratchet_state,
        envelope: stateAndEnvelope.envelope,
      })
    );

    const fail = (why: string) => {
      if (process.env.HARNESS_CRYPTO_DEBUG === '1') {
        // eslint-disable-next-line no-console
        console.error('[harness] doubleRatchetDecrypt failed:', why.slice(0, 300));
      }
      return { ratchet_state: stateAndEnvelope.ratchet_state, message: [], decryptionError: why };
    };

    let parsed: { ratchet_state?: unknown; message?: unknown };
    try {
      parsed = JSON.parse(result) as typeof parsed;
    } catch {
      return fail(result);
    }
    if (typeof parsed.ratchet_state !== 'string') return fail('ratchet_state is not a string');

    // The crate returns `message` as EITHER a base64 string or a byte array.
    // parseWasmResult does not normalise this, so on the string form mobile's
    // code ends up doing new Uint8Array("<base64>") — which yields nothing, with
    // no error anywhere. Mobile's native parser base64-decodes; match it.
    let messageBytes: number[];
    if (typeof parsed.message === 'string') {
      messageBytes = Array.from(Buffer.from(parsed.message, 'base64'));
    } else if (Array.isArray(parsed.message)) {
      messageBytes = parsed.message as number[];
    } else {
      return fail('message is neither string nor array');
    }

    // The crate also reports failure by putting the error INSIDE the message
    // bytes of an otherwise successful-looking result. Mobile's native parser
    // catches that; the WASM one does not, so the error text travelled onward as
    // if it were plaintext and surfaced far away as
    // `SyntaxError: Unexpected token 'D'` when the app JSON.parsed it.
    if (messageBytes.length > 0) {
      const asText = new TextDecoder().decode(new Uint8Array(messageBytes));
      if (
        asText.startsWith('Decryption failed:') ||
        asText.startsWith('invalid') ||
        asText.includes('aead::Error')
      ) {
        return fail(`Double ratchet decryption error: ${asText}`);
      }
    }

    return { ratchet_state: parsed.ratchet_state, message: messageBytes };
  }

  /** Mirrors native-provider sealInboxEnvelope. */
  async sealInboxEnvelope(
    recipientPubKeyBase64: string,
    message: string
  ): Promise<{ inbox_public_key: string; ephemeral_public_key: string; envelope: unknown }> {
    const ephemeral = await this.generateX448();
    const recipientPubKey = Array.from(Buffer.from(recipientPubKeyBase64, 'base64'));
    const envelope = await this.encryptInboxMessage({
      inbox_public_key: recipientPubKey,
      ephemeral_private_key: ephemeral.private_key,
      plaintext: Array.from(new TextEncoder().encode(message)),
    } as never);
    return {
      inbox_public_key: Buffer.from(recipientPubKeyBase64, 'base64').toString('hex'),
      ephemeral_public_key: Buffer.from(new Uint8Array(ephemeral.public_key)).toString('hex'),
      envelope,
    };
  }

  /** Mirrors native-provider unsealInboxEnvelope. */
  async unsealInboxEnvelope(
    recipientPrivKey: number[],
    envelope: { ephemeral_public_key: string; envelope: string }
  ): Promise<string> {
    const ephemeralPublicKey = Array.from(Buffer.from(envelope.ephemeral_public_key, 'hex'));
    const ciphertext = JSON.parse(envelope.envelope) as Record<string, unknown>;
    const decrypted = await this.decryptInboxMessage({
      inbox_private_key: recipientPrivKey,
      ephemeral_public_key: ephemeralPublicKey,
      ciphertext,
    } as never);
    return new TextDecoder().decode(new Uint8Array(decrypted as number[]));
  }

  // ---- native-only surface: fail loudly rather than silently degrade ----
  //
  // These are direct QuorumCrypto.* uniffi calls in the real provider. The batch
  // pair especially matters: batchProcessMessages is mobile's DM receive fast
  // path AND a live suspect in the delivery investigation (it has a documented
  // `truncated: true` partial-failure mode). Quietly falling back to per-message
  // decrypt here would let a scenario "pass" while never touching the code under
  // suspicion — the exact failure mode round 28 of that investigation hit.
  async batchProcessMessages(): Promise<never> {
    return nativeOnly('batchProcessMessages');
  }

  async batchUnsealEnvelopes(): Promise<never> {
    return nativeOnly('batchUnsealEnvelopes');
  }

  // Hub and sync envelopes belong to the SPACE paths. Everything here except
  // unsealHubEnvelope stays unimplemented: reproducing a method no scenario
  // exercises is speculative code that drifts silently, and throwing names
  // exactly what to add when a space scenario needs it.
  async sealHubEnvelope(): Promise<never> {
    return nativeOnly('sealHubEnvelope (space path — no scenario seals one yet)');
  }

  /**
   * native-provider.ts unsealHubEnvelope (~:882-920), transcribed.
   *
   * Implemented because the space RECEIVE path calls it unconditionally
   * (WebSocketContext handleIncomingMessage), so a scenario that delivers a
   * space frame cannot reach any space handler without it. It is the vehicle,
   * not the thing under test — a scenario asserting on space authorization is
   * asserting on code above this line.
   *
   * Both branches are reproduced even though scenarios currently only use the
   * config-key one: matching the real method exactly is what keeps the
   * transcription checkable against its original.
   *
   * ⚠️ DRIFT RISK, same as every method in this block: if native-provider's
   * version changes, change this to match.
   */
  async unsealHubEnvelope(
    hubPrivateKey: number[],
    ephemeralPublicKeyHex: string,
    encryptedEnvelope: string,
    configPrivateKey?: number[]
  ): Promise<string> {
    // The config key is used DIRECTLY as the X448 private key; the hub-derived
    // form is the legacy fallback for spaces predating config keys.
    const x448PrivateKey = configPrivateKey
      ? configPrivateKey
      : Array.from(nobleSha512(new Uint8Array(hubPrivateKey)).slice(0, 56));

    const decrypted = (await this.decryptInboxMessage({
      inbox_private_key: x448PrivateKey,
      ephemeral_public_key: Array.from(Buffer.from(ephemeralPublicKeyHex, 'hex')),
      ciphertext: JSON.parse(encryptedEnvelope) as Record<string, unknown>,
    } as never)) as number[];

    return new TextDecoder().decode(new Uint8Array(decrypted));
  }
  async sealSyncEnvelope(): Promise<never> {
    return nativeOnly('sealSyncEnvelope (space path — out of DM scope)');
  }
  async unsealSyncEnvelope(): Promise<never> {
    return nativeOnly('unsealSyncEnvelope (space path — out of DM scope)');
  }
  async tripleRatchetResizeForInvites(): Promise<never> {
    return nativeOnly('tripleRatchetResizeForInvites (space path — out of DM scope)');
  }
}

export default NativeCryptoProvider;
