/**
 * The Farcaster/fallback half of the name a DM shows for the person you are
 * talking to — the `.q`-carrying half now lives in `@/identity`.
 *
 * ## History
 *
 * This function used to resolve the WHOLE ladder, including a `primary_username`
 * the caller was trusted to have already verified. That was a caller-discipline
 * guarantee, not a structural one: nothing about this function's type or logic
 * stopped a future caller from handing it an unverified claim and getting an
 * unverified `.q` rendered. Both of its two real callers (`app/(tabs)/messages/index.tsx`,
 * `app/(tabs)/messages/dm/[id].tsx`) did verify first, but "every caller happens
 * to remember" is exactly the soft guarantee this whole identity migration
 * exists to replace with something structural.
 *
 * Both callers now resolve a Quorum conversation's name through `@/identity`
 * directly (`useResolvedMemberName`/`useNameResolver`, `global: true`, which
 * verifies before a `.q` can appear) and only fall back to this function for
 * two cases neither of which can ever legitimately carry a `.q`:
 *
 * - **No address yet** — `emptyLabel` ("Conversation").
 * - **A Farcaster conversation** — `address` is a synthetic `fid:<n>` string,
 *   never a Quorum address, and `displayName` is Farcaster's OWN field. Routing
 *   it through `@/identity` would treat the fid string as a member address and
 *   could render somebody else's name; Farcaster has no QNS tier at all, so
 *   there is nothing to verify here either way.
 *
 * `ConversationIdentity` no longer has a `primary_username` field — removed
 * rather than merely stopped-reading, so a future caller cannot silently
 * regress into passing an unverified claim through it again. The QNS tier
 * structurally cannot reach this function any more.
 *
 * ## A conversation's `displayName` is a GLOBAL name, not an override
 *
 * A DM cannot be renamed — there is no UI for it, and `dmProfileService` fills
 * `displayName` from the partner's own broadcast profile. So it belongs in the
 * global tier. Filing it as a per-space override (which is what "it is on the
 * conversation row, so it is this conversation's name" suggests) ranks it above
 * the partner's `.q` and the `.q` can then never show. That was the original bug
 * this function fixed, and it still applies to the Farcaster case.
 *
 * ## Why the address fallback is not the resolver's
 *
 * `resolveMemberName` falls back to `truncateAddress(address)` in its default
 * `medium` preset. This function has always used `long` for it instead — a row
 * is wide enough — keyed off `isAddressFallback` rather than string-comparing
 * the resolved name, since the resolver already tells us plainly when it knows
 * nobody.
 *
 * ## Why this stays a plain function, not a hook
 *
 * `resolveMemberName` (still used here, just never handed a QNS claim) needs no
 * network access for the two cases this function now covers, so there is
 * nothing gained by making this a hook — it stays callable from anywhere,
 * including a plain data-shaping context with no component above it.
 */

import { formatResolvedName, resolveMemberName } from './resolveMemberName';
import { truncateAddress } from './formatAddress';

export interface ConversationIdentity {
  address?: string;
  /** The partner's GLOBAL display name, as broadcast by them, OR a Farcaster
   *  conversation's own display name. Never a Quorum `.q` — that tier is
   *  resolved by the caller through `@/identity` before reaching here. */
  displayName?: string;
}

/**
 * Resolve a DM's title for the cases that cannot carry a `.q`: no address yet,
 * or a Farcaster conversation. `emptyLabel` is what to show when there is not
 * even an address to truncate — the list says "Conversation", and so does the
 * header.
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
  });

  return resolved.isAddressFallback
    ? truncateAddress(address, 'long')
    : formatResolvedName(resolved);
}
