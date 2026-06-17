/**
 * useSpaceSettings - Hooks for managing space settings
 *
 * Provides:
 * - useUpdateSpace: Update space properties (name, description, icon, etc.)
 * - useDeleteSpace: Delete a space
 * - useLeaveSpace: Leave a space
 *
 * Space updates are broadcast to all members via:
 * 1. API upload (postSpaceManifest)
 * 2. Hub message (space-manifest control message via WebSocket)
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getSpace,
  saveSpace,
  deleteSpace as deleteSpaceFromStorage,
} from '@/services/config/spaceStorage';
import { getMMKVAdapter } from '@/services/storage/mmkvAdapter';
import { broadcastSpaceUpdate } from '@/services/space/broadcastSpaceUpdate';
import { useWebSocket } from '@/context/WebSocketContext';
import type { Space } from '@quilibrium/quorum-shared';

interface UpdateSpaceParams {
  spaceId: string;
  spaceName?: string;
  description?: string;
  iconUrl?: string;
  bannerUrl?: string;
  isRepudiable?: boolean;
  isPublic?: boolean;
  saveEditHistory?: boolean;
  roles?: Space['roles'];
  emojis?: Space['emojis'];
  stickers?: Space['stickers'];
  defaultChannelId?: string;
}

/**
 * Update space properties and broadcast to all members
 *
 * This follows the desktop SpaceService.updateSpace flow:
 * 1. Encrypt space manifest with config key
 * 2. Sign with owner key
 * 3. Post to API (postSpaceManifest)
 * 4. Broadcast via hub (space-manifest control message)
 * 5. Save locally
 */
export function useUpdateSpace() {
  const queryClient = useQueryClient();
  const { enqueueOutbound } = useWebSocket();

  return useMutation({
    mutationFn: async (params: UpdateSpaceParams): Promise<Space> => {
      const space = getSpace(params.spaceId);
      if (!space) {
        throw new Error('Space not found');
      }

      const timestamp = Date.now();

      // Build updated space object
      const updatedSpace: Space = {
        ...space,
        spaceName: params.spaceName ?? space.spaceName,
        description: params.description ?? space.description,
        iconUrl: params.iconUrl ?? space.iconUrl,
        bannerUrl: params.bannerUrl ?? space.bannerUrl,
        isRepudiable: params.isRepudiable ?? space.isRepudiable,
        isPublic: params.isPublic ?? space.isPublic,
        saveEditHistory: params.saveEditHistory ?? space.saveEditHistory,
        roles: params.roles ?? space.roles,
        emojis: params.emojis ?? space.emojis,
        stickers: params.stickers ?? space.stickers,
        defaultChannelId: params.defaultChannelId ?? space.defaultChannelId,
        modifiedDate: timestamp,
      };

      // Save locally first
      saveSpace(updatedSpace);
      const adapter = getMMKVAdapter();
      await adapter.saveSpace(updatedSpace);

      // Broadcast to all members (API + hub)
      enqueueOutbound(async () => {
        const result = await broadcastSpaceUpdate(updatedSpace);
        return result ? [result.wsEnvelope] : [];
      });

      return updatedSpace;
    },
    onSuccess: (_, params) => {
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
      queryClient.invalidateQueries({ queryKey: ['spaces', params.spaceId] });
    },
  });
}

interface DeleteSpaceParams {
  spaceId: string;
}

/**
 * Delete a space (local only - does not affect other members)
 */
export function useDeleteSpace() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: DeleteSpaceParams): Promise<void> => {
      const space = getSpace(params.spaceId);
      if (!space) {
        throw new Error('Space not found');
      }

      // Delete from spaceStorage (includes keys)
      deleteSpaceFromStorage(params.spaceId);

      // Delete from mmkvAdapter
      const adapter = getMMKVAdapter();
      await adapter.deleteSpace(params.spaceId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
    },
  });
}

/**
 * Leave a space (same as delete locally, but could send a leave message in future)
 */
export function useLeaveSpace() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: DeleteSpaceParams): Promise<void> => {
      const space = getSpace(params.spaceId);
      if (!space) {
        throw new Error('Space not found');
      }

      // TODO: Send leave message to space before deleting
      // This would notify other members that the user has left

      // Delete from spaceStorage (includes keys)
      deleteSpaceFromStorage(params.spaceId);

      // Delete from mmkvAdapter
      const adapter = getMMKVAdapter();
      await adapter.deleteSpace(params.spaceId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
    },
  });
}
