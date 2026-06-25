/**
 * useEditSpaceMessage - Hook for editing messages in space channels
 *
 * Uses the SpaceMessageService to send encrypted edit messages via WebSocket.
 * Enforces a 15-minute edit window.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, useWebSocket } from '@/context';
import { sendEditMessage } from '@/services/space/spaceMessageService';
import { getMMKVAdapter } from '@/services/storage/mmkvAdapter';
import { buildLocalEdits } from '@/utils/editHistory';
import type { Message, GetMessagesResult } from '@quilibrium/quorum-shared';

const EDIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

export interface UseEditSpaceMessageParams {
  spaceId: string;
  channelId: string;
  messageId: string;
  newText: string;
  originalCreatedDate: number;
  /** Space roles/channels so an edit that adds/changes a mention still
   *  populates message.mentions (and therefore notifies the mentioned user). */
  spaceRoles?: Array<{ roleId: string; roleTag: string }>;
  spaceChannels?: Array<{ channelId: string; channelName: string }>;
  /** Sender has mention:everyone — gates @everyone in an edited message. */
  allowEveryone?: boolean;
}

export function canEditMessage(message: { userId: string; timestamp: number }, currentUserId?: string): boolean {
  if (!currentUserId) return false;
  if (message.userId !== currentUserId) return false;
  const elapsed = Date.now() - message.timestamp;
  return elapsed <= EDIT_WINDOW_MS;
}

export function useEditSpaceMessage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { enqueueOutbound, isConnected } = useWebSocket();

  return useMutation({
    mutationFn: async (params: UseEditSpaceMessageParams) => {
      if (!user?.address) {
        throw new Error('User must be logged in to edit messages');
      }

      if (!isConnected) {
        throw new Error('Not connected to server. Please wait for connection.');
      }

      // Enforce edit window
      const elapsed = Date.now() - params.originalCreatedDate;
      if (elapsed > EDIT_WINDOW_MS) {
        throw new Error('Messages can only be edited within 15 minutes of sending');
      }

      const result = await sendEditMessage({
        spaceId: params.spaceId,
        channelId: params.channelId,
        originalMessageId: params.messageId,
        editedText: params.newText,
        senderAddress: user.address,
        spaceRoles: params.spaceRoles,
        spaceChannels: params.spaceChannels,
        allowEveryone: params.allowEveryone,
      });

      // Send via WebSocket
      enqueueOutbound(async () => {
        return [result.wsEnvelope];
      });

      return params.messageId;
    },

    onMutate: async (params) => {
      const key = ['messages', 'infinite', params.spaceId, params.channelId];

      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: key });

      // Snapshot previous value
      const previousData = queryClient.getQueryData(key);
      // Snapshot the persisted message too so we can roll storage back
      // alongside the cache if the send fails. Without this, an error
      // would leave MMKV holding the new text while the cache reverts.
      const adapter = getMMKVAdapter();
      const previousStored = await adapter.getMessage({
        spaceId: params.spaceId,
        channelId: params.channelId,
        messageId: params.messageId,
      });

      // Honor the space's "Save Edit History" setting, matching desktop
      // (MessageService.ts): when OFF, drop prior versions (edits: []) instead
      // of accumulating. Default false to match desktop — keeping history is
      // opt-in. The receive path (WebSocketContext edit-message blocks) applies
      // the same gate so the sender's own echoed edit and edits from others
      // stay consistent.
      const space = await adapter.getSpace(params.spaceId);
      const saveEditHistory = space?.saveEditHistory ?? false;

      const editedAt = Date.now();

      // Optimistically update the message text in cache
      queryClient.setQueryData(
        key,
        (old: { pages: GetMessagesResult[]; pageParams: unknown[] } | undefined) => {
          if (!old) return old;

          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              messages: page.messages.map((m: Message) => {
                if (m.messageId === params.messageId && m.content.type === 'post') {
                  return {
                    ...m,
                    modifiedDate: editedAt,
                    content: {
                      ...m.content,
                      text: params.newText,
                    },
                    edits: buildLocalEdits(m.edits, params.newText, editedAt, saveEditHistory),
                  };
                }
                return m;
              }),
            })),
          };
        }
      );

      // Persist the edit. The cache-only optimistic update used to be
      // overwritten by `onSettled` → `invalidateQueries` → refetch from
      // MMKV, since storage still held the original text. Writing here
      // keeps disk and cache in sync.
      if (previousStored && previousStored.content.type === 'post') {
        const updated: Message = {
          ...previousStored,
          modifiedDate: editedAt,
          content: { ...previousStored.content, text: params.newText },
          edits: buildLocalEdits(previousStored.edits, params.newText, editedAt, saveEditHistory),
        };
        await adapter.saveMessage(updated, updated.createdDate, '', '', '', '');
      }

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

    onSettled: (data, err, params) => {
      queryClient.invalidateQueries({
        queryKey: ['messages', 'infinite', params.spaceId, params.channelId],
      });
    },
  });
}
