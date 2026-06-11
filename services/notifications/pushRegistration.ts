/**
 * pushRegistration — binds the device's Expo push token to every inbox
 * the user holds (device inbox + every space inbox) so the server can
 * wake the device when a message lands. Optionally includes the
 * Farcaster FID so the server-side haatz poller can route Farcaster
 * notifications to the same token.
 *
 * The server signature path matches:
 *   "push-register" || token || platform || be64(fid|0) || be64(ts)
 * The fid is a uint64; 0 means "no Farcaster account".
 */

import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { createMMKV } from 'react-native-mmkv';
import { getQuorumClient } from '@/services/api/quorumClient';
import { NativeCryptoProvider } from '@/services/crypto/native-provider';
import { getDeviceKeyset, getFarcasterFid } from '@/services/onboarding/secureStorage';
import {
  getAllSpaces,
  getSpaceKey,
} from '@/services/config/spaceStorage';
import { encryptionStateStorage } from '@/services/crypto/encryption-state-storage';
import { writeNotificationCatalog } from './sharedKeystore';

const pushRegStorage = createMMKV({ id: 'quorum-push-registration' });
const LAST_TOKEN_KEY = 'last-expo-token';
const LAST_REGISTERED_AT_KEY = 'last-registered-at';
const LAST_FID_KEY = 'last-fid';
const REREGISTER_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7d refresh floor

// Per-inbox bookkeeping. We hash (token, fid, inboxAddress) to a key and
// store the ms timestamp of the last successful POST. Any later call
// skips inboxes whose record is still within the refresh window — which
// means a steady-state app start does ZERO POSTs (vs. one per inbox).
function inboxRegKey(token: string, fid: number, inboxAddress: string): string {
  return `inbox-reg:${fid}:${inboxAddress}:${token.slice(-12)}`;
}

