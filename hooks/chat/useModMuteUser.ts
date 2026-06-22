/**
 * useModMuteUser — MODERATION mute/unmute of a user in a space.
 *
 * A moderator with the `user:mute` role permission broadcasts a `MuteMessage`;
 * every client re-validates the sender's permission on receive (see the receive
 * pipeline in WebSocketContext) and, if valid, records the mute so the user's
 * messages are dropped and their composer is disabled — for everyone.
 *
 * This is the role-gated moderation action, NOT the personal viewer-side hide
 * (that's hooks/chat/useBlockUser.ts). Naming scheme: Block = personal,
 * Mute = moderation.
 *
 * The hook mirrors useDeleteSpaceMessage (another control-message sender):
 * sendMuteMessage → enqueueOutbound([wsEnvelope]). We also write the local mute
 * store optimistically so the muting moderator's own UI reflects it immediately
 * (own echoes are filtered on receive, so the broadcast won't re-apply it).
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { MuteMessage } from '@quilibrium/quorum-shared';
import { useAuth, useWebSocket } from '@/context';
import { sendMuteMessage } from '@/services/space/spaceMessageService';
import { setMute, removeMute } from '@/services/space/modMuteStorage';

export interface ModMuteParams {
  spaceId: string;
  channelId: string;
  targetUserId: string;
  /** Mute duration in DAYS. 0 / undefined = forever. Ignored for unmute. */
  days?: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function useModMuteUser() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { enqueueOutbound, isConnected } = useWebSocket();

  const mute = useMutation({
    mutationFn: async (params: ModMuteParams) => {
      if (!user?.address) throw new Error('User must be logged in to mute');
      if (!isConnected) throw new Error('Not connected to server. Please wait for connection.');

      const days = params.days ?? 0;
      const duration = days > 0 ? days * MS_PER_DAY : undefined;
      const now = Date.now();

      const result = await sendMuteMessage({
        spaceId: params.spaceId,
        channelId: params.channelId,
        targetUserId: params.targetUserId,
        senderAddress: user.address,
        action: 'mute',
        duration,
      });

      // Optimistic local record so the moderator's UI reflects it immediately
      // (own echoes are filtered on receive, so this local write is what the
      // moderator sees). Use the REAL muteId from the sent content so the record
      // and the replay-guard key match the authoritative broadcast — avoids an
      // orphaned `local-*` key and keeps `lastMuteId` accurate.
      const sentMuteId = (result.message.content as MuteMessage).muteId;
      setMute({
        spaceId: params.spaceId,
        targetUserId: params.targetUserId,
        mutedAt: now,
        mutedBy: user.address,
        lastMuteId: sentMuteId,
        expiresAt: duration !== undefined ? now + duration : undefined,
      });

      enqueueOutbound(async () => [result.wsEnvelope]);
      return params.targetUserId;
    },
    onSettled: (_data, _err, params) => {
      queryClient.invalidateQueries({ queryKey: ['mutedUsers', params.spaceId] });
    },
  });

  const unmute = useMutation({
    mutationFn: async (params: ModMuteParams) => {
      if (!user?.address) throw new Error('User must be logged in to unmute');
      if (!isConnected) throw new Error('Not connected to server. Please wait for connection.');

      const result = await sendMuteMessage({
        spaceId: params.spaceId,
        channelId: params.channelId,
        targetUserId: params.targetUserId,
        senderAddress: user.address,
        action: 'unmute',
      });

      removeMute(params.spaceId, params.targetUserId);
      enqueueOutbound(async () => [result.wsEnvelope]);
      return params.targetUserId;
    },
    onSettled: (_data, _err, params) => {
      queryClient.invalidateQueries({ queryKey: ['mutedUsers', params.spaceId] });
    },
  });

  return {
    muteUser: mute.mutateAsync,
    unmuteUser: unmute.mutateAsync,
    muting: mute.isPending || unmute.isPending,
  };
}
