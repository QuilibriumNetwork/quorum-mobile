// Identity for a headless bot, driven through mobile's REAL onboarding code.
//
// Nothing here reimplements key derivation or registration: keyPairFromHex,
// deriveAddress, initializeEncryptionKeys and uploadUserRegistration are
// mobile's own, unchanged. This file only supplies what a device would have
// supplied — a seeded SecureStore — and persists the result so re-runs reuse it.
//
// ─── Why persistence is not optional ────────────────────────────────────────
//
// initializeEncryptionKeys returns the existing device keyset when ALL FIVE
// SecureStore items are present, and regenerates the whole thing when any one is
// missing. uploadUserRegistration then MERGES the new device into the account's
// registration and never removes the old entry.
//
// So a harness that did not persist would mint and register a brand-new device
// on every run, permanently. That is the ghost-device accumulation problem the
// investigation already documents (deviceCount: 11 seen), and it makes every
// send fan out wider — the canonical desktop run measured ~9 frames per message
// on real accounts. A bench that inflates the very quantity it is measuring is
// worse than no bench.
//
// ⚠️ Account private keys: an ENV-SUPPLIED key is never written to .state/ — it is
// re-read from env each run, so .state/ can be deleted at any time without losing
// account access, and cannot leak a real account. A GENERATED throwaway key IS
// persisted, because .state/ is its only home; losing it orphans the account.
//
// So `privateKeyHex` present in a state file means that bot is a throwaway, by
// construction (see writeState below: `...(fromEnv ? {} : { privateKeyHex })`).
// That is the reliable way to tell which bots sit on your real test accounts —
// the ones WITHOUT it. .state/ is gitignored either way (.gitignore:47).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  deriveAddress,
  initializeEncryptionKeys,
  keyPairFromHex,
  uploadUserRegistration,
  type DeviceEncryptionKeyset,
} from '@/services/onboarding/keyService';
import {
  storeIdentityX448,
  storeInboxAddress,
  storeInboxEncryptionKey,
  storeInboxSigningKey,
  storePreKey,
  storePrivateKey,
  storePublicKey,
} from '@/services/onboarding/secureStorage';
import { NativeCryptoProvider } from './wasm-provider-shim';

const STATE_DIR = resolve(__dirname, '.state');

export interface HarnessIdentity {
  name: string;
  /** Account address, derived by mobile's own deriveAddress. */
  address: string;
  publicKeyHex: string;
  privateKeyHex: string;
  keyset: DeviceEncryptionKeyset;
  /** This device's inbox — where frames addressed to this bot arrive. */
  inboxAddress: string;
}

interface PersistedState {
  /** Present ONLY for generated throwaways. Never written for env-supplied keys. */
  privateKeyHex?: string;
  keyset: DeviceEncryptionKeyset;
}

const statePath = (name: string) => resolve(STATE_DIR, `${name}.json`);

function readState(name: string): PersistedState | null {
  const p = statePath(name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as PersistedState;
  } catch {
    // A corrupt state file must not silently mint a new device — that is the
    // exact path to a ghost. Surface it instead.
    throw new Error(
      `[harness] ${p} is unreadable. Delete it deliberately if you accept ` +
        `registering a NEW device for "${name}", or restore it.`
    );
  }
}

function writeState(name: string, state: PersistedState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(statePath(name), JSON.stringify(state, null, 2), 'utf8');
}

/** Seed every SecureStore item a device would hold, so mobile does not regenerate. */
async function seedSecureStore(
  privateKeyHex: string,
  publicKeyHex: string,
  keyset: DeviceEncryptionKeyset
): Promise<void> {
  const j = (v: number[]) => JSON.stringify(v);
  await storePrivateKey(privateKeyHex);
  await storePublicKey(publicKeyHex);
  await storeIdentityX448(j(keyset.identityKey.privateKey), j(keyset.identityKey.publicKey));
  await storePreKey(j(keyset.preKey.privateKey), j(keyset.preKey.publicKey));
  await storeInboxEncryptionKey(
    j(keyset.inboxEncryptionKey.privateKey),
    j(keyset.inboxEncryptionKey.publicKey)
  );
  await storeInboxSigningKey(
    j(keyset.inboxSigningKey.privateKey),
    j(keyset.inboxSigningKey.publicKey)
  );
  await storeInboxAddress(keyset.inboxAddress);
}

/**
 * Load a bot's identity, or create and register one.
 *
 * @param name       state file name — stable across runs, so the device is reused
 * @param privateKeyHex  an existing account key (env). Omit to mint a throwaway.
 */
export async function loadOrCreateIdentity(
  name: string,
  opts: { privateKeyHex?: string } = {}
): Promise<HarnessIdentity> {
  const persisted = readState(name);
  const fromEnv = Boolean(opts.privateKeyHex);

  // Account key: env wins, then persisted throwaway, then mint a new one.
  let privateKeyHex = opts.privateKeyHex ?? persisted?.privateKeyHex;
  if (!privateKeyHex) {
    const ed = await new NativeCryptoProvider().generateEd448();
    privateKeyHex = Buffer.from(new Uint8Array(ed.private_key)).toString('hex');
  }

  // Mobile's own derivation — not reimplemented here.
  const pair = keyPairFromHex(privateKeyHex);
  const publicKeyHex =
    typeof pair.publicKey === 'string'
      ? pair.publicKey
      : Buffer.from(pair.publicKey as unknown as Uint8Array).toString('hex');
  const address = deriveAddress(pair.publicKey as never);

  // Seed BEFORE initializeEncryptionKeys: with all five items present it returns
  // the existing keyset, and only generates when something is missing.
  if (persisted?.keyset) {
    await seedSecureStore(privateKeyHex, publicKeyHex, persisted.keyset);
  } else {
    await storePrivateKey(privateKeyHex);
    await storePublicKey(publicKeyHex);
  }

  const keyset = await initializeEncryptionKeys(publicKeyHex);

  // Persist the DEVICE keyset always; the account key only when we minted it.
  writeState(name, {
    ...(fromEnv ? {} : { privateKeyHex }),
    keyset,
  });

  // Registration merges this device into the account, exactly as onboarding does.
  await uploadUserRegistration(address, publicKeyHex, privateKeyHex, keyset);

  return {
    name,
    address,
    publicKeyHex,
    privateKeyHex,
    keyset,
    inboxAddress: keyset.inboxAddress,
  };
}
