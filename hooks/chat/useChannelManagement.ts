/**
 * useChannelManagement - Hooks for managing space channels
 *
 * Provides:
 * - useAddChannel: Create a new channel
 * - useUpdateChannel: Update channel properties
 * - useDeleteChannel: Delete a channel
 * - useAddGroup: Create a new channel group
 * - useUpdateGroup: Update group properties
 * - useDeleteGroup: Delete a channel group
 * - useMoveChannel: Move a channel between groups or reorder within a group
 * - useReorderGroups: Reorder channel groups
 * - useReorderChannels: Reorder channels within a group
 *
 * Every mutation that changes the space manifest also broadcasts the updated
 * manifest to all members (API upload + hub WebSocket), matching the pattern
 * in useSpaceSettings and useRoleManagement. Without this, mobile-side channel
 * and group edits would stay local and never reach other devices (e.g. desktop).
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getSpace, saveSpace, saveSpaceKey } from '@/services/config/spaceStorage';
import { getMMKVAdapter } from '@/services/storage/mmkvAdapter';
import { NativeCryptoProvider } from '@/services/crypto/native-provider';
import { broadcastSpaceUpdate } from '@/services/space/broadcastSpaceUpdate';
import { useWebSocket } from '@/context/WebSocketContext';
import { bytesToHex } from '@quilibrium/quorum-shared';
import type { Space, Channel, Group } from '@quilibrium/quorum-shared';
import { sha256 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';
import * as multihashes from 'multihashes';

/**
 * Derive address from public key using multihash
 */
function deriveAddress(publicKeyBytes: Uint8Array): string {
  const hash = sha256(publicKeyBytes);
  const mhash = multihashes.encode(hash, 'sha2-256');
  return bs58.encode(mhash);
}

interface AddChannelParams {
  spaceId: string;
  groupIndex: number;
  channelName: string;
  channelTopic?: string;
  isReadOnly?: boolean;
  managerRoleIds?: string[];
  icon?: string;
  iconColor?: string;
}

/**
 * Add a new channel to a space group
 */
export function useAddChannel() {
  const queryClient = useQueryClient();
  const { enqueueOutbound } = useWebSocket();

  return useMutation({
    mutationFn: async (params: AddChannelParams): Promise<Channel> => {
      const space = getSpace(params.spaceId);
      if (!space) {
        throw new Error('Space not found');
      }

      if (params.groupIndex < 0 || params.groupIndex >= space.groups.length) {
        throw new Error('Invalid group index');
      }

      const cryptoProvider = new NativeCryptoProvider();
      const timestamp = Date.now();

      // Generate channel keypair
      const channelKeypair = await cryptoProvider.generateEd448();
      const channelAddress = deriveAddress(new Uint8Array(channelKeypair.public_key));
      const channelPublicKeyHex = bytesToHex(new Uint8Array(channelKeypair.public_key));
      const channelPrivateKeyHex = bytesToHex(new Uint8Array(channelKeypair.private_key));

      // Create new channel
      const newChannel: Channel = {
        channelId: channelAddress,
        spaceId: params.spaceId,
        channelName: params.channelName,
        channelTopic: params.channelTopic ?? '',
        createdDate: timestamp,
        modifiedDate: timestamp,
        isReadOnly: params.isReadOnly,
        managerRoleIds: params.managerRoleIds,
        icon: params.icon,
        iconColor: params.iconColor,
      };

      // Update space with new channel
      const updatedGroups = space.groups.map((group, index) => {
        if (index === params.groupIndex) {
          return {
            ...group,
            channels: [...group.channels, newChannel],
          };
        }
        return group;
      });

      const updatedSpace: Space = {
        ...space,
        groups: updatedGroups,
        modifiedDate: timestamp,
      };

      // Save channel key
      saveSpaceKey({
        spaceId: params.spaceId,
        keyId: channelAddress,
        publicKey: channelPublicKeyHex,
        privateKey: channelPrivateKeyHex,
      });

      // Save space to both storages
      saveSpace(updatedSpace);
      const adapter = getMMKVAdapter();
      await adapter.saveSpace(updatedSpace);

      // Broadcast to all members (API + hub)
      enqueueOutbound(async () => {
        const result = await broadcastSpaceUpdate(updatedSpace);
        return result ? [result.wsEnvelope] : [];
      });

      return newChannel;
    },
    onSuccess: (_, params) => {
      queryClient.invalidateQueries({ queryKey: ['channels', params.spaceId] });
      queryClient.invalidateQueries({ queryKey: ['spaces', params.spaceId] });
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
    },
  });
}