function bytesToHex(bytes: Uint8Array | number[]): string {
  const arr = bytes instanceof Uint8Array ? Array.from(bytes) : bytes;
  return arr.map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// Exported for pushPrefsSync, which signs over the same byte layout.
export function be64(n: bigint | number): Uint8Array {
  const out = new Uint8Array(8);
  let v = typeof n === 'bigint' ? n : BigInt(n);
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface InboxKeyMaterial {
  inboxAddress: string;
  publicKeyHex: string;
  privateKeyBytes: Uint8Array;
}

/**
 * Enumerate every inbox keyset the user holds: device inbox first
 * (the "primary" inbox), then space inboxes, then per-conversation
 * inboxes. Exported so pushPrefsSync can pick the same primary inbox
 * registration uses to sign its requests.
 */
export async function gatherInboxKeys(): Promise<InboxKeyMaterial[]> {
  const out: InboxKeyMaterial[] = [];

  const device = await getDeviceKeyset();
  if (device?.inboxAddress) {
    out.push({
      inboxAddress: device.inboxAddress,
      publicKeyHex: bytesToHex(device.inboxSigningPublicKey),
      privateKeyBytes: new Uint8Array(device.inboxSigningPrivateKey),
    });
  }

  for (const space of getAllSpaces()) {
    const inboxKey = getSpaceKey(space.spaceId, 'inbox');
    if (!inboxKey?.address || !inboxKey.publicKey || !inboxKey.privateKey) continue;
    out.push({
      inboxAddress: inboxKey.address,
      publicKeyHex: inboxKey.publicKey,
      privateKeyBytes: hexToBytes(inboxKey.privateKey),
    });
  }

  // Conversation-level inboxes (per-DM-pair keypairs created when we
  // initiate a conversation). Earlier this called
  // `getConversationInboxKeypairByAddress` for every address, which is
  // O(N) per call (it scans all keys), making the loop O(N²) — disastrous
  // for users with many DMs. We now materialize them in a single sweep.
  for (const kp of encryptionStateStorage.getAllConversationInboxKeypairs()) {
    if (!kp?.inboxAddress || !kp.signingPublicKey || !kp.signingPrivateKey) continue;
    out.push({
      inboxAddress: kp.inboxAddress,
      publicKeyHex: bytesToHex(kp.signingPublicKey),
      privateKeyBytes: new Uint8Array(kp.signingPrivateKey),
    });
  }

  return out;
}

export async function getExpoPushToken(): Promise<string | null> {
  try {
    const projectId =
      (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas
        ?.projectId ??
      (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId;
    if (!projectId) return null;
    const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
    return data || null;
  } catch {
    return null;
  }
}

/**
 * Ed448-sign an already-assembled message with an inbox private key,
 * returning the signature hex the server expects. Shared by the
 * register/unregister paths here and by pushPrefsSync.
 */
export async function signEd448Hex(priv: Uint8Array, msg: Uint8Array): Promise<string> {
  const provider = new NativeCryptoProvider();
  const sigB64 = await provider.signEd448(bytesToBase64(priv), bytesToBase64(msg));
  return bytesToHex(base64ToBytes(sigB64));
}

async function signRegister(
  priv: Uint8Array,
  expoToken: string,
  platform: 'ios' | 'android',
  fid: number,
  timestampMs: number,
): Promise<string> {
  const tokenBytes = new TextEncoder().encode(expoToken);
  const platformBytes = new TextEncoder().encode(platform);
  const fidBytes = be64(BigInt(fid));
  const tsBytes = be64(BigInt(timestampMs));
  const domain = new TextEncoder().encode('push-register');
  const msg = concatBytes(domain, tokenBytes, platformBytes, fidBytes, tsBytes);
  return signEd448Hex(priv, msg);
}

async function signUnregister(
  priv: Uint8Array,
  expoToken: string,
  timestampMs: number,
): Promise<string> {
  const tokenBytes = new TextEncoder().encode(expoToken);
  const tsBytes = be64(BigInt(timestampMs));
  const domain = new TextEncoder().encode('push-unregister');
  const msg = concatBytes(domain, tokenBytes, tsBytes);
  return signEd448Hex(priv, msg);
}

// Single-flight guard. Concurrent callers (auth effect, rotation
// listener, manual force) collapse to one in-flight registration so we
// never have two parallel waves of POSTs.
let inFlight: Promise<void> | null = null;

/**
 * Register the device's current Expo push token across every inbox the
 * user holds. Idempotent; safe to call on every auth or token rotation.
 *
 * Skips the network call entirely when the token + last-registered
 * window haven't changed, so this is cheap to invoke from app start.
 *
 * If a token is supplied via `tokenOverride`, we use it directly without
 * calling `getExpoPushTokenAsync`. This breaks the feedback loop where
 * fetching the token can re-fire `addPushTokenListener`, which would
 * otherwise spam this function.
 */
export async function registerPushTokenWithQuorum(opts?: {
  /** Force re-registration even if the token hasn't rotated. */
  force?: boolean;
  /** Token from the rotation listener — skip the re-fetch. */
  tokenOverride?: string;
}): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      await registerPushTokenInternal(opts);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

async function registerPushTokenInternal(opts?: {
  force?: boolean;
  tokenOverride?: string;
}): Promise<void> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;

  const granted = (await Notifications.getPermissionsAsync()).status === 'granted';
  if (!granted) return;

  // Prefer the token handed in by the rotation listener — calling
  // `getExpoPushTokenAsync` itself can fire that listener again on iOS,
  // creating a feedback loop. Only fetch when no token is supplied.
  const expoToken = opts?.tokenOverride ?? (await getExpoPushToken());
  if (!expoToken) return;

  const fid = (await getFarcasterFid()) ?? 0;
  const platform = Platform.OS as 'ios' | 'android';
  const lastToken = pushRegStorage.getString(LAST_TOKEN_KEY);
  const lastFid = pushRegStorage.getNumber(LAST_FID_KEY) ?? 0;
  const lastAt = pushRegStorage.getNumber(LAST_REGISTERED_AT_KEY) ?? 0;

  // Token rotated, FID changed, or the device was wiped → drop ALL
  // per-inbox marks so we re-register them under the new identity. Other
  // bumps just rely on the per-inbox check below to dedupe.
  const identityChanged = lastToken !== expoToken || lastFid !== fid;
  if (identityChanged) {
    for (const key of pushRegStorage.getAllKeys()) {
      if (key.startsWith('inbox-reg:')) pushRegStorage.remove(key);
    }
  }

  const inboxes = await gatherInboxKeys();
  if (inboxes.length === 0) return;

  // Steady-state fast path: if the global window says we re-registered
  // recently AND nothing about the device identity changed AND every
  // inbox already has a recent mark, this is a no-op. The per-inbox
  // mark survives across app launches via MMKV.
  const now = Date.now();
  const stale = (key: string) =>
    !pushRegStorage.contains(key) ||
    now - (pushRegStorage.getNumber(key) ?? 0) > REREGISTER_INTERVAL_MS;
  const inboxesToRegister = opts?.force
    ? inboxes
    : inboxes.filter((k) => stale(inboxRegKey(expoToken, fid, k.inboxAddress)));

  if (inboxesToRegister.length === 0) {
    // Nothing changed — record the call so future invocations within
    // the global window can also short-circuit at the top.
    pushRegStorage.set(LAST_TOKEN_KEY, expoToken);
    pushRegStorage.set(LAST_FID_KEY, fid);
    pushRegStorage.set(LAST_REGISTERED_AT_KEY, now);
    // A previous prefs sync may have failed (network); registration is
    // invoked on every startup, so this is the retry surface. Dynamic
    // import avoids the pushPrefsSync → pushRegistration cycle.
    const { retryPushPrefsSyncIfDirty } = await import('./pushPrefsSync');
    retryPushPrefsSyncIfDirty();
    return;
  }

  // Skip the call entirely if recently registered AND there's nothing new.
  if (
    !opts?.force &&
    !identityChanged &&
    now - lastAt < REREGISTER_INTERVAL_MS &&
    inboxesToRegister.length === inboxes.length
  ) {
    // First-ever registration falls through; partial-state catches up below.
  }

  const client = getQuorumClient();
  const ts = now;

  // Sign + POST in parallel for the inboxes that actually need it.
  // Errors on individual inboxes are swallowed; the next call retries
  // because we only stamp the per-inbox mark on success.
  const results = await Promise.allSettled(
    inboxesToRegister.map(async (k) => {
      const sigHex = await signRegister(k.privateKeyBytes, expoToken, platform, fid, ts);
      await client.registerPushToken({
        inbox_address: k.inboxAddress,
        inbox_public_key: k.publicKeyHex,
        expo_token: expoToken,
        platform,
        farcaster_fid: fid > 0 ? fid : undefined,
        timestamp: ts,
        inbox_signature: sigHex,
      });
      return k.inboxAddress;
    }),
  );
  for (const r of results) {
    if (r.status === 'fulfilled') {
      pushRegStorage.set(inboxRegKey(expoToken, fid, r.value), now);
    }
  }

  pushRegStorage.set(LAST_TOKEN_KEY, expoToken);
  pushRegStorage.set(LAST_FID_KEY, fid);
  pushRegStorage.set(LAST_REGISTERED_AT_KEY, now);

  // Refresh the App Group catalog so the iOS NSE can rewrite incoming
  // push titles. Cheap and idempotent (no-op when the catalog content
  // hasn't changed). Awaited so any async errors surface in the same
  // logging surface as registration errors.
  await writeNotificationCatalog();

  // A fresh token binding must immediately carry the user's notification
  // prefs, otherwise the server pushes unfiltered until the next pref
  // toggle. Dynamic import avoids the pushPrefsSync → pushRegistration
  // cycle; errors are swallowed inside the sync (it marks itself dirty
  // and retries on the next registration / foreground).
  const { syncPushPrefsWithQuorum } = await import('./pushPrefsSync');
  await syncPushPrefsWithQuorum();
}

/**
 * Tear down all bindings for this device's current Expo token. Called on
 * sign-out so a new owner of the device doesn't keep receiving pushes
 * for the previous account.
 */
export async function unregisterPushTokenFromQuorum(): Promise<void> {
  const expoToken =
    pushRegStorage.getString(LAST_TOKEN_KEY) ?? (await getExpoPushToken()) ?? null;
  if (!expoToken) return;

  const inboxes = await gatherInboxKeys();
  const client = getQuorumClient();
  const ts = Date.now();

  await Promise.allSettled(
    inboxes.map(async (k) => {
      const sigHex = await signUnregister(k.privateKeyBytes, expoToken, ts);
      await client.unregisterPushToken({
        inbox_address: k.inboxAddress,
        inbox_public_key: k.publicKeyHex,
        expo_token: expoToken,
        timestamp: ts,
        inbox_signature: sigHex,
      });
    }),
  );

  pushRegStorage.remove(LAST_TOKEN_KEY);
  pushRegStorage.remove(LAST_REGISTERED_AT_KEY);
  pushRegStorage.remove(LAST_FID_KEY);
  for (const key of pushRegStorage.getAllKeys()) {
    if (key.startsWith('inbox-reg:')) pushRegStorage.remove(key);
  }
}

/**
 * Subscribe to Expo's push-token rotation events. Calls into the
 * registration path *with the new token already supplied* so we don't
 * re-fetch via getExpoPushTokenAsync (which on iOS can re-fire this
 * very listener and create a feedback loop). A trailing debounce
 * collapses bursts of events into a single registration pass.
 */
export function startPushTokenRotationListener(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: string | null = null;
  const sub = Notifications.addPushTokenListener((evt) => {
    // expo-notifications can hand back either an Expo or device token
    // shape; both expose `data` as the string token.
    const token = (evt as { data?: string } | undefined)?.data;
    if (!token) return;
    pending = token;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const t = pending;
      pending = null;
      timer = null;
      if (t) {
        // No `force` — the per-inbox dedup correctly registers a new
        // token everywhere via the identity-change path, and a
        // duplicate-event with the same token short-circuits.
        registerPushTokenWithQuorum({ tokenOverride: t }).catch(() => {});
      }
    }, 1000);
  });
  return () => {
    if (timer) clearTimeout(timer);
    sub.remove();
  };
}
