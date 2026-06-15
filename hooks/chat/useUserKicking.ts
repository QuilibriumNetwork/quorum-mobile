/**
 * useUserKicking - Hook for kicking users from a space
 *
 * Confirmation is handled by the caller (KickUserModal presents a deliberate
 * confirm screen), so this hook just executes the kick. The kick operation:
 * 1. Generating new config keypair
 * 2. Updating space registration with new config key
 * 3. Removing user from all roles
 * 4. Re-encrypting and posting space manifest
 * 5. Sending rekey messages to remaining members
 * 6. Sending kick notification to kicked user
 * 7. Marking user as kicked locally
 */

import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/context';
import { useWebSocket } from '@/context/WebSocketContext';
import { kickUser as kickUserService } from '@/services/space/spaceService';

interface UseUserKickingOptions {
  spaceId: string | undefined;
}

export function useUserKicking(options: UseUserKickingOptions) {
  const { spaceId } = options;
  const [kicking, setKicking] = useState(false);

  const queryClient = useQueryClient();
  const { enqueueOutbound } = useWebSocket();
  const { user } = useAuth();

  /**
   * Execute the kick operation with full cryptographic rekey
   */
  const kickUserFromSpace = useCallback(
    async (userAddress: string, onSuccess?: () => void) => {
      if (!spaceId || !userAddress || !user?.address) return;

      setKicking(true);
      try {
        // Call the full kick service which handles:
        // - New config key generation
        // - Space registration update
        // - Role removal
        // - Manifest update
        // - Rekey messages to remaining members
        // - Kick notification to kicked user
        // - Local state update
        const result = await kickUserService({
          spaceId,
          userAddress,
          selfAddress: user.address,
        });

        if (!result.success) {
          throw new Error('Kick operation failed');
        }

        // Send all WebSocket envelopes
        if (result.wsEnvelopes.length > 0) {
          enqueueOutbound(async () => result.wsEnvelopes);
        }

        // Invalidate queries to refresh UI
        await queryClient.invalidateQueries({
          queryKey: ['spaceMembers', spaceId],
        });
        await queryClient.invalidateQueries({
          queryKey: ['roles', spaceId],
        });
        await queryClient.invalidateQueries({
          queryKey: ['spaces'],
        });

        if (onSuccess) {
          onSuccess();
        }
      } catch (error) {
        throw error;
      } finally {
        setKicking(false);
      }
    },
    [spaceId, user?.address, queryClient, enqueueOutbound]
  );

  return {
    kicking,
    kickUserFromSpace,
  };
}