interface UpdateChannelParams {
  spaceId: string;
  channelId: string;
  channelName?: string;
  channelTopic?: string;
  isReadOnly?: boolean;
  managerRoleIds?: string[];
  icon?: string;
  iconColor?: string;
  iconVariant?: 'outline' | 'filled';
}

/**
 * Update an existing channel
 */
export function useUpdateChannel() {
  const queryClient = useQueryClient();
  const { enqueueOutbound } = useWebSocket();

  return useMutation({
    mutationFn: async (params: UpdateChannelParams): Promise<Channel> => {
      const space = getSpace(params.spaceId);
      if (!space) {
        throw new Error('Space not found');
      }

      let foundChannel: Channel | undefined;
      const updatedGroups = space.groups.map(group => ({
        ...group,
        channels: group.channels.map(channel => {
          if (channel.channelId === params.channelId) {
            foundChannel = {
              ...channel,
              channelName: params.channelName ?? channel.channelName,
              channelTopic: params.channelTopic ?? channel.channelTopic,
              isReadOnly: params.isReadOnly ?? channel.isReadOnly,
              managerRoleIds: params.managerRoleIds ?? channel.managerRoleIds,
              icon: params.icon ?? channel.icon,
              iconColor: params.iconColor ?? channel.iconColor,
              iconVariant: params.iconVariant ?? channel.iconVariant,
              modifiedDate: Date.now(),
            };
            return foundChannel;
          }
          return channel;
        }),
      }));

      if (!foundChannel) {
        throw new Error('Channel not found');
      }

      const updatedSpace: Space = {
        ...space,
        groups: updatedGroups,
        modifiedDate: Date.now(),
      };

      saveSpace(updatedSpace);
      const adapter = getMMKVAdapter();
      await adapter.saveSpace(updatedSpace);

      // Broadcast to all members (API + hub)
      enqueueOutbound(async () => {
        const result = await broadcastSpaceUpdate(updatedSpace);
        return result ? [result.wsEnvelope] : [];
      });

      return foundChannel;
    },
    onSuccess: (_, params) => {
      queryClient.invalidateQueries({ queryKey: ['channels', params.spaceId] });
      queryClient.invalidateQueries({ queryKey: ['spaces', params.spaceId] });
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
    },
  });
}

interface DeleteChannelParams {
  spaceId: string;
  channelId: string;
}

/**
 * Delete a channel from a space
 */
export function useDeleteChannel() {
  const queryClient = useQueryClient();
  const { enqueueOutbound } = useWebSocket();

  return useMutation({
    mutationFn: async (params: DeleteChannelParams): Promise<void> => {
      const space = getSpace(params.spaceId);
      if (!space) {
        throw new Error('Space not found');
      }

      // Don't allow deleting the default channel
      if (params.channelId === space.defaultChannelId) {
        throw new Error('Cannot delete the default channel');
      }

      const updatedGroups = space.groups.map(group => ({
        ...group,
        channels: group.channels.filter(c => c.channelId !== params.channelId),
      }));

      const updatedSpace: Space = {
        ...space,
        groups: updatedGroups,
        modifiedDate: Date.now(),
      };

      saveSpace(updatedSpace);
      const adapter = getMMKVAdapter();
      await adapter.saveSpace(updatedSpace);

      // Broadcast to all members (API + hub)
      enqueueOutbound(async () => {
        const result = await broadcastSpaceUpdate(updatedSpace);
        return result ? [result.wsEnvelope] : [];
      });
    },
    onSuccess: (_, params) => {
      queryClient.invalidateQueries({ queryKey: ['channels', params.spaceId] });
      queryClient.invalidateQueries({ queryKey: ['spaces', params.spaceId] });
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
    },
  });
}

