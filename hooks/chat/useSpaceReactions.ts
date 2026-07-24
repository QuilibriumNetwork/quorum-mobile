/**
 * useSpaceReactions - Hook for sending reactions in encrypted space channels
 *
 * Uses the SpaceMessageService to:
 * - Send encrypted reactions via WebSocket
 * - Optimistically update local cache
 * - Handle errors
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, useWebSocket } from '@/context';
import {
  sendReaction,
  removeReaction,
} from '@/services/space/spaceMessageService';
import { getMMKVAdapter } from '@/services/storage/mmkvAdapter';
import type { Message, GetMessagesResult, Reaction } from '@quilibrium/quorum-shared';

// Sender's reaction never round-trips through our own receive handler:
// `applySpaceGroupResults` skips self-echoes for everything except
// space-call-{start,end}. So if we don't write to MMKV here, the
// reaction lives only in the React Query cache — and the next
// `invalidateQueries` (e.g. when the user sends a follow-up message)
// triggers a refetch from disk that returns a copy without the
// reaction, silently dropping it from the UI.
async function persistReactionToStorage(
  spaceId: string,
  channelId: string,
  messageId: string,
  apply: (reactions: Message['reactions']) => Message['reactions'],
): Promise<Message | undefined> {
  const adapter = getMMKVAdapter();
  const stored = await adapter.getMessage({ spaceId, channelId, messageId });
  if (!stored) return undefined;
  const updated: Message = { ...stored, reactions: apply(stored.reactions) };
  await adapter.saveMessage(updated, updated.createdDate, '', '', '', '');
  return stored;
}

export interface UseSpaceReactionParams {
  spaceId: string;
  channelId: string;
  messageId: string;
  emoji: string;
}

export function useAddSpaceReaction() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { enqueueOutbound } = useWebSocket();

  return useMutation({
    mutationFn: async (params: UseSpaceReactionParams) => {
      if (!user?.address) {
        throw new Error('User must be logged in to add reactions');
      }

      // Do NOT gate on isConnected: enqueueOutbound buffers the envelope and the
      // WS client flushes it on (re)connect, so a transient disconnect (or a
      // stale isConnected) must not drop the send. Mirrors the DM delete/edit paths.

      const result = await sendReaction({
        spaceId: params.spaceId,
        channelId: params.channelId,
        targetMessageId: params.messageId,
        reaction: params.emoji,
        senderAddress: user.address,
      });

      // Send via WebSocket
      enqueueOutbound(async () => {
        return [result.wsEnvelope];
      });

      return result;
    },

    onMutate: async (params) => {
      if (!user?.address) return;

      const key = ['messages', 'infinite', params.spaceId, params.channelId];

      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: key });

      // Snapshot previous value
      const previousData = queryClient.getQueryData(key);

      const applyAdd = (existingReactions: Message['reactions']): Message['reactions'] => {
        const reactions = existingReactions || [];
        const existingReaction = reactions.find(
          (r) => r.emojiName === params.emoji || r.emojiId === params.emoji,
        );
        if (existingReaction) {
          if (existingReaction.memberIds.includes(user.address!)) return reactions;
          return reactions.map(r =>
            r === existingReaction
              ? { ...r, count: r.count + 1, memberIds: [...r.memberIds, user.address!] }
              : r,
          );
        }
        const newReaction: Reaction = {
          emojiId: params.emoji,
          emojiName: params.emoji,
          spaceId: params.spaceId,
          count: 1,
          memberIds: [user.address!],
        };
        return [...reactions, newReaction];
      };

      // Optimistically add reaction to message in cache
      queryClient.setQueryData(
        key,
        (old: { pages: GetMessagesResult[]; pageParams: unknown[] } | undefined) => {
          if (!old) return old;

          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              messages: page.messages.map((m: Message) =>
                m.messageId === params.messageId ? { ...m, reactions: applyAdd(m.reactions) } : m,
              ),
            })),
          };
        }
      );

      // Persist to MMKV so the reaction survives the next refetch.
      const previousStored = await persistReactionToStorage(
        params.spaceId,
        params.channelId,
        params.messageId,
        applyAdd,
      );

      return { previousData, previousStored };
    },

    onError: async (err, params, context) => {
      // Rollback on error
      if (context?.previousData) {
        const key = ['messages', 'infinite', params.spaceId, params.channelId];
        queryClient.setQueryData(key, context.previousData);
      }
      if (context?.previousStored) {
        const adapter = getMMKVAdapter();
        await adapter.saveMessage(
          context.previousStored,
          context.previousStored.createdDate,
          '', '', '', '',
        );
      }
    },
  });
}

export function useRemoveSpaceReaction() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { enqueueOutbound } = useWebSocket();

  return useMutation({
    mutationFn: async (params: UseSpaceReactionParams) => {
      if (!user?.address) {
        throw new Error('User must be logged in to remove reactions');
      }

      // Do NOT gate on isConnected: enqueueOutbound buffers the envelope and the
      // WS client flushes it on (re)connect, so a transient disconnect (or a
      // stale isConnected) must not drop the send. Mirrors the DM delete/edit paths.

      const result = await removeReaction({
        spaceId: params.spaceId,
        channelId: params.channelId,
        targetMessageId: params.messageId,
        reaction: params.emoji,
        senderAddress: user.address,
      });

      // Send via WebSocket
      enqueueOutbound(async () => {
        return [result.wsEnvelope];
      });

      return result;
    },

    onMutate: async (params) => {
      if (!user?.address) return;

      const key = ['messages', 'infinite', params.spaceId, params.channelId];

      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: key });

      // Snapshot previous value
      const previousData = queryClient.getQueryData(key);

      const applyRemove = (existingReactions: Message['reactions']): Message['reactions'] => {
        return (existingReactions || [])
          .map((r) => {
            if (r.emojiName !== params.emoji && r.emojiId !== params.emoji) return r;
            const newMemberIds = r.memberIds.filter((id) => id !== user.address);
            if (newMemberIds.length === 0) return null;
            return { ...r, count: newMemberIds.length, memberIds: newMemberIds };
          })
          .filter((r): r is Reaction => r !== null);
      };

      // Optimistically remove reaction from cache
      queryClient.setQueryData(
        key,
        (old: { pages: GetMessagesResult[]; pageParams: unknown[] } | undefined) => {
          if (!old) return old;

          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              messages: page.messages.map((m: Message) =>
                m.messageId === params.messageId ? { ...m, reactions: applyRemove(m.reactions) } : m,
              ),
            })),
          };
        }
      );

      // Persist to MMKV — same reasoning as the add path; without this
      // a follow-up message's invalidate-and-refetch resurrects the
      // deleted reaction from disk.
      const previousStored = await persistReactionToStorage(
        params.spaceId,
        params.channelId,
        params.messageId,
        applyRemove,
      );

      return { previousData, previousStored };
    },

    onError: async (err, params, context) => {
      // Rollback on error
      if (context?.previousData) {
        const key = ['messages', 'infinite', params.spaceId, params.channelId];
        queryClient.setQueryData(key, context.previousData);
      }
      if (context?.previousStored) {
        const adapter = getMMKVAdapter();
        await adapter.saveMessage(
          context.previousStored,
          context.previousStored.createdDate,
          '', '', '', '',
        );
      }
    },
  });
}
