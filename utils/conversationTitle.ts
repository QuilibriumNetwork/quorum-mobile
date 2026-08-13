/**
 * The name a DM shows for the person you are talking to.
 *
 * Two surfaces need this and must not disagree: the row in the Messages tab
 * and the header inside the conversation. They had the same logic written out
 * twice, which is how the list kept rendering a global name for weeks after the
 * header learned to render a `.q`.
 *
 * ## A conversation's `displayName` is a GLOBAL name, not an override
 *
 * A DM cannot be renamed — there is no UI for it, and `dmProfileService` fills
 * `displayName` from the partner's own broadcast profile. So it belongs in the
 * global tier. Filing it as a per-space override (which is what "it is on the
 * conversation row, so it is this conversation's name" suggests) ranks it above
 * the partner's `.q` and the `.q` can then never show. That was the bug.
 *
 * ## Why the address fallback is not the resolver's
 *
 * `resolveMemberName` falls back to `truncateAddress(address)` in its default
 * `medium` preset. Both DM surfaces have always used `long`, and a row is wide
 * enough for it. So the caller-visible fallback stays here, keyed off
 * `isAddressFallback` rather than string-comparing the resolved name — the
 * resolver already tells us plainly when it knows nobody.
 *
 * ## Why this stays on `@/utils/resolveMemberName`, not `@/identity`
 *
 * Deliberately a plain, hook-free function rather than `useResolvedName` —
 * unlike a component, it carries no assumption about running inside a React
 * tree, so it stays callable from anywhere a conversation's title is needed,
 * including a future non-React caller on the WebSocket receive path (where a
 * hook, and the network verification it triggers, would not be reachable at
 * all). That generality has a cost: `resolveMemberName` performs no
 * verification of its own, so `primary_username` here is the CALLER's claim
 * to have already verified it, not a guarantee this function makes.
 *
 * Both of today's callers honor that contract: `app/(tabs)/messages/index.tsx`
 * passes rows already through `useConversationsWithQnsNames` (which ends in
 * `useVerifiedQnsNames`), and `app/(tabs)/messages/dm/[id].tsx`'s header runs
 * its own `useVerifiedQnsNames` pass before calling this. Neither is reachable
 * from `logMentionOrReply.ts` or `WebSocketContext.tsx` — the DM receive path
 * titles a notification row with a separately computed global-name-only
 * string instead (see `logDirectMessage`'s `senderName`), never through this
 * function. A hypothetical WebSocket-handler caller of this file would need to
 * either omit `primary_username` entirely, degrading to the global name like
 * `messagePreview.ts`/`logMentionOrReply.ts` already do, or verify the claim
 * itself by some other means — this function has no way to do that for it.
 */

import { formatResolvedName, resolveMemberName } from './resolveMemberName';
import { truncateAddress } from './formatAddress';

export interface ConversationIdentity {
  address?: string;
  /** The partner's GLOBAL display name, as broadcast by them. */
  displayName?: string;
  /** The partner's QNS `.q`, which travels only in their public profile. */
  primary_username?: string;
}

/**
 * Resolve a DM's title. `emptyLabel` is what to show when there is not even an
 * address to truncate — the list says "Conversation", and so does the header.
 */
export function resolveConversationTitle(
  conversation: ConversationIdentity | undefined,
  emptyLabel = 'Conversation',
): string {
  const address = conversation?.address;
  if (!address) return emptyLabel;

  const resolved = resolveMemberName({
    address,
    global_display_name: conversation?.displayName,
    primary_username: conversation?.primary_username,
  });

  return resolved.isAddressFallback
    ? truncateAddress(address, 'long')
    : formatResolvedName(resolved);
}
