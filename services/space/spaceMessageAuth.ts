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
import { getQuorumClient } from '../api/quorumClient';
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

/* ------------------------------------------------------------------------ *
 * Outer-envelope authentication for privileged control messages
 *
 * Everything above authenticates the INNER message via its own ed448
 * signature. The two functions below authenticate the OUTER frame instead,
 * for the control messages that carry no inner signature at all:
 *
 *   kick / rekey   → owner-signed on the sync envelope  (verifyOwnerSealedEnvelope)
 *   leave          → self-signed by the leaver's inbox key (resolveVerifiedLeaver)
 *   join           → self-signed over the participant blob (verifyJoinParticipant)
 *
 * Decrypting one of these proves nothing about who sent it: the config key,
 * the hub keypair and every member's inbox address are all held by anyone who
 * has ever been in the space, including members who were later kicked.
 * ------------------------------------------------------------------------ */

/**
 * Outcome of checking the owner signature on a sync-sealed envelope.
 *
 * Three states rather than a boolean, because dropping a genuine rekey locks a
 * real member out of the space for good: "the registration endpoint could not
 * be reached" must never collapse into "this message is forged". Callers apply
 * on `valid`, discard on `invalid`, and on `indeterminate` discard but leave
 * the message in the inbox so a later reconnect redelivers it.
 */
export type OwnerEnvelopeVerdict = 'valid' | 'invalid' | 'indeterminate';

/** The outer-frame fields sealSyncEnvelope attaches (SyncSealedMessage subset). */
export interface OwnerSealedEnvelopeFields {
  owner_public_key?: string;
  owner_signature?: string;
  envelope?: string;
}

/**
 * How long a space's owner-key list is reused without re-asking the server.
 * A reconnect catch-up can carry many control messages for one space; without
 * this each one costs its own round-trip before it can even be rejected.
 */
const REGISTRATION_CACHE_MS = 30_000;

/**
 * Floor between fetches for the same space. An unrecognised owner key forces a
 * refetch (see below), so without a floor a flood of forged messages would
 * become one request per message — the amplification the cache exists to stop.
 */
const REGISTRATION_REFETCH_FLOOR_MS = 5_000;

const registrationCache = new Map<
  string,
  { ownerPublicKeys: string[]; fetchedAt: number }
>();

function readRegistrationCache(spaceId: string) {
  const entry = registrationCache.get(spaceId);
  if (!entry) return undefined;
  if (Date.now() - entry.fetchedAt > REGISTRATION_CACHE_MS) {
    registrationCache.delete(spaceId);
    return undefined;
  }
  return entry;
}

/**
 * Verify the space owner's ed448 signature on the outer sync envelope.
 *
 * Two gates, both required, matching desktop MessageService (its kick and
 * rekey branches) and the SDK's `SealSyncEnvelope` send side:
 *
 *   1. `owner_public_key` must appear in the space registration's
 *      `owner_public_keys` — a valid signature by a key nobody registered is
 *      worthless.
 *   2. The signature must verify over `base64(utf8Bytes(envelope))`, which is
 *      byte-for-byte what the sender signed.
 *
 * Which verdict a failure earns matters more than it looks, because `invalid`
 * lets the caller ack the message — and an acked-but-unapplied rekey locks a
 * real member out of the space for good. So:
 *
 *   - Server says the space is gone (404/410) → `invalid`. Authoritative, and
 *     retrying forever on a deleted space helps nobody.
 *   - Server unreachable for any other reason → `indeterminate`. Keep it.
 *   - Owner key missing from our CACHED copy → never rejected on that basis
 *     alone. Refetch, or if rate-limited, return `indeterminate` so the message
 *     survives to be judged against fresh data.
 *   - Owner key missing from a FRESH copy → `invalid`. That is a forgery.
 */
