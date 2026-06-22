/**
 * useBlockUser — personal "Block" (viewer-side hide) that syncs across devices.
 *
 * Blocking a user hides ALL of their messages — past and new — from YOUR own
 * rendered stream, scoped to a single space. It is purely viewer-side: no
 * moderation effect, no permission, and it does not touch the user for anyone
 * else. This is intentionally DISTINCT from the role-gated moderation mute
 * (useModMuteUser / MuteMessage), which silences a user for everyone at receive
 * time. Block is a reversible render-time filter only.
 *
 * State lives in `UserConfig.blockedUsers[spaceId]` and syncs across the user's
 * devices via the config blob (read straight back from local config, never the
 * in-memory `user` object). In-memory state is a module-level store exposed via
 * useSyncExternalStore so a block immediately re-filters the message stream
 * across every consumer; a per-hook useState copy would not propagate.
 *
 * Replaces the old device-local `useUserMuting` and migrates its entries once.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useAuth } from '@/context';
import { createMMKV } from 'react-native-mmkv';
import {
  getLocalBlockedUsers,
  setBlockedUsers as persistBlockedUsers,
} from '@/services/config';

// Legacy device-local store (pre-sync, the old useUserMuting). Read once to
// migrate existing hides into the config-backed list, then no longer written.
const legacyStore = createMMKV({ id: 'space-user-mutes' });
function legacyKey(userAddress: string, spaceId: string): string {
  return `muted:${userAddress}:${spaceId}`;
}
function consumeLegacyBlocked(userAddress: string, spaceId: string): string[] {
  const raw = legacyStore.getString(legacyKey(userAddress, spaceId));
  if (!raw) return [];
  try {
    const ids = JSON.parse(raw) as string[];
    legacyStore.remove(legacyKey(userAddress, spaceId)); // one-time consume
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  }
}

// --- Module-level shared store (one source of truth across all hook instances) ---
// Keyed by spaceId; each space's blocked set is loaded lazily on first sight.

let store: Record<string, Set<string>> = {};
let loadedForAddress: string | null = null;
const loadedSpaces = new Set<string>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Record<string, Set<string>> {
  return store;
}

const EMPTY: Set<string> = new Set();

/** Reset everything when the address changes (login/logout). */
function resetForAddress(address: string | null): void {
  if (loadedForAddress === address) return;
  loadedForAddress = address;
  store = {};
  loadedSpaces.clear();
  emit();
}

/** Load one space's blocked set from config (once), migrating legacy mutes. */
function ensureSpaceLoaded(address: string, spaceId: string): void {
  if (loadedSpaces.has(spaceId)) return;
  loadedSpaces.add(spaceId);

  let blocked = getLocalBlockedUsers(address, spaceId);
  if (blocked.length === 0) {
    const legacy = consumeLegacyBlocked(address, spaceId);
    if (legacy.length > 0) {
      blocked = legacy;
      void persistBlockedUsers(address, spaceId, blocked);
    }
  }
  store = { ...store, [spaceId]: new Set(blocked) };
  emit();
}

function setBlocked(address: string, spaceId: string, target: string, blocked: boolean): void {
  const prev = store[spaceId] ?? EMPTY;
  const next = new Set(prev);
  if (blocked) next.add(target);
  else next.delete(target);
  store = { ...store, [spaceId]: next };
  emit();
  void persistBlockedUsers(address, spaceId, [...next]);
}

/**
 * Personal block for one space. Pass the spaceId the screen is showing.
 * `filteredMessages` hides blocked senders from a message array (render-time).
 */
export function useBlockUser(spaceId?: string) {
  const { user } = useAuth();
  const address = user?.address ?? null;

  if (address && spaceId) ensureSpaceLoaded(address, spaceId);

  useEffect(() => {
    if (!address) resetForAddress(null);
  }, [address]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  const blockedUsers = (spaceId && snapshot[spaceId]) || EMPTY;

  const isUserBlocked = useCallback(
    (targetUserId: string): boolean => blockedUsers.has(targetUserId),
    [blockedUsers],
  );

  const toggleBlockUser = useCallback(
    (targetUserId: string) => {
      if (!address || !spaceId) return;
      setBlocked(address, spaceId, targetUserId, !blockedUsers.has(targetUserId));
    },
    [address, spaceId, blockedUsers],
  );

  const filteredMessages = useMemo(() => {
    return <T extends { userId: string }>(messages: T[]): T[] => {
      if (blockedUsers.size === 0) return messages;
      return messages.filter((m) => !blockedUsers.has(m.userId));
    };
  }, [blockedUsers]);

  return {
    blockedUsers,
    isUserBlocked,
    toggleBlockUser,
    filteredMessages,
  };
}
