/**
 * useEditDirectMessage - Hook for editing direct messages (E2EE)
 *
 * Sends an edit-message type through the encrypted DM channel.
 * Enforces a 15-minute edit window.
 * Updates local cache and storage optimistically.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/context';
import { useStorageAdapter } from '@/context/StorageContext';
import { queryKeys, type Message } from '@quilibrium/quorum-shared';

const EDIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

export interface UseEditDirectMessageParams {
  conversationId: string;
  recipientAddress: string;
  messageId: string;
  newText: string;
  originalCreatedDate: number;
}

import type { MessagesPage, InfiniteMessagesData } from './queryTypes';

export function useEditDirectMessage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const storage = useStorageAdapter();

  return useMutation({
    mutationFn: async (params: UseEditDirectMessageParams) => {
      if (!user?.address) {
        throw new Error('User must be logged in to edit messages');
      }

      // Enforce edit window
      const elapsed = Date.now() - params.originalCreatedDate;
      if (elapsed > EDIT_WINDOW_MS) {
        throw new Error('Messages can only be edited within 15 minutes of sending');
      }

      // Honor the conversation's "Save Edit History" setting, matching
      // desktop (MessageEditTextarea.tsx / MessageService.ts): when OFF, drop
      // prior versions (edits: []) instead of accumulating. Default false to
      // match desktop's default everywhere — keeping history is opt-in.
      const conversation = await storage.getConversation(params.conversationId);
      const saveEditHistory = conversation?.saveEditHistory ?? false;

      // For DMs, editing is local-only (the encrypted message was already sent)
      // We update the local message in storage
      const key = queryKeys.messages.infinite(params.recipientAddress, params.recipientAddress);
      const existingData = queryClient.getQueryData<InfiniteMessagesData>(key);

      if (existingData) {
        // Find the message and update in storage
        for (const page of existingData.pages) {
          const msg = page.messages.find(m => m.messageId === params.messageId);
          if (msg && (msg.content.type === 'post' || msg.content.type === 'event')) {
            const updatedMsg: Message = {
              ...msg,
              modifiedDate: Date.now(),
              content: {
                ...msg.content,
                text: params.newText,
              } as Message['content'],
              edits: saveEditHistory
                ? [
                    ...(msg.edits || []),
                    {
                      text: params.newText,
                      modifiedDate: Date.now(),
                      lastModifiedHash: '',
                    },
                  ]
                : [],
            };
            await storage.saveMessage(
              updatedMsg,
              updatedMsg.modifiedDate,
              params.recipientAddress,
              'dm',
              '',
              '',
            );
            break;
          }
        }
      }

      return params.messageId;
    },

    onMutate: async (params) => {
      const key = queryKeys.messages.infinite(params.recipientAddress, params.recipientAddress);

      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: key });

      // Snapshot previous value
      const previousData = queryClient.getQueryData<InfiniteMessagesData>(key);

      // Same "Save Edit History" gate as the storage write, so the optimistic
      // cache and persisted message don't diverge (default false → desktop).
      const conversation = await storage.getConversation(params.conversationId);
      const saveEditHistory = conversation?.saveEditHistory ?? false;

      // Optimistically update the message text in cache
      queryClient.setQueryData<InfiniteMessagesData>(key, (old) => {
        if (!old) return old;

        return {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            messages: page.messages.map((m) => {
              if (m.messageId === params.messageId && m.content.type === 'post') {
                return {
                  ...m,
                  modifiedDate: Date.now(),
                  content: {
                    ...m.content,
                    text: params.newText,
                  },
                  edits: saveEditHistory
                    ? [
                        ...(m.edits || []),
                        {
                          text: params.newText,
                          modifiedDate: Date.now(),
                          lastModifiedHash: '',
                        },
                      ]
                    : [],
                };
              }
              return m;
            }),
          })),
        };
      });

      return { previousData };
    },

    onError: (err, params, context) => {
      // Rollback on error
      if (context?.previousData) {
        const key = queryKeys.messages.infinite(params.recipientAddress, params.recipientAddress);
        queryClient.setQueryData(key, context.previousData);
      }
    },

    onSettled: (data, err, params) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.messages.infinite(params.recipientAddress, params.recipientAddress),
      });
    },
  });
}
