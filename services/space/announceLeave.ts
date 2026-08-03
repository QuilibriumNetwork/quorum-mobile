import { logger, hexToBytes } from '@quilibrium/quorum-shared';
import { base64ToHex, hexToBase64, numberArrayToBase64 } from '@/utils/encoding';
import { getSpaceKey, getSpaceSigningKey } from '@/services/config/spaceStorage';
import { getQuorumClient } from '@/services/api/quorumClient';
import { NativeCryptoProvider } from '@/services/crypto/native-provider';

/**
 * Tell a Space you are leaving it, before the local wipe destroys the keys that
 * make saying so possible.
 *
 * `useLeaveSpace` used to carry a bare `TODO: Send leave message to space before
 * deleting`. The Space vanished from this device and nobody else was told, so on
 * every other member's device the departed member stayed in the roster, kept their
 * roles, and kept their inbox registered on the hub. Desktop has always announced
 * this; mobile going quiet was an unfinished handler, not a privacy decision.
 *
 * ## Two independent legs, and they fail differently on purpose
 *
 * 1. **The broadcast** — a hub-sealed `leave` control message that other members
 *    process. Best-effort: `enqueueOutbound` returns `void` with no acknowledgement
 *    anywhere in the protocol, and `flushOutbound` only reports that the socket
 *    still looked alive. Never fatal, because a user must be able to leave a Space
 *    on a bad connection.
 * 2. **The hub deregistration** — `POST /hub/delete`, an HTTP round trip the server
 *    answers. **Fatal.** If this fails the caller must keep the Space and surface
 *    the error, because wiping anyway would leave this inbox registered on the hub
 *    with the keys needed to remove it already deleted: permanently undeletable,
 *    and the member keeps receiving traffic for a Space they left.
 *
 * That split is desktop's shipped behaviour (`SpaceService.deleteSpace`), so
 * matching it is parity rather than a new invention.
 *
 * ## Missing keys degrade, they do not block
 *
 * If the hub or inbox key is unreadable, neither leg can run and this returns
 * `'skipped'` so the caller still wipes. Refusing would make a Space with damaged
 * key storage impossible to leave, which is worse than a leftover hub entry. The
 * rule is: fail loudly when the operation could have worked, degrade when it
 * structurally cannot.
 *
 * ## Two different "inbox" keys, and using the wrong one makes this silently do nothing
 *
 * The two legs are signed by **different identities**, because they are answering
 * different questions.
 *
 * - The **broadcast** must be signed with `getSpaceSigningKey` — the user's
 *   per-space identity from their original join, synced across their devices.
 *   `resolveVerifiedLeaver` resolves the departing member by deriving an inbox
 *   address from this key and matching it against the member table, and that table
 *   only ever binds the join key. Sign with a second device's own mailbox key and
 *   every receiver resolves nobody and drops the leave, with no error anywhere.
 *   That failure is documented in
 *   `issues/.open/2026-07-19-multidevice-inbox-key-breaks-verified-signer-auth.md`,
 *   and it is why every other send site on mobile uses this helper.
 * - The **hub deregistration** must use this device's own `'inbox'` key, because
 *   hub registration is genuinely per-device: this device registered that mailbox,
 *   and that is the entry being removed.
 *
 * On the device that created or joined the space the two are the same keypair, so
 * the distinction is invisible today. It stops being invisible the moment the
 * announce-keys send-side flip lands.
 *
 * ## The signatures are asymmetric — do not "tidy" them
 *
 * All three are ed448 over `"delete" + <a public key>`, but over *different*
 * subjects, with *different* signers:
 *
 * - control `inboxSignature` — signs `"delete" + hubPublicKey`, with the **signing**
 *   private key.
 * - `inbox_signature` — signs `"delete" + hubPublicKey`, with this device's **inbox**
 *   private key.
 * - `hub_signature` — signs `"delete" + <this device's inbox>PublicKey`, with the
 *   **hub** private key.
 *
 * They read like a copy-paste error and are not. Swapping them produces a message
 * that verifies nowhere. Desktop collapses the first two because it has no
 * signing/inbox split; the bytes are identical wherever the two keys are.
 */

/** How the best-effort broadcast leg turned out. The hub leg throws instead. */
export type LeaveBroadcastOutcome =
  /** Written to a socket that still looked alive. Not a delivery receipt. */
  | 'ok'
  /** Enqueued, but the socket did not confirm before the deadline. */
  | 'unconfirmed'
  /** Could not be attempted — key storage unreadable. */
  | 'skipped';

export interface AnnounceLeaveDeps {
  spaceId: string;
  enqueueOutbound: (prepareMessage: () => Promise<string[]>) => void;
  flushOutbound: (timeoutMs?: number) => Promise<boolean>;
}

/**
 * Matches the budget `deregisterThisDevice` uses for the same kind of leg: a
 * socket write plus a short watch for the socket dying.
 */
