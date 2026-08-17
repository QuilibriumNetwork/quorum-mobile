// modules/quorum-crypto replacement for Node, backed by the channel WASM crate.
//
// Mobile's real module is a Nitro/uniffi binding to libchannel.so — ARM machine
// code that Node cannot load. Only `verifyEd448` is reproduced, because that is
// the only export the harness currently reaches: `verifyConfigSignature` in
// services/config/configService.ts uses it through a lazy
// `await import('../../modules/quorum-crypto/src')`.
//
// ⚠️ WHY THIS SHIM IS LOAD-BEARING, AND WHY ITS ABSENCE WAS INVISIBLE.
//
// `verifyConfigSignature` wraps that call in a try/catch that returns `false`.
// Without this mapping, the import fails, verification "returns false", and
// `getConfig` quietly abandons the remote blob and returns the LOCAL config
// instead. Every symptom of that is indistinguishable from "config sync does not
// work": the scenario runs green through every line, the remote is never
// adopted, and the natural conclusion is that the server or the protocol is at
// fault rather than the test rig.
//
// So a config-sync scenario without this shim does not measure config sync. It
// measures its own missing mapping, and reports it as a product bug.
//
// The contract is copied exactly from the real module (modules/quorum-crypto/src/index.ts):
// the crate returns the STRING 'true'/'false', and the wrapper compares against
// 'true' to produce a boolean. Returning a bare boolean from the crate call, or
// forgetting the comparison, would make every signature verify as false — the
// same silent failure this shim exists to remove.
import { initHarnessCrypto } from './wasm-provider-shim';

export async function verifyEd448(
  publicKey: string,
  message: string,
  signature: string
): Promise<boolean> {
  const wasm = initHarnessCrypto() as unknown as {
    js_verify_ed448(publicKey: string, message: string, signature: string): string;
  };
  return wasm.js_verify_ed448(publicKey, message, signature) === 'true';
}
