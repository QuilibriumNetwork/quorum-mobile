// Replacement for mobile's `services/crypto` barrel.
//
// The barrel re-exports the two providers from their own modules. Those modules
// are individually mapped to the WASM shims, but an import of the BARREL bypasses
// both patterns and reaches the real files — which load the uniffi native module
// and cannot exist in Node. AuthContext imports this way.
//
// Re-exporting the shims here closes that hole. Keep this in sync with
// services/crypto/index.ts: if the barrel grows an export, add it here or an
// importer gets `undefined` with no explanation.
export { NativeCryptoProvider } from './wasm-provider-shim';
export { NativeSigningProvider } from './wasm-signing-shim';
