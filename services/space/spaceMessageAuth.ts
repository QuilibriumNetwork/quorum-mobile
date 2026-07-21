/*
 * SpaceMessageAuth - Receive-side signature verification and authorization
 * for space messages.
 *
 * The ONLY per-message sender proof in a space is the ed448 signature over the
 * message fingerprint (spaces are many-party: group decrypt identifies no
 * author, and the plaintext `content.senderId` is written by the sender's
 * client, so a modified client can claim any identity). Every receive-side
 * permission decision must therefore run against the VERIFIED signer:
 *
 *   verify ed448(signature, fingerprint-hash, publicKey)   -- key holds message
 *   inboxAddress = base58btc(multihash(sha256(publicKey))) -- identity from key
 *   sender = space member whose inbox_address matches       -- REVERSE lookup
 *
 * The reverse lookup is the critical shape: resolving the member FROM the key
 * makes a missing/kicked member fail closed by construction and removes the
 * spoofable `senderId` as an auth input entirely. Never look up the member BY
 * the claimed senderId and compare - that is bypassable whenever the claimed
 * member's row is missing locally (common; see the space-members-missing bug).
 *
 * Mirrors desktop MessageService.ts (isSpaceControlAuthorized /
 * isReadOnlyPostAuthorized, desktop PR #241). The authorization verdicts
 * themselves live in quorum-shared (`authorizeControlMessage`) so the two
 * platforms can never disagree about whether a control message is honored.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import {
  authorizeControlMessage,
  buildMessageFingerprint,
  bytesToHex,
  canManageReadOnlyChannel,
  deriveInboxAddress,
  hexToBytes,
  isControlMessageType,
  logger,
  resolveVerifiedSender,
  type Channel,
  type ControlMessageContent,
  type ControlMessageVerdict,
  type Message,
  type Space,
  type SpaceMember,
  type VerifiedSender,
} from '@quilibrium/quorum-shared';
import { NativeSigningProvider } from '../crypto/native-signing-provider';
import { getMMKVAdapter } from '../storage/mmkvAdapter';

export type { ControlMessageVerdict, VerifiedSender };

// Loop instead of spread to avoid stack overflow on large arrays (same pattern
// as spaceMessageService).
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Verify a space message's ed448 signature against its recomputed fingerprint.
 *
 * Recomputes the canonical fingerprint (shared `buildMessageFingerprint`, which
 * scope-binds spaceId+channelId for control types so a signed control message
 * can't be replayed into another space/channel), checks the wire messageId
 * matches its hash, and runs the native ed448 verify over the hash bytes.
 *
 * The fingerprint is computed against the CONTEXT spaceId (the space whose
 * hub/inbox delivered the message - the space the handlers will apply it to),
 * not the wire `message.spaceId`, so the scope a signature attests is always
 * the scope it takes effect in.
 *
 * Returns the signer's hex public key on success, null on missing/invalid
 * signature or any error (fail closed). This proves key possession only - it
 * does NOT bind the key to a member. Use `resolveVerifiedSpaceSender` for
 * authorization decisions; the bare form exists for update-profile, where the
 * message IS a key-rotation announcement so a member binding can't be required.
 */
export async function verifySpaceMessageSignature(
  message: Message,
  spaceId: string
): Promise<string | null> {
  try {
    const { publicKey, signature, nonce, messageId } = message;
    const senderId = (message.content as { senderId?: string })?.senderId;
    if (!publicKey || !signature || !nonce || !messageId || !senderId) {
      return null;
    }

    const fingerprint = buildMessageFingerprint({
      nonce,
      content: message.content as Parameters<
        typeof buildMessageFingerprint
      >[0]['content'],
      senderId,
      spaceId,
      channelId: message.channelId ?? '',
    });
    const hashBytes = sha256(new TextEncoder().encode(fingerprint));

    // The wire messageId must equal the fingerprint hash - otherwise the
    // signature (over the hash) attests different content/scope than claimed.
    if (bytesToHex(hashBytes) !== messageId) {
      return null;
    }

    const signingProvider = new NativeSigningProvider();
    const isValid = await signingProvider.verifyEd448(
      bytesToBase64(Uint8Array.from(hexToBytes(publicKey))),
      bytesToBase64(hashBytes),
      bytesToBase64(Uint8Array.from(hexToBytes(signature)))
    );
    return isValid ? publicKey : null;
  } catch {
    // canonicalize throws on unknown content types; malformed hex throws in
    // conversion. All failures are a verification failure - fail closed.
    return null;
  }
}

/**
 * Resolve the cryptographically verified sender of a space message: signature
 * verification + reverse key-to-member lookup. Null on any failure (unsigned,
 * invalid signature, key matches no active member) - callers fail closed.
 *
 * `content.senderId` plays no role here beyond being bound inside the signed
 * fingerprint; it remains display metadata only.
 */
export async function resolveVerifiedSpaceSender(
  message: Message,
  spaceId: string,
  members?: SpaceMember[]
): Promise<VerifiedSender | null> {
  const publicKey = await verifySpaceMessageSignature(message, spaceId);
  if (!publicKey) return null;
  const adapter = getMMKVAdapter();
  const memberList = members ?? (await adapter.getSpaceMembers(spaceId));
  // Also admit per-device signing keys announced via master-signed statements.
  const deviceKeys = await adapter.getSpaceMemberDevices(spaceId);
  const resolved = resolveVerifiedSender(publicKey, memberList, deviceKeys);
  // Diagnostic: flag when a signer resolved via a per-device key rather than the
  // member join binding (rollout monitoring; remove at cleanup).
  if (resolved) {
    const signingAddr = deriveInboxAddress(publicKey);
    const viaMember = memberList.some(
      (m) => m.inbox_address === signingAddr && !(m as { isKicked?: boolean }).isKicked
    );
    if (!viaMember) {
      logger.log(
        `[DeviceKeys] signature accepted via per-device key signingAddr=${signingAddr.slice(0, 12)} sender=${String(resolved).slice(0, 12)}`
      );
    }
  }
  return resolved;
}