export async function verifyOwnerSealedEnvelope(
  sealed: OwnerSealedEnvelopeFields | null | undefined,
  spaceId: string
): Promise<OwnerEnvelopeVerdict> {
  const ownerPublicKey = sealed?.owner_public_key;
  const ownerSignature = sealed?.owner_signature;
  const envelope = sealed?.envelope;
  if (!ownerPublicKey || !ownerSignature || !envelope) return 'invalid';

  const cached = readRegistrationCache(spaceId);

  if (!cached?.ownerPublicKeys.includes(ownerPublicKey)) {
    // Either nothing cached, or a key this copy doesn't know. A cached list can
    // predate an owner-key rotation, and rejecting on it would delete a genuine
    // message, so get authoritative data before deciding either way.
    if (cached && Date.now() - cached.fetchedAt < REGISTRATION_REFETCH_FLOOR_MS) {
      logger.warn(
        `[owner-envelope] space=${spaceId.slice(0, 12)}: owner key not in cached registration and refetch is rate-limited; keeping the message for retry`
      );
      return 'indeterminate';
    }

    let ownerPublicKeys: string[];
    try {
      const registration = await getQuorumClient().getSpaceRegistration(spaceId);
      ownerPublicKeys = registration?.owner_public_keys ?? [];
      registrationCache.set(spaceId, { ownerPublicKeys, fetchedAt: Date.now() });
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status === 404 || status === 410) {
        // The space does not exist server-side. Nothing will ever verify against
        // it, so let the caller drop and ack rather than retry forever.
        registrationCache.delete(spaceId);
        logger.warn(
          `[owner-envelope] space=${spaceId.slice(0, 12)}: no such space server-side (HTTP ${status}); dropping`
        );
        return 'invalid';
      }
      logger.warn(
        `[owner-envelope] space=${spaceId.slice(0, 12)}: registration unreachable, cannot verify (${err instanceof Error ? err.message : String(err)})`
      );
      return 'indeterminate';
    }

    if (!ownerPublicKeys.includes(ownerPublicKey)) return 'invalid';
  }

  try {
    const signingProvider = new NativeSigningProvider();
    const isValid = await signingProvider.verifyEd448(
      bytesToBase64(Uint8Array.from(hexToBytes(ownerPublicKey))),
      bytesToBase64(new TextEncoder().encode(envelope)),
      bytesToBase64(Uint8Array.from(hexToBytes(ownerSignature)))
    );
    return isValid ? 'valid' : 'invalid';
  } catch {
    // Malformed hex, or the native verifier rejecting the input outright.
    return 'invalid';
  }
}

/**
 * Resolve who a `leave` control message actually came from.
 *
 * A leave is broadcast over the hub by the departing member, so there is no
 * owner signature to check. The proof the sender embeds is an ed448 signature
 * over `"delete" + hubPublicKey` made with their inbox key (desktop
 * SpaceService.deleteSpace builds it; desktop MessageService checks it).
 *
 * The member is resolved FROM the signing key, never from an address written
 * into the payload — same reverse-lookup rule as `resolveVerifiedSender`, and
 * for the same reason: an attacker must not be able to name their victim.
 * Returns the matching member row, or null on any failure (fail closed).
 */
export async function resolveVerifiedLeaver(
  payload: { inboxPublicKey?: string; inboxSignature?: string } | null | undefined,
  hubPublicKeyHex: string,
  members: SpaceMember[]
): Promise<SpaceMember | null> {
  const inboxPublicKey = payload?.inboxPublicKey;
  const inboxSignature = payload?.inboxSignature;
  if (!inboxPublicKey || !inboxSignature || !hubPublicKeyHex) return null;

  try {
    const signingProvider = new NativeSigningProvider();
    const isValid = await signingProvider.verifyEd448(
      bytesToBase64(Uint8Array.from(hexToBytes(inboxPublicKey))),
      bytesToBase64(new TextEncoder().encode(`delete${hubPublicKeyHex}`)),
      bytesToBase64(Uint8Array.from(hexToBytes(inboxSignature)))
    );
    if (!isValid) return null;

    const inboxAddress = deriveInboxAddress(inboxPublicKey);
    return (
      members.find((m) => m.inbox_address && m.inbox_address === inboxAddress) ?? null
    );
  } catch {
    return null;
  }
}

