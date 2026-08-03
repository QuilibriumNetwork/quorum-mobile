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
 * **One exception, and it is load-bearing: a row whose `inbox_address` is empty.**
 * `leave` does not delete the member row, it blanks the anchor to mark the member
 * inactive. Refusing to repoint an empty anchor would mean a member who leaves and is
 * later re-invited keeps an empty one forever, so their messages never resolve to a
 * known signer again — breaking an ordinary flow in the name of protecting nothing.
 * An empty anchor has no live identity to poison, so a join may set it.
 *
 * That does leave a narrow hole: a forged join for someone who has genuinely left
 * could claim their address with the sender's inbox. It is strictly narrower than the
 * behaviour it replaces (which allowed exactly that for *every* member, departed or
 * not), and closing it properly needs the signature and DKG checks that later layers
 * add. `leave` itself is already verified, so an attacker cannot manufacture this
 * state — they can only exploit a departure that really happened.
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
    // Empty anchor = the member had left. Restoring it is what makes re-invite work.
    const reanchor = existing.inbox_address ? {} : { inbox_address: participant.inboxAddress };
    return { ...existing, ...displayFields, ...reanchor };
  }

  return {
    address: participant.address,
    inbox_address: participant.inboxAddress,
    ...displayFields,
  };
}
