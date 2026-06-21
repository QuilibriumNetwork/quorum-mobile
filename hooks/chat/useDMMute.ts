/**
 * useDMMute - Hook for muting/unmuting DM conversations
 *
 * Mute state is stored in `UserConfig.mutedConversations` so it SYNCS ACROSS
 * DEVICES (matching desktop). This follows the "bookmark pattern": the value
 * lives in the config, is persisted to the local MMKV config, and is read
 * straight back from there — it is NOT routed through the in-memory `user`
 * object (that read-back bridge is the one that broke primaryUsername /
 * isProfilePublic; see `config-to-user-readback-bridge-missing`).
 *
 * The in-memory muted set is held in a module-level store and exposed via
 * useSyncExternalStore, so EVERY consumer (the DM settings sheet, the messages
 * list, the conversation row) sees a toggle immediately — without that, each
 * useDMMute() call kept its own useState copy and a mute made on the DM screen
 * never reached the list until a remount.
 *
 * Muted conversations are excluded from unread badge counts.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useAuth } from '@/context';
import { createMMKV } from 'react-native-mmkv';
import {
  getLocalMutedConversations,
  setMutedConversations as persistMutedConversations,
} from '@/services/config';

// Legacy device-local store (pre-sync). Kept only to migrate existing muted
// ids into the config-backed list once, then it is no longer written.
const legacyStore = createMMKV({ id: 'dm-muted' });
function legacyKey(userAddress: string): string {
  return `muted:${userAddress}`;
}
function consumeLegacyMuted(userAddress: string): string[] {
  const raw = legacyStore.getString(legacyKey(userAddress));
  if (!raw) return [];
  try {
    const ids = JSON.parse(raw) as string[];
    // One-time consume: clear the legacy entry so this only merges once.
    legacyStore.remove(legacyKey(userAddress));
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  }
}

// --- Module-level shared store (one source of truth across all hook instances) ---

let mutedSet = new Set<string>();
let loadedForAddress: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Set<string> {
  return mutedSet;
}

/** Load (once per address) from config + migrate any legacy local mutes. */
function ensureLoaded(address: string): void {
  if (loadedForAddress === address) return;
  loadedForAddress = address;

  const fromConfig = getLocalMutedConversations(address);
  const legacy = consumeLegacyMuted(address);

  if (legacy.length > 0) {
    const merged = Array.from(new Set([...fromConfig, ...legacy]));
    mutedSet = new Set(merged);
    void persistMutedConversations(address, merged);
  } else {
    mutedSet = new Set(fromConfig);
  }
  emit();
}

/**
 * Clear the in-memory store on logout. Without this, the module-level set
 * outlives the session (there's no JS reload on sign-out), so a same-address
 * re-login after a config wipe would keep showing the pre-logout mutes
 * (`ensureLoaded` would short-circuit on the matching address). Resetting
 * `loadedForAddress` forces a fresh config read on the next sign-in.
 */
function resetForLogout(): void {
  if (loadedForAddress === null && mutedSet.size === 0) return;
  loadedForAddress = null;
  mutedSet = new Set();
  emit();
}

function setMuted(address: string, conversationId: string, muted: boolean): void {
  const next = new Set(mutedSet);
  if (muted) {
    next.add(conversationId);
  } else {
    next.delete(conversationId);
  }
  mutedSet = next; // new reference so useSyncExternalStore re-renders consumers
  emit();
  void persistMutedConversations(address, [...next]);
}

export function useDMMute() {
  const { user } = useAuth();
  const address = user?.address ?? null;

  // Load synchronously on first sight of this address so the very first render
  // already has the correct muted set (no one-frame flash of un-muted badges).
  // `ensureLoaded` is idempotent (guarded on `loadedForAddress`) and the legacy
  // migration's key-delete makes it safe under StrictMode double-invoke. Reading
  // an external store during render is explicitly supported by useSyncExternalStore.
  if (address) ensureLoaded(address);

  // Clearing on sign-out is a state change, so it belongs in an effect, not the
  // render body. Without it the module-level set outlives the session.
  useEffect(() => {
    if (!address) resetForLogout();
  }, [address]);

  const mutedConversations = useSyncExternalStore(subscribe, getSnapshot);

  const toggleMute = useCallback((conversationId: string) => {
    if (!address) return;
    setMuted(address, conversationId, !mutedSet.has(conversationId));
  }, [address]);

  const isMuted = useCallback(
    (conversationId: string): boolean => mutedConversations.has(conversationId),
    [mutedConversations]
  );

  return {
    mutedConversations,
    toggleMute,
    isMuted,
  };
}