/** The participant fields a `join` signs over, plus the signature itself. */
export interface JoinParticipantProof {
  address?: string;
  id?: number;
  inboxAddress?: string;
  inboxPubKey?: string;
  pubKey?: string;
  inboxKey?: string;
  identityKey?: string;
  preKey?: string;
  userIcon?: string;
  displayName?: string;
  joinedAt?: number;
  /** base64 — signEd448 returns base64 and it travels unchanged (unlike leave's hex). */
  signature?: string;
}

/**
 * Same three-way shape as OwnerEnvelopeVerdict, for the same reason: `unverifiable`
 * means "could not check", NOT "forged". Dropping a join acks it out of the inbox
 * permanently, so collapsing the two would silently lose a genuine member forever.
 * Only `unverifiable` is worth a retry — the other rejections were checked and are
 * not going to check differently next time.
 */
export type JoinVerdict =
  | 'valid'
  | 'proof-missing'
  | 'signature-invalid'
  | 'unverifiable';

/**
 * Desktop signs the 10 participant fields joined by bare `+`, so a field that is
 * absent contributes the literal "undefined". Reproducing that coercion is what
 * makes the check byte-compatible rather than merely plausible.
 */
function buildJoinSignedBlob(p: JoinParticipantProof): string {
  return (
    String(p.address) +
    String(p.id) +
    String(p.inboxAddress) +
    String(p.pubKey) +
    String(p.inboxKey) +
    String(p.identityKey) +
    String(p.preKey) +
    String(p.userIcon) +
    String(p.displayName) +
    String(p.joinedAt)
  );
}

/**
 * Verify the ed448 signature a `join` carries, and that the announced inbox
 * address really derives from the announced key. Mirrors desktop's second join
 * gate; see `buildJoinSignedBlob` for the exact bytes signed.
 *
 * ## What this does NOT prove — read before trusting it
 *
 * The signature is checked against a public key the SENDER chose, so it proves
 * possession of *that* key. It does **not** bind `participant.address` to it. An
 * attacker can put a victim's address in the blob, sign with a fresh key of their
 * own, and this returns `valid`. So this is NOT authentication of the joining
 * identity, and `join` is not "fixed" by it.
 *
 * What it is worth: unsigned and malformed joins stop being accepted. The thing
 * actually protecting existing members is `buildJoinedMemberRow`, which refuses to
 * repoint an anchor or clear `isKicked` no matter what verifies here.
 *
 * Binding the claimed address to the key needs the DKG proof (`verify_point`),
 * which mobile cannot currently call.
 *
 * ## Do NOT add `deriveInboxAddress(inboxPubKey) === inboxAddress` here
 *
 * It looks like an obvious hardening and it is wrong: the two fields are DIFFERENT
 * KEYS on desktop, deliberately. Desktop derives `inboxAddress` from a freshly
 * generated per-space ed448 keypair and announces `inboxPubKey` from the DEVICE
 * keyset's inbox key (InvitationService, its join branch). Mobile happens to reuse
 * one keypair for both, so the equality holds here and nowhere else. Adding the
 * check rejected every genuine desktop join — no member row, no join event, the
 * member rendered as a bare address — and it shipped past three code reviews and a
 * WASM parity harness before a real device caught it.
 */
export async function verifyJoinParticipant(
  participant: JoinParticipantProof | null | undefined
): Promise<JoinVerdict> {
  const inboxPubKey = participant?.inboxPubKey;
  const signature = participant?.signature;
  const inboxAddress = participant?.inboxAddress;
  // Absent rather than wrong: retrying cannot make an unsigned join grow a
  // signature, so this is a real verdict, not an `unverifiable`.
  if (!participant || !inboxPubKey || !signature || !inboxAddress) {
    return 'proof-missing';
  }

  try {
    const signingProvider = new NativeSigningProvider();
    const isValid = await signingProvider.verifyEd448(
      bytesToBase64(Uint8Array.from(hexToBytes(inboxPubKey))),
      bytesToBase64(new TextEncoder().encode(buildJoinSignedBlob(participant))),
      signature
    );
    return isValid ? 'valid' : 'signature-invalid';
  } catch {
    // The native verifier could not produce an answer — a device/native-module
    // problem, not evidence of forgery, so the caller keeps the message for retry
    // rather than acking it away.
    return 'unverifiable';
  }
}