export const LEAVE_FLUSH_MS = 6000;

/** ed448 over `"delete" + <publicKeyHex>`, returned hex-encoded like the wire wants. */
async function signDeleteStatement(
  crypto: NativeCryptoProvider,
  signingPrivateKeyHex: string,
  subjectPublicKeyHex: string
): Promise<string> {
  const payloadBase64 = numberArrayToBase64(
    Array.from(new TextEncoder().encode(`delete${subjectPublicKeyHex}`))
  );
  const signatureBase64 = await crypto.signEd448(
    hexToBase64(signingPrivateKeyHex),
    payloadBase64
  );
  return base64ToHex(signatureBase64);
}

export async function announceLeave({
  spaceId,
  enqueueOutbound,
  flushOutbound,
}: AnnounceLeaveDeps): Promise<LeaveBroadcastOutcome> {
  const hubKey = getSpaceKey(spaceId, 'hub');
  const deviceInboxKey = getSpaceKey(spaceId, 'inbox');
  const signingKey = getSpaceSigningKey(spaceId);
  const configKey = getSpaceKey(spaceId, 'config');

  if (
    !hubKey?.address ||
    !hubKey?.publicKey ||
    !hubKey?.privateKey ||
    !deviceInboxKey?.publicKey ||
    !deviceInboxKey?.privateKey ||
    !signingKey?.publicKey ||
    !signingKey?.privateKey
  ) {
    logger.warn(
      `[leave] key storage incomplete for space=${spaceId.slice(0, 12)} — leaving silently rather than blocking the user`
    );
    return 'skipped';
  }

  const crypto = new NativeCryptoProvider();

  // Sign now, while the keys still exist. Once built these are just strings, so
  // the wipe that follows cannot invalidate them.
  //
  // Signing identity for the broadcast, device mailbox identity for the hub — see
  // the header. These are the same bytes on a join/create device and diverge on a
  // second device once announce-keys flips.
  const broadcastSignature = await signDeleteStatement(
    crypto,
    signingKey.privateKey,
    hubKey.publicKey
  );
  const deviceInboxSignature = await signDeleteStatement(
    crypto,
    deviceInboxKey.privateKey,
    hubKey.publicKey
  );
  const hubSignature = await signDeleteStatement(
    crypto,
    hubKey.privateKey,
    deviceInboxKey.publicKey
  );

  const sealed = await crypto.sealHubEnvelope(
    hubKey.address,
    {
      publicKey: Array.from(hexToBytes(hubKey.publicKey)),
      privateKey: Array.from(hexToBytes(hubKey.privateKey)),
    },
    JSON.stringify({
      type: 'control',
      message: {
        type: 'leave',
        // The signing identity, not this device's mailbox — the receiver derives
        // an inbox address from this and matches it against the member table.
        inboxPublicKey: signingKey.publicKey,
        inboxSignature: broadcastSignature,
      },
    }),
    configKey?.publicKey && configKey?.privateKey
      ? {
          publicKey: Array.from(hexToBytes(configKey.publicKey)),
          privateKey: Array.from(hexToBytes(configKey.privateKey)),
        }
      : undefined
  );

  // `log-append` is mobile's wrapper for every hub broadcast (space-manifest,
  // join, and the rest all use it). Desktop says `group` here; the two clients
  // have always differed on this envelope tag and both are accepted.
  const wsEnvelope = JSON.stringify({ type: 'log-append', ...sealed });
  enqueueOutbound(async () => [wsEnvelope]);

  // Enqueueing is not sending, and the caller is about to disconnect from this
  // Space entirely. Without waiting, the frame is discarded and the leave is
  // silent all over again — the exact bug this function exists to fix.
  let broadcast: LeaveBroadcastOutcome;
  try {
    broadcast = (await flushOutbound(LEAVE_FLUSH_MS)) ? 'ok' : 'unconfirmed';
  } catch (err) {
    broadcast = 'unconfirmed';
    logger.warn(`[leave] flush threw for space=${spaceId.slice(0, 12)}`, err);
  }
  if (broadcast !== 'ok') {
    logger.warn(
      `[leave] broadcast not confirmed for space=${spaceId.slice(0, 12)} — other members may still list this member`
    );
  }

  // Fatal by design. Throwing here keeps the Space on this device, which is what
  // makes the whole operation retryable; see the header.
  await getQuorumClient().postHubDelete({
    hub_address: hubKey.address,
    hub_public_key: hubKey.publicKey,
    hub_signature: hubSignature,
    inbox_public_key: deviceInboxKey.publicKey,
    inbox_signature: deviceInboxSignature,
  });

  logger.debug(
    `[leave] hub entry removed for space=${spaceId.slice(0, 12)} (broadcast=${broadcast})`
  );
  return broadcast;
}
