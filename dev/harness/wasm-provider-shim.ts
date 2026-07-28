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

/**
 * Initialise the crate's WASM binding exactly once per process.
 *
 * `channel_raw` and the high-level `channel` API are one bundle sharing a single
 * `wasm` var, so this initialises both. Calling initSync twice throws, hence the
 * guard — scenarios construct providers freely and must not have to coordinate.
 */
export function initHarnessCrypto(): ChannelWasmModule {
  if (!initialised) {
    channel_raw.initSync(readFileSync(WASM_PATH));
    initialised = true;
  }
  return channel_raw as unknown as ChannelWasmModule;
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
}

export default NativeCryptoProvider;