/**
 * The single allow/drop verdict for a space control message (remove-message /
 * edit-message / mute; pin when mobile grows a pin handler). Resolves the
 * verified sender, then delegates to shared `authorizeControlMessage`, which
 * requires the signature regardless of `space.isRepudiable` (with the one
 * documented exception: an unsigned edit of an unsigned message in a
 * repudiable space, claimed by the target's author).
 */
export async function authorizeSpaceControlMessage(params: {
  message: Message;
  spaceId: string;
  space: Space | undefined;
  channel: Channel | undefined;
  targetMessage?: Message;
  /** Preloaded member list (batch catch-up passes one per space so hundreds
   *  of control messages don't re-parse the member blob each). */
  members?: SpaceMember[];
}): Promise<ControlMessageVerdict> {
  const { message, spaceId, space, channel, targetMessage, members } = params;
  const contentType = message.content?.type;
  if (!contentType || !isControlMessageType(contentType)) {
    return { allowed: false, reason: 'unknown-control-type' };
  }
  const verifiedSender = await resolveVerifiedSpaceSender(message, spaceId, members);
  return authorizeControlMessage({
    content: message.content as ControlMessageContent,
    verifiedSender,
    space,
    channel,
    targetMessage,
  });
}

/**
 * Read-only channel post acceptance: a post/embed/sticker lands in a read-only
 * channel only when its VERIFIED signer is a manager of that channel. Unsigned
 * or unverifiable posts are dropped - posting into a read-only channel is a
 * privileged operation, so the signature is required regardless of
 * repudiability (parity with desktop's isReadOnlyPostAuthorized, live path).
 */
export async function isReadOnlyPostAuthorized(
  message: Message,
  spaceId: string,
  space: Space | undefined,
  channel: Channel | undefined,
  members?: SpaceMember[]
): Promise<boolean> {
  const verifiedSender = await resolveVerifiedSpaceSender(message, spaceId, members);
  if (!verifiedSender) return false;
  return canManageReadOnlyChannel(verifiedSender, false, space, channel);
}

/**
 * update-profile acceptance. A profile update rewrites a member's display
 * identity AND doubles as their inbox key-rotation announcement, which forces
 * a weaker rule than control messages: a rotated key legitimately matches no
 * member row yet, so the strict reverse binding of `resolveVerifiedSpaceSender`
 * would permanently block every profile update after a rotation.
 *
 * Rule: signature required and valid (unsigned/invalid → drop, desktop
 * parity), PLUS a known-key binding — when the signing key DOES map to an
 * existing member row, the claimed senderId must be that member. This kills
 * the cheap impersonation (a member signing with their own registered key
 * while claiming someone else's senderId) while leaving genuine rotations
 * (unknown key) accepted exactly as desktop does.
 *
 * Deliberately NOT mirrored from desktop: writing the announced key's inbox
 * address onto the claimed member's row. Accepting an unproven key→member
 * binding into the same table `resolveVerifiedSender` authorizes against
 * would let a forged update-profile impersonate that member for CONTROL
 * messages afterwards. Mobile member rows keep the join-broadcast binding.
 */
export async function isUpdateProfileAuthorized(
  message: Message,
  spaceId: string,
  members?: SpaceMember[]
): Promise<boolean> {
  const publicKey = await verifySpaceMessageSignature(message, spaceId);
  if (!publicKey) return false;
  const senderId = (message.content as { senderId?: string })?.senderId;
  if (!senderId) return false;
  const memberList =
    members ?? (await getMMKVAdapter().getSpaceMembers(spaceId));
  const inboxAddress = deriveInboxAddress(publicKey);
  const keyOwner = memberList.find(
    (m) => m.inbox_address && m.inbox_address === inboxAddress
  );
  if (!keyOwner) return true; // unknown key: rotation announcement, accept
  const ownerAddress = keyOwner.address || keyOwner.user_address;
  return ownerAddress === senderId;
}

/**
 * Whether an incoming message's `mentions.everyone` flag must be stripped
 * before the message is stored/logged. True (strip) unless the message's
 * verified signer exists AND matches the claimed `content.senderId`.
 *
 * `mentions` is not covered by the signed fingerprint, so the signature can't
 * attest the flag itself - but the threat is the SENDER's modified client
 * setting the flag, and the sender is the signer. Anchoring senderId to the
 * verified key makes the existing downstream role gate sound
 * (`isMentionedWithSettings` already requires `senderId` to hold
 * `mention:everyone`; the missing piece was that senderId was spoofable).
 * @everyone-bearing posts are verified regardless of repudiability - an
 * unsigned post keeps its text but loses the space-wide notification.
 */
export async function shouldStripEveryoneMention(
  message: Message,
  spaceId: string,
  members?: SpaceMember[]
): Promise<boolean> {
  if (message.mentions?.everyone !== true) return false;
  const senderId = (message.content as { senderId?: string })?.senderId;
  if (!senderId) return true;
  const verifiedSender = await resolveVerifiedSpaceSender(message, spaceId, members);
  // Strip when unverifiable OR when the signing key belongs to someone other
  // than the claimed sender. (VerifiedSender is a branded string, so the
  // runtime comparison is plain string equality.)
  return verifiedSender === null || verifiedSender !== senderId;
}