interface AddGroupParams {
  spaceId: string;
  groupName: string;
  icon?: string;
  iconColor?: string;
}

/**
 * Add a new channel group to a space
 */
export function useAddGroup() {
  const queryClient = useQueryClient();
  const { enqueueOutbound } = useWebSocket();

  return useMutation({
    mutationFn: async (params: AddGroupParams): Promise<Group> => {
      const space = getSpace(params.spaceId);
      if (!space) {
        throw new Error('Space not found');
      }

      const newGroup: Group = {
        groupName: params.groupName,
        channels: [],
        icon: params.icon,
        iconColor: params.iconColor,
      };

      const updatedSpace: Space = {
        ...space,
        groups: [...space.groups, newGroup],
        modifiedDate: Date.now(),
      };

      saveSpace(updatedSpace);
      const adapter = getMMKVAdapter();
      await adapter.saveSpace(updatedSpace);

      // Broadcast to all members (API + hub)
      enqueueOutbound(async () => {
        const result = await broadcastSpaceUpdate(updatedSpace);
        return result ? [result.wsEnvelope] : [];
      });

      return newGroup;
    },
    onSuccess: (_, params) => {
      queryClient.invalidateQueries({ queryKey: ['channels', params.spaceId] });
      queryClient.invalidateQueries({ queryKey: ['spaces', params.spaceId] });
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
    },
  });
}

interface DeleteGroupParams {
  spaceId: string;
  groupIndex: number;
}

/**
 * Delete a channel group from a space
 */
export function useDeleteGroup() {
  const queryClient = useQueryClient();
  const { enqueueOutbound } = useWebSocket();

  return useMutation({
    mutationFn: async (params: DeleteGroupParams): Promise<void> => {
      const space = getSpace(params.spaceId);
      if (!space) {
        throw new Error('Space not found');
      }

      if (params.groupIndex < 0 || params.groupIndex >= space.groups.length) {
        throw new Error('Invalid group index');
      }

      // Check if group contains the default channel
      const group = space.groups[params.groupIndex];
      if (group.channels.some(c => c.channelId === space.defaultChannelId)) {
        throw new Error('Cannot delete group containing the default channel');
      }

      const updatedGroups = space.groups.filter((_, index) => index !== params.groupIndex);

      const updatedSpace: Space = {
        ...space,
        groups: updatedGroups,
        modifiedDate: Date.now(),
      };

      saveSpace(updatedSpace);
      const adapter = getMMKVAdapter();
      await adapter.saveSpace(updatedSpace);

      // Broadcast to all members (API + hub)
      enqueueOutbound(async () => {
        const result = await broadcastSpaceUpdate(updatedSpace);
        return result ? [result.wsEnvelope] : [];
      });
    },
    onSuccess: (_, params) => {
      queryClient.invalidateQueries({ queryKey: ['channels', params.spaceId] });
      queryClient.invalidateQueries({ queryKey: ['spaces', params.spaceId] });
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
    },
  });
}

interface UpdateGroupParams {
  spaceId: string;
  groupIndex: number;
  groupName?: string;
  icon?: string;
  iconColor?: string;
  iconVariant?: 'outline' | 'filled';
}

/**
 * Update an existing channel group
 */
