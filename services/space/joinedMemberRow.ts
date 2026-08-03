import type { SpaceMember } from '@quilibrium/quorum-shared';

/**
 * The fields a `join` control message carries about the participant.
 *
 * Only the subset this module is allowed to act on. The payload also carries
 * ratchet material (`pubKey`, `inboxKey`, `identityKey`, `preKey`, `id`) and a
 * signature pair, none of which belong in a member row.
 */
export interface JoinParticipant {
  address: string;
  inboxAddress: string;
  userIcon?: string;
  displayName?: string;
  /** Present on the wire inside the signed blob; only ever used for a brand-new row. */
  joinedAt?: number;
}

/**
 * Build the member row to store for an incoming `join`, merging into the existing
 * row rather than replacing it.
 *
 * **A `join` is unauthenticated.** Anyone able to send into the space — every current
 * member, and anyone who left voluntarily but kept the hub and config keys — can send
 * one naming any address. The receive handler does not verify the `inboxSignature`
 * that rides along on the wire (that is a later layer of the fix), so nothing here may
 * assume the sender is who they claim to be.
 *
 * `adapter.saveSpaceMember` overwrites the whole row. The handler used to hand it a
 * fresh four-field object, which erased everything else on an existing member and gave
 * an attacker three things for free:
 *
 * 1. **Un-kicking.** `isKicked: true` simply disappeared, silently restoring someone
 *    the owner removed — on every member's device, not just the sender's.
 * 2. **Poisoning signature verification.** `inbox_address` was repointed to whatever
 *    the sender chose. `resolveVerifiedSender` matches members on `inbox_address`, so
 *    the real member's genuine messages stopped resolving to a known signer, and
 *    stayed that way.
 * 3. **Losing `joinedAt`**, which ordering and the join-bound checks depend on.
 *
 * So: an existing row keeps its identity anchor (`inbox_address`), its moderation
 * state (`isKicked`) and its history (`joinedAt`), and only the display fields a join
 * legitimately carries are applied. A row that does not exist yet is taken at face
 * value — there is nothing to protect, and refusing it would break ordinary joins.
 *
 * Display fields are applied only when present, so a join that omits them does not
 * blank a name or avatar the member already has. An explicit empty string still
 * clears, matching how a per-space profile override is cleared elsewhere.
 *
 * Re-admitting a genuinely kicked member is a real flow, but it has to go through an
 * actual re-admission — not an unauthenticated frame that anyone can send.
 *
 * ## An existing row's anchor is NEVER repointed, empty or not
 *
 * A first version of this function made an exception for a row whose `inbox_address`
 * was empty, reasoning that only a verified `leave` blanks an anchor, so an empty one
 * had no live identity to poison. **Both halves of that were wrong**, and independent
 * review caught it after it shipped (#221, reverted here):
 *
 * - `kick` blanks the anchor too (`WebSocketContext.tsx` `case 'kick'`, and the
 *   `verify-kicked` and `rekey` paths), so ordinary moderation leaves blank anchors
 *   lying around indefinitely, not just rare departures.
 * - Far worse, an attacker can **manufacture** a blank anchor at will. The
 *   `update-profile` handler upserts a row for any claimed `senderId` it has never
 *   seen, with `inbox_address: ''`, and `isUpdateProfileAuthorized` accepts a
 *   signature from an unknown key outright (it treats it as a key-rotation
 *   announcement). So: self-sign an `update-profile` claiming a victim's address to
 *   mint a blank-anchored row, then send a forged `join` to bind your own key as that
 *   victim's anchor. The victim's genuine `join` can then never correct it, because
 *   the anchor is no longer empty. That is a full identity hijack, reachable with
 *   exactly the hub + config keys this function's threat model already assumes.
 *
 * So there is no exception. An existing row keeps its anchor unconditionally.
 *
 * **Known limitation, accepted deliberately:** a member who leaves (or is kicked) and
 * is later re-invited keeps an empty anchor, so their messages will not resolve to a
 * known signer until something authorised repoints it. Repointing it safely needs the
 * signature check from Layer 2 of the join fix — an authenticated join may move an
 * anchor; an unauthenticated one may not. Being unresolvable is a broken flow; the
 * alternative was a hijack primitive, and the spec's exception-free rule was right.
 */
export function buildJoinedMemberRow(
  existing: SpaceMember | undefined,
  participant: JoinParticipant
): SpaceMember {
  const displayFields = {
    ...(participant.displayName !== undefined
      ? { display_name: participant.displayName }
      : {}),
    ...(participant.userIcon !== undefined
      ? { profile_image: participant.userIcon }
      : {}),
  };

  if (existing) {
    return { ...existing, ...displayFields };
  }

  return {
    address: participant.address,
    inbox_address: participant.inboxAddress,
    // The wire carries joinedAt inside the signed blob; it was being dropped at the
    // parse boundary, so every new member row was stored without one. Ordering and the
    // join-bound checks read it.
    ...(participant.joinedAt !== undefined ? { joinedAt: participant.joinedAt } : {}),
    ...displayFields,
  };
}
