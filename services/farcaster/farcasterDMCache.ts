/**
 * farcasterDMCache — a small, synchronous MMKV cache for Farcaster direct
 * casts so the inbox + an open DM paint instantly from disk, then refresh
 * from the network in the background.
 *
 * This is deliberately separate from the app-wide React Query persister
 * (which serializes the *entire* cache to one blob, restores asynchronously
 * on launch, and is subject to per-query gcTime eviction). Here we keep a
 * per-conversation key that's read synchronously on mount via `initialData`,
 * so there's no restore race and no spinner — mirrors the
 * `farcasterUserCache` / `useFarcasterUserPersistent` pattern.
 *
 * Only the most-recent page is cached (the screen shows newest-first), which
 * bounds the stored size; older pages still load from the network on scroll.
 */

import { mmkvStorage } from '@/services/offline/storage';
import type { DirectCastMessage } from '@/services/farcasterClient';
import type { Conversation } from '@/hooks/chat/useConversations';

const CONVERSATIONS_KEY = 'fc-dm-cache:conversations:v1';
const messagesKey = (conversationId: string) => `fc-dm-cache:messages:v1:${conversationId}`;
/** Cap the cached message page so a long thread doesn't bloat MMKV. */
const MAX_CACHED_MESSAGES = 60;

export interface CachedConversationsPage {
  conversations: Conversation[];
  nextCursor: string | undefined;
  requestsCount: number;
}
export interface CachedConversations {
  pages: CachedConversationsPage[];
  pageParams: (string | undefined)[];
}

export interface CachedMessagesPage {
  messages: DirectCastMessage[];
  nextCursor: string | undefined;
}
export interface CachedMessages {
  pages: CachedMessagesPage[];
  pageParams: (string | undefined)[];
}

// ---- conversations (the inbox) ------------------------------------------
export function getCachedDMConversations(): CachedConversations | undefined {
  try {
    const raw = mmkvStorage.getItem(CONVERSATIONS_KEY);
    return raw ? (JSON.parse(raw) as CachedConversations) : undefined;
  } catch {
    return undefined;
  }
}

export function setCachedDMConversations(data: CachedConversations): void {
  try {
    const first = data.pages[0];
    if (!first) return;
    // Persist only the first page so the inbox paints instantly; the rest
    // paginates from the network.
    const trimmed: CachedConversations = {
      pages: [
        {
          conversations: first.conversations,
          nextCursor: first.nextCursor,
          requestsCount: first.requestsCount,
        },
      ],
      pageParams: [undefined],
    };
    mmkvStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(trimmed));
  } catch {
    // best-effort cache; ignore write failures
  }
}

// ---- messages (an open DM) ----------------------------------------------
export function getCachedDMMessages(conversationId: string | undefined): CachedMessages | undefined {
  if (!conversationId) return undefined;
  try {
    const raw = mmkvStorage.getItem(messagesKey(conversationId));
    return raw ? (JSON.parse(raw) as CachedMessages) : undefined;
  } catch {
    return undefined;
  }
}

export function setCachedDMMessages(
  conversationId: string | undefined,
  data: CachedMessages,
): void {
  if (!conversationId) return;
  try {
    const first = data.pages[0];
    if (!first) return;
    const trimmed: CachedMessages = {
      pages: [
        {
          messages: first.messages.slice(0, MAX_CACHED_MESSAGES),
          nextCursor: first.nextCursor,
        },
      ],
      pageParams: [undefined],
    };
    mmkvStorage.setItem(messagesKey(conversationId), JSON.stringify(trimmed));
  } catch {
    // best-effort cache; ignore write failures
  }
}
