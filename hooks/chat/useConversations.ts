/**
 * useConversations hook - Fetches direct message conversations from local storage
 */

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useStorageAdapter } from '@/context/StorageContext';
import { queryKeys, Conversation as BaseConversation, logger } from '@quilibrium/quorum-shared';
import type { MessagePreview } from '@/utils/messagePreview';

const log = logger.scope('[Conversations]');

// Extended Conversation type with mobile-specific fields
export type Conversation = BaseConversation & {
  // Message preview fields. Quorum DMs store the typed {kind,text} preview;
  // the Farcaster path still sets a plain string. Renderers coerce either via
  // coerceMessagePreview(). Legacy MMKV rows may also hold a raw string.
  lastMessagePreview?: MessagePreview | string;
  lastMessageSenderName?: string;
  // Source indicator (farcaster vs quorum)
  source?: 'quorum' | 'farcaster';
  // Farcaster-specific fields
  farcasterConversationId?: string;
  farcasterFid?: number;
  farcasterUsername?: string;
  farcasterParticipantFids?: number[];
  unreadCount?: number;
};

export interface ConversationWithPreview {
  conversationId: string;
  address: string;
  displayName?: string;
  icon?: string;
  preview?: string;
  previewIcon?: string;
  timestamp: number;
  lastReadTimestamp?: number;
  type: 'direct' | 'group';
}

export function useConversations(options?: { type?: 'direct' | 'group'; enabled?: boolean }) {
  const storage = useStorageAdapter();
  const type = options?.type ?? 'direct';

  return useInfiniteQuery({
    queryKey: queryKeys.conversations.all(type),
    queryFn: async ({ pageParam }) => {
      log.log('Fetching conversations', { type, pageParam });
      const result = await storage.getConversations({
        type,
        cursor: pageParam,
        limit: 50,
      });
      log.log('Fetched conversations', { type, count: result.conversations?.length ?? 0 });
      return result;
    },
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: options?.enabled ?? true,
    staleTime: 30000, // 30 seconds
  });
}

export function useConversation(conversationId: string | undefined, options?: { enabled?: boolean }) {
  const storage = useStorageAdapter();

  return useQuery({
    queryKey: queryKeys.conversations.detail(conversationId ?? ''),
    queryFn: async () => {
      if (!conversationId) return undefined;
      return storage.getConversation(conversationId);
    },
    enabled: (options?.enabled ?? true) && !!conversationId,
    staleTime: 30000, // 30 seconds - match list query
  });
}
