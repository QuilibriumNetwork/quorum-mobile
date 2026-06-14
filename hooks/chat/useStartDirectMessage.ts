/**
 * useStartDirectMessage — open (or create) the 1:1 conversation with a user
 * and navigate to the DM screen.
 *
 * Mirrors NewConversationModal's create-or-open logic: a 1:1 Quorum
 * conversation id has the form `address/address`. If a conversation with
 * this user already exists (matched by its `address`) we reuse it; otherwise
 * we persist a fresh row before navigating. The first sent message creates
 * the conversation server-side.
 *
 * This is the mobile equivalent of desktop's `useUserProfileActions.sendMessage`,
 * which navigates to `/messages/<address>`.
 */

import { useCallback } from 'react';
import { router } from 'expo-router';
import { useStorageAdapter } from '@/context/StorageContext';
import { useUnifiedConversations } from '@/hooks/chat/useUnifiedConversations';

export function useStartDirectMessage() {
  const storage = useStorageAdapter();
  const { conversations } = useUnifiedConversations();

  return useCallback(
    async (userAddress: string) => {
      const targetAddress = userAddress.trim();
      if (!targetAddress) return;

      // Reuse an existing 1:1 conversation with this user if we have one.
      const existing = conversations.find(
        (c) => c.address?.toLowerCase() === targetAddress.toLowerCase()
      );

      if (existing) {
        router.push(`/messages/dm/${encodeURIComponent(existing.conversationId)}`);
        return;
      }

      // Otherwise create the conversation locally (format: address/address).
      const conversationId = `${targetAddress}/${targetAddress}`;
      try {
        await storage.saveConversation({
          conversationId,
          address: targetAddress,
          type: 'direct',
          timestamp: Date.now(),
          // Back-filled by the DM screen from the recipient's public profile.
          icon: '',
          displayName: '',
        });
      } catch {
        // Non-fatal: the DM screen synthesizes a minimal conversation from
        // the id, and the first message creates it server-side anyway.
      }

      router.push(`/messages/dm/${encodeURIComponent(conversationId)}`);
    },
    [storage, conversations]
  );
}
