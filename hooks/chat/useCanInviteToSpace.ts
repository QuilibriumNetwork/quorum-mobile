import { useMemo } from 'react';
import { useSpace } from './useSpaces';
import { holdsSpaceOwnerKey } from '@/services/config/spaceStorage';
import { isPublicInvite } from '@/services/space/inviteService';

/**
 * Who may open the invite surface for a Space.
 *
 * An owner always may, since they can mint links. A regular member may only
 * when the Space already has a usable public link: sharing the owner's public
 * link is a capability the product wants, but minting either kind of link is
 * owner-only. With no link there is nothing for a member to do in the invite
 * modal, so the entry point is hidden rather than opening a dead end.
 *
 * The link half goes through `isPublicInvite` and NOT a truthiness check on
 * `inviteUrl`. `kickUser` overwrites that same field with a
 * `quorum://join#spaceId=…` value (`services/space/spaceService.ts`), which is
 * truthy and completely unusable — a truthiness gate would hand every member a
 * dead link to share after any kick.
 *
 * Reads the Space through React Query rather than straight from storage so the
 * affordance appears the moment a newly published link arrives over the wire:
 * the `space-manifest` handler writes the record into
 * `queryKeys.spaces.detail` (`context/WebSocketContext.tsx`). Reading MMKV here
 * instead would leave a member's invite pill hidden until the screen remounted.
 *
 * This rule is destined for quorum-shared as
 * `canInviteToSpace({ isOwner, inviteUrl })` so the two clients cannot drift
 * apart a third time; this hook is where mobile will call it from.
 */
export function useCanInviteToSpace(spaceId: string | undefined): boolean {
  const { data: space } = useSpace(spaceId, { enabled: !!spaceId });
  const inviteUrl = space?.inviteUrl;

  return useMemo(() => {
    if (!spaceId) return false;
    // Synchronous MMKV read. Ownership of a given Space cannot change while the
    // app is running, so it needs no reactive source.
    if (holdsSpaceOwnerKey(spaceId)) return true;
    return isPublicInvite(inviteUrl ?? '');
  }, [spaceId, inviteUrl]);
}
