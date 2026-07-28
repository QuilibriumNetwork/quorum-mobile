// Drop-in for services/crypto/native-signing-provider's NativeSigningProvider.
//
// Same reasoning as the crypto shim: the real one calls QuorumCrypto.signEd448
// through uniffi, which cannot load in Node. This implements the identical
// SigningProvider contract against the crate's WASM binding instead.
//
// Kept separate from wasm-provider-shim because the modules are separate in the
// app, and the harness alias matches module paths — collapsing them would make
// `native-provider` and `native-signing-provider` resolve to one file and
// quietly change what each import site receives.
import { initHarnessCrypto } from './wasm-provider-shim';

/** Same base64-in / base64-out contract as SigningProvider in quorum-shared. */
export class NativeSigningProvider {
  async signEd448(privateKey: string, message: string): Promise<string> {
    const wasm = initHarnessCrypto() as unknown as {
      js_sign_ed448(k: string, m: string): string;
    };
    const result = wasm.js_sign_ed448(privateKey, message);
    // The crate returns a JSON-quoted string on success and a bare error string
    // on failure. Parse rather than trust, so a failure surfaces here instead of
    // travelling onward as a "signature" that no peer can verify.
    try {
      return JSON.parse(result) as string;
    } catch {
      throw new Error(`[harness] signEd448 failed: ${result}`);
    }
  }

  async verifyEd448(publicKey: string, message: string, signature: string): Promise<boolean> {
    const wasm = initHarnessCrypto() as unknown as {
      js_verify_ed448(p: string, m: string, s: string): string;
    };
    return wasm.js_verify_ed448(publicKey, message, signature) === 'true';
  }
}

export default NativeSigningProvider;
