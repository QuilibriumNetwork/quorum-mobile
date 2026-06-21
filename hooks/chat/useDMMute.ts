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
 * Muted conversations are excluded from unread badge counts.
 */

import { useState, useEffect, useCallback } from 'react';
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
function migrateLegacyMuted(userAddress: string): string[] {
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

export function useDMMute() {
  const { user } = useAuth();
  const [mutedConversations, setMutedConversations] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!user?.address) {
      setMutedConversations(new Set());
      return;
    }

    const fromConfig = getLocalMutedConversations(user.address);
    const legacy = migrateLegacyMuted(user.address);

    if (legacy.length > 0) {
      // Fold any pre-sync local mutes into the config-backed list once.
      const merged = Array.from(new Set([...fromConfig, ...legacy]));
      setMutedConversations(new Set(merged));
      void persistMutedConversations(user.address, merged);
    } else {
      setMutedConversations(new Set(fromConfig));
    }
  }, [user?.address]);

  const toggleMute = useCallback((conversationId: string) => {
    if (!user?.address) return;
    const address = user.address;

    setMutedConversations((prev) => {
      const next = new Set(prev);
      if (next.has(conversationId)) {
        next.delete(conversationId);
      } else {
        next.add(conversationId);
      }
      // Persist + sync (best-effort) outside the setter's pure return.
      void persistMutedConversations(address, [...next]);
      return next;
    });
  }, [user?.address]);

  const isMuted = useCallback((conversationId: string): boolean => {
    return mutedConversations.has(conversationId);
  }, [mutedConversations]);

  return {
    mutedConversations,
    toggleMute,
    isMuted,
  };
}