export function useUpdateGroup() {
  const queryClient = useQueryClient();
  const { enqueueOutbound } = useWebSocket();

  return useMutation({
    mutationFn: async (params: UpdateGroupParams): Promise<Group> => {
      const space = getSpace(params.spaceId);
      if (!space) {
        throw new Error('Space not found');
      }

      if (params.groupIndex < 0 || params.groupIndex >= space.groups.length) {
        throw new Error('Invalid group index');
      }

      const group = space.groups[params.groupIndex];
      const updatedGroup: Group = {
        ...group,
        groupName: params.groupName ?? group.groupName,
        icon: params.icon ?? group.icon,
        iconColor: params.iconColor ?? group.iconColor,
        iconVariant: params.iconVariant ?? group.iconVariant,
      };

      const updatedGroups = space.groups.map((g, index) =>
        index === params.groupIndex ? updatedGroup : g
      );

      const updatedSpace: Space = {
        ...space,
        groups: updatedGroups,
        modifiedDate: Date.now(),
      };

      saveSpace(updatedSpace);
      const adapter = getMMKVAdapter();
      await adapter.saveSpace(updatedSpace);

      // Broadcast to all members (API + hub)
      enqueueOutbound(async () => {
        const result = await broadcastSpaceUpdate(updatedSpace);
        return result ? [result.wsEnvelope] : [];
      });

      return updatedGroup;
    },
    onSuccess: (_, params) => {
      queryClient.invalidateQueries({ queryKey: ['channels', params.spaceId] });
      queryClient.invalidateQueries({ queryKey: ['spaces', params.spaceId] });
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
    },
  });
}

interface MoveChannelParams {
  spaceId: string;
  channelId: string;
  fromGroupIndex: number;
  toGroupIndex: number;
  toPosition: number; // Position within the target group
}

/**
 * Move a channel between groups or reorder within a group
 */
export function useMoveChannel() {
  const queryClient = useQueryClient();
  const { enqueueOutbound } = useWebSocket();

  return useMutation({
    mutationFn: async (params: MoveChannelParams): Promise<void> => {
      const space = getSpace(params.spaceId);
      if (!space) {
        throw new Error('Space not found');
      }

      if (params.fromGroupIndex < 0 || params.fromGroupIndex >= space.groups.length) {
        throw new Error('Invalid source group index');
      }

      if (params.toGroupIndex < 0 || params.toGroupIndex >= space.groups.length) {
        throw new Error('Invalid target group index');
      }

      const fromGroup = space.groups[params.fromGroupIndex];
      const channelIndex = fromGroup.channels.findIndex(c => c.channelId === params.channelId);
      if (channelIndex === -1) {
        throw new Error('Channel not found in source group');
      }

      const channel = fromGroup.channels[channelIndex];

      // Remove from source group
      const updatedFromChannels = fromGroup.channels.filter(c => c.channelId !== params.channelId);

      // Build updated groups
      const updatedGroups = space.groups.map((group, index) => {
        if (index === params.fromGroupIndex && index === params.toGroupIndex) {
          // Moving within the same group
          const channels = [...updatedFromChannels];
          const insertPosition = Math.min(params.toPosition, channels.length);
          channels.splice(insertPosition, 0, channel);
          return { ...group, channels };
        } else if (index === params.fromGroupIndex) {
          // Source group - remove channel
          return { ...group, channels: updatedFromChannels };
        } else if (index === params.toGroupIndex) {
          // Target group - add channel
          const channels = [...group.channels];
          const insertPosition = Math.min(params.toPosition, channels.length);
          channels.splice(insertPosition, 0, channel);
          return { ...group, channels };
        }
        return group;
      });

      const updatedSpace: Space = {
        ...space,
        groups: updatedGroups,
        modifiedDate: Date.now(),
      };

      saveSpace(updatedSpace);
      const adapter = getMMKVAdapter();
      await adapter.saveSpace(updatedSpace);

      // Broadcast to all members (API + hub)
      enqueueOutbound(async () => {
        const result = await broadcastSpaceUpdate(updatedSpace);
        return result ? [result.wsEnvelope] : [];
      });
    },
    onSuccess: (_, params) => {
      queryClient.invalidateQueries({ queryKey: ['channels', params.spaceId] });
      queryClient.invalidateQueries({ queryKey: ['spaces', params.spaceId] });
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
    },
  });
}

