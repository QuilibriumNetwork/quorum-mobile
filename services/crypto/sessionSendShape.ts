/**
 * Which shape a DM frame must take on the wire.
 *
 * A frame is either PLAIN (a bare Double Ratchet envelope) or INIT-WRAPPED (the
 * same envelope inside an InitializationEnvelope carrying our return inbox).
 * The receiver does not choose — it demands one shape based on its own session:
 *
 *   sending_inbox.inbox_public_key === ''  → ConfirmDoubleRatchetSenderSession,
 *                                            which THROWS on a plain frame
 *                                            ('invalid initialization envelope')
 *   otherwise                              → DoubleRatchetInboxDecrypt, which
 *                                            accepts either shape
 *
 * So a peer who has not yet received our return inbox rejects every plain frame
 * we send. Mobile used to decide the shape from `sendingInbox.inbox_public_key`
 * — "do I know THEIR inbox?" — which answers the wrong question: a session born
 * from a peer's init envelope knows their inbox immediately, so mobile's first
 * reply went out plain and the peer, still unconfirmed, dropped every frame.
 * Permanently one-way, and only recoverable by a manual reset.
 *
 * The SDK asks the right question — "have I told them MINE?" — via
 * `sent_accept` (DoubleRatchetInboxEncrypt, channel.ts L976+):
 *
 *   sent_accept ? <plain> : <init-wrapped>, then persist sent_accept: true
 *
 * Both of mobile's ways of setting that flag converge on ONE meaning: the peer
 * has our return inbox. On a session we started, `confirmSenderSession` sets it
 * when their confirming reply arrives — proof, since only our return inbox
 * could have carried it. On a session they started, the accept below sets it
 * when we send ours — a weaker claim, since a lost frame is indistinguishable
 * from a delivered one. See `sessionAcceptEvidence` in the receive path.
 */

export type SessionSendShape =
  /** No return inbox known: keep announcing via a fresh X3DH init envelope. */
  | 'init'
  /** Their inbox known, ours never sent: wrap the EXISTING ratchet — no X3DH. */
  | 'accept'
  /** Both sides hold each other's inbox: bare envelope. */
  | 'plain'
  /** Nothing to seal to. */
  | 'unsendable';

export interface SendShapeState {
  sentAccept?: boolean;
  sendingInbox?: {
    inbox_address?: string;
    inbox_encryption_key?: string;
    inbox_public_key?: string;
  };
}

export function sessionSendShape(state: SendShapeState | null | undefined): SessionSendShape {
  const sendingInbox = state?.sendingInbox;
  // Without their sealing key there is no frame to build at all.
  if (!sendingInbox?.inbox_encryption_key) return 'unsendable';
  // An unconfirmed sender session targets their DEVICE inbox, where no session
  // exists yet — only a full X3DH init envelope can land.
  if (!sendingInbox.inbox_public_key) return 'init';
  if (!sendingInbox.inbox_address) return 'unsendable';
  return state?.sentAccept ? 'plain' : 'accept';
}
