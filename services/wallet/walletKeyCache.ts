/**
 * On-demand access to the built-in wallet's derived private keys.
 *
 * ## Why this is not a React Query query
 *
 * React Query is the wrong home for key material:
 *
 * - The query cache is persisted to disk by `services/offline/queryPersister.ts`.
 *   Anything that lands in it is eligible to be written out.
 * - Any mounted observer keeps a query alive indefinitely, whatever its `gcTime`.
 * - Every cache inspector (devtools, a debug dump of the cache) shows it.
 *
 * So the keys live here, in one module-scoped slot that nothing serialises, and
 * `services/offline/shouldPersistQuery.ts` refuses wallet-key query keys outright.
 *
 * ## Lifetime
 *
 * Deriving costs a SecureStore read plus a PBKDF2 and several curve derivations,
 * which is seconds on Hermes. A mini-app can ask for several signatures in a row,
 * so the result is reused for {@link WALLET_KEYS_TTL_MS}, then dropped.
 *
 * The slot is tied to the identity it was derived for: it is only returned while
 * the identity public key still matches. That key is memory-cached in
 * secureStorage, so the check is free and needs no secret read. After a Reset App
 * Data and re-onboard as someone else, a stale entry cannot be returned even in
 * the TTL window. `clearWalletKeysCache()` drops it outright, and sign-out calls it.
 */
import { getMnemonic, getPrivateKey, getPublicKey } from '@/services/onboarding/secureStorage';
// Type-only: the derivation code (and the curve and HD-wallet libraries behind it)
// is loaded on first use, below. AuthContext imports this module to clear it on
// sign-out, and a static import would put all of that in the startup graph.
import type { ChainKeys } from '@/services/wallet/multiChainWallet';

/** How long derived keys are reused before being dropped from memory. */
export const WALLET_KEYS_TTL_MS = 5 * 60 * 1000;

interface CachedWalletKeys {
  keys: ChainKeys;
  /** The identity public key the keys were derived under. */
  identity: string;
  derivedAt: number;
}

let cached: CachedWalletKeys | null = null;
let inflight: { identity: string | null; promise: Promise<ChainKeys | null> } | null = null;

/** Drop any derived keys held in memory. */
export function clearWalletKeysCache(): void {
  cached = null;
  inflight = null;
}

async function deriveWalletKeys(): Promise<ChainKeys | null> {
  const { deriveMultiChainKeysAsync, deriveMultiChainKeysFromPrivateKeyAsync } = await import(
    '@/services/wallet/multiChainWallet'
  );

  // First try mnemonic (preferred)
  const mnemonic = await getMnemonic();
  if (mnemonic && mnemonic.length >= 12) {
    return deriveMultiChainKeysAsync(mnemonic);
  }

  // Fall back to hex private key derivation (for non-mnemonic accounts)
  const privateKey = await getPrivateKey();
  if (privateKey && privateKey.length > 0) {
    return deriveMultiChainKeysFromPrivateKeyAsync(privateKey);
  }

  return null;
}

/**
 * The built-in wallet's keys for every chain, or null when this device has no
 * identity. Use only at the moment of signing, and do not store the result.
 */
export async function getWalletKeys(): Promise<ChainKeys | null> {
  const identity = await getPublicKey();

  if (
    cached &&
    identity !== null &&
    cached.identity === identity &&
    Date.now() - cached.derivedAt < WALLET_KEYS_TTL_MS
  ) {
    return cached.keys;
  }
  cached = null;

  // Concurrent callers for the same identity share one derivation.
  if (inflight && inflight.identity === identity) return inflight.promise;

  const promise = deriveWalletKeys();
  const entry = { identity, promise };
  inflight = entry;
  try {
    const keys = await promise;
    // Only keep the result if nothing cleared or superseded this derivation
    // while it ran, and only when it belongs to a known identity.
    if (inflight === entry && keys && identity !== null) {
      cached = { keys, identity, derivedAt: Date.now() };
    }
    return keys;
  } finally {
    if (inflight === entry) inflight = null;
  }
}
