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
import { removeSpaceFromConfig } from '@/services/config/configService';
import { broadcastSpaceUpdate } from '@/services/space/broadcastSpaceUpdate';
import { announceLeave } from '@/services/space/announceLeave';
import { useWebSocket } from '@/context/WebSocketContext';
import { useAuth } from '@/context/AuthContext';
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
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (params: DeleteSpaceParams): Promise<void> => {
      const space = getSpace(params.spaceId);
      if (!space) {
        throw new Error('Space not found');
      }

      // Publish the removal before wiping local storage. Either order produces
      // a consistent published list, but if the wipe ran first and this step
      // then failed, the Space would be left listed in config.spaceIds with its
      // keys already deleted — permanently unkeyable, and the exact state that
      // makes every later save publish a truncated list.
      //
      // Abort rather than skip when there is no address: silently falling
      // through would wipe local storage anyway and produce that same state.
      // The caller surfaces the failure and leaves the modal open.
      if (!user?.address) {
        throw new Error('Cannot remove Space: no authenticated user address');
      }
      await removeSpaceFromConfig(user.address, params.spaceId);

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
 * Leave a space: tell the other members, deregister from the hub, then wipe locally.
 */
export function useLeaveSpace() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { enqueueOutbound, flushOutbound } = useWebSocket();

  return useMutation({
    mutationFn: async (params: DeleteSpaceParams): Promise<void> => {
      const space = getSpace(params.spaceId);
      if (!space) {
        throw new Error('Space not found');
      }

      // A missing address aborts instead of skipping — see the note in
      // useDeleteSpace for why silently falling through is the dangerous option.
      if (!user?.address) {
        throw new Error('Cannot leave Space: no authenticated user address');
      }

      // Announce the departure BEFORE anything below destroys the keys that make
      // announcing possible. This used to be a bare TODO, which is why leaving a
      // Space on mobile was silent: the Space disappeared here and every other
      // member went on listing the member, their roles and their hub inbox.
      //
      // Throws when the hub deregistration fails, and that is deliberate — the
      // Space stays on this device, the modal surfaces the error, and the user
      // can retry. Wiping through a failure would strand the inbox registered on
      // the hub with the keys needed to remove it already gone. The broadcast leg
      // never throws; announceLeave carries the reasoning for the split.
      await announceLeave({
        spaceId: params.spaceId,
        enqueueOutbound,
        flushOutbound,
      });

      // Removed from the synced config before the local wipe, for the same
      // reason as useDeleteSpace: wiping first and failing here would leave the
      // Space listed in config.spaceIds with its keys already gone.
      await removeSpaceFromConfig(user.address, params.spaceId);

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