interface ReorderGroupsParams {
  spaceId: string;
  groupOrder: number[]; // Array of group indices in new order
}

/**
 * Reorder channel groups
 */
export function useReorderGroups() {
  const queryClient = useQueryClient();
  const { enqueueOutbound } = useWebSocket();

  return useMutation({
    mutationFn: async (params: ReorderGroupsParams): Promise<void> => {
      const space = getSpace(params.spaceId);
      if (!space) {
        throw new Error('Space not found');
      }

      if (params.groupOrder.length !== space.groups.length) {
        throw new Error('Group order length mismatch');
      }

      // Validate all indices are valid and unique
      const indices = new Set(params.groupOrder);
      if (indices.size !== params.groupOrder.length) {
        throw new Error('Duplicate group indices');
      }
      for (const index of params.groupOrder) {
        if (index < 0 || index >= space.groups.length) {
          throw new Error('Invalid group index in order');
        }
      }

      const reorderedGroups = params.groupOrder.map(index => space.groups[index]);

      const updatedSpace: Space = {
        ...space,
        groups: reorderedGroups,
        modifiedDate: Date.now(),
      };

      saveSpace(updatedSpace);
      const adapter = getMMKVAdapter();
      await adapter.saveSpace(updatedSpace);

      // Broadcast to all members (API + hub)
      enqueueOutbound(async () => {
        const result = await broadcastSpaceUpdate(updatedSpace);
        return result ? [result.wsEnvelope] : [];
      });
    },
    onSuccess: (_, params) => {
      queryClient.invalidateQueries({ queryKey: ['channels', params.spaceId] });
      queryClient.invalidateQueries({ queryKey: ['spaces', params.spaceId] });
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
    },
  });
}

interface ReorderChannelsParams {
  spaceId: string;
  groupIndex: number;
  channelOrder: string[]; // Array of channel IDs in new order
}

/**
 * Reorder channels within a group
 */
export function useReorderChannels() {
  const queryClient = useQueryClient();
  const { enqueueOutbound } = useWebSocket();

  return useMutation({
    mutationFn: async (params: ReorderChannelsParams): Promise<void> => {
      const space = getSpace(params.spaceId);
      if (!space) {
        throw new Error('Space not found');
      }

      if (params.groupIndex < 0 || params.groupIndex >= space.groups.length) {
        throw new Error('Invalid group index');
      }

      const group = space.groups[params.groupIndex];

      // Validate all channel IDs are valid
      const channelMap = new Map(group.channels.map(c => [c.channelId, c]));
      if (params.channelOrder.length !== group.channels.length) {
        throw new Error('Channel order length mismatch');
      }
      for (const channelId of params.channelOrder) {
        if (!channelMap.has(channelId)) {
          throw new Error('Invalid channel ID in order');
        }
      }

      const reorderedChannels = params.channelOrder.map(id => channelMap.get(id)!);

      const updatedGroups = space.groups.map((g, index) =>
        index === params.groupIndex ? { ...g, channels: reorderedChannels } : g
      );

      const updatedSpace: Space = {
        ...space,
        groups: updatedGroups,
        modifiedDate: Date.now(),
      };

      saveSpace(updatedSpace);
      const adapter = getMMKVAdapter();
      await adapter.saveSpace(updatedSpace);

      // Broadcast to all members (API + hub)
      enqueueOutbound(async () => {
        const result = await broadcastSpaceUpdate(updatedSpace);
        return result ? [result.wsEnvelope] : [];
      });
    },
    onSuccess: (_, params) => {
      queryClient.invalidateQueries({ queryKey: ['channels', params.spaceId] });
      queryClient.invalidateQueries({ queryKey: ['spaces', params.spaceId] });
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
    },
  });
}
