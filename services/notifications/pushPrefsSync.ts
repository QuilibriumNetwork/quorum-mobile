/**
 * pushPrefsSync — mirrors the user's notification preferences to
 * quorum-api so it can filter pushes SERVER-side.
 *
 * Why server-side: the server sends ALERT-type pushes (OS-rendered
 * title/body), so by the time the device sees one, the lock-screen
 * banner is already up — device-local pref checks (notificationPrefs +
 * pushReceivedTask) can only gate the JS-side local notifications, not
 * the OS-rendered ones. POST /push/prefs stores per-token prefs and
 * the server drops pushes for muted hubs / disabled tokens entirely.
 *
 * What syncs: the global enabled toggle and the per-space mutes
 * (mapped to hub addresses, which is the routing key the server has).
 * Per-CHANNEL mutes deliberately do NOT sync — the server can't see
 * channel ids inside encrypted envelopes, so those stay device-side.
 *
 * Signature contract (must match the server byte-for-byte):
 *   "push-prefs" || expo_token || (0x01 if enabled else 0x00)
 *     || mutedHubsSorted.join(',') || be64(timestamp)
 * with muted_hubs sorted ascending (plain string sort) before joining.
 * Signed with the user's primary inbox Ed448 key — the first inbox
 * pushRegistration enumerates (device inbox), which the server already
 * knows from /push/register.
 *
 * Resilience: calls are debounced 2s so rapid toggling sends once.
 * Failures are swallowed (warn log) but flagged dirty in MMKV; the
 * flag is retried on the next registerPushTokenWithQuorum run (every
 * startup) and on app foreground (app/_layout.tsx).
 */

import { createMMKV } from 'react-native-mmkv';
import { getQuorumClient } from '@/services/api/quorumClient';
import { getSpaceKey } from '@/services/config/spaceStorage';
import {
  getGlobalNotificationsEnabled,
  getMutedSpaceIds,
} from './notificationPrefs';
import {
  be64,
  concatBytes,
  gatherInboxKeys,
  getExpoPushToken,
  signEd448Hex,
} from './pushRegistration';

// Same store pushRegistration uses for its bookkeeping — the dirty
// flag is registration-adjacent state (it's retried from that path).
const prefsSyncStorage = createMMKV({ id: 'quorum-push-registration' });
const DIRTY_KEY = 'pushPrefs.dirty';
const DEBOUNCE_MS = 2000;

async function signPushPrefs(
  priv: Uint8Array,
  expoToken: string,
  enabled: boolean,
  mutedHubsSorted: string[],
  timestampMs: number,
): Promise<string> {
  const domain = new TextEncoder().encode('push-prefs');
  const tokenBytes = new TextEncoder().encode(expoToken);
  const enabledByte = new Uint8Array([enabled ? 0x01 : 0x00]);
  const hubsBytes = new TextEncoder().encode(mutedHubsSorted.join(','));
  const tsBytes = be64(BigInt(timestampMs));
  const msg = concatBytes(domain, tokenBytes, enabledByte, hubsBytes, tsBytes);
  return signEd448Hex(priv, msg);
}

/**
 * Muted spaceIds → hub addresses, sorted ascending. The server routes
 * hub-log pushes by hub address, so that's the identifier it filters
 * on. Spaces whose hub key hasn't been stored yet are skipped (they
 * can't receive hub pushes anyway).
 */
function getMutedHubAddresses(): string[] {
  const out: string[] = [];
  for (const spaceId of getMutedSpaceIds()) {
    const address = getSpaceKey(spaceId, 'hub')?.address;
    if (address) out.push(address);
  }
  return out.sort();
}

async function sendPrefsNow(): Promise<void> {
  try {
    const expoToken = await getExpoPushToken();
    if (!expoToken) {
      // No token yet (permissions not granted / project id missing).
      // Nothing registered server-side either, so retry after the next
      // registration instead of failing loudly.
      prefsSyncStorage.set(DIRTY_KEY, true);
      return;
    }

    // Primary inbox = first enumerated keyset (device inbox), same
    // selection order registration signs with.
    const signer = (await gatherInboxKeys())[0];
    if (!signer) {
      prefsSyncStorage.set(DIRTY_KEY, true);
      return;
    }

    const enabled = getGlobalNotificationsEnabled();
    const mutedHubs = getMutedHubAddresses();
    const ts = Date.now();
    const sigHex = await signPushPrefs(
      signer.privateKeyBytes,
      expoToken,
      enabled,
      mutedHubs,
      ts,
    );

    await getQuorumClient().postPushPrefs({
      expo_token: expoToken,
      inbox_address: signer.inboxAddress,
      inbox_public_key: signer.publicKeyHex,
      inbox_signature: sigHex,
      timestamp: ts,
      enabled,
      muted_hubs: mutedHubs,
    });

    prefsSyncStorage.set(DIRTY_KEY, false);
  } catch (e) {
    // Network/signing failure — the local prefs already took effect on
    // the device-side gates; mark dirty so registration/foreground
    // retries the server-side mirror.
    console.warn('[pushPrefsSync] failed to sync push prefs, will retry', e);
    prefsSyncStorage.set(DIRTY_KEY, true);
  }
}

// Trailing 2s debounce: rapid toggling (user flipping several space
// mutes in settings) coalesces into one POST carrying the final state.
// All callers within the window share one promise that resolves after
// the coalesced send completes.
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPromise: Promise<void> | null = null;
let pendingResolve: (() => void) | null = null;

/**
 * Sync the current notification prefs (global enabled + muted hubs) to
 * the server. Debounced; never rejects — failures persist a dirty flag
 * that retryPushPrefsSyncIfDirty picks up later.
 */
export function syncPushPrefsWithQuorum(): Promise<void> {
  if (!pendingPromise) {
    pendingPromise = new Promise<void>((resolve) => {
      pendingResolve = resolve;
    });
  }
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    const resolve = pendingResolve;
    pendingPromise = null;
    pendingResolve = null;
    void sendPrefsNow().finally(() => resolve?.());
  }, DEBOUNCE_MS);
  return pendingPromise;
}

/**
 * Retry a previously failed sync. Cheap no-op when the last sync
 * succeeded — call freely from app foreground and the registration
 * path.
 */
export function retryPushPrefsSyncIfDirty(): void {
  if (prefsSyncStorage.getBoolean(DIRTY_KEY) !== true) return;
  void syncPushPrefsWithQuorum();
}
