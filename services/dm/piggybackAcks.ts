/**
 * Piggybacking DM receipt acks on outgoing messages.
 *
 * A receipt ack can travel two ways: as its own encrypted control message (a
 * full DM through the Double Ratchet — a real publish plus a ratchet advance on
 * both sides), or attached to a normal DM that was being sent anyway, where it
 * costs nothing because the encryption is already being paid for.
 *
 * The standalone path is a debounce, not a throttle: every inbound message
 * resets the 10s delivery timer (5s for read), so in an active exchange the ack
 * only fires once the conversation pauses. Piggybacking is the escape valve from
 * that — the pending acks ride out on the reply, immediately.
 *
 * Both functions here are pure so they can be tested directly; the wiring that
 * reaches the live ReceiptService lives in WebSocketContext.takePendingReceiptAcks.
 */

import type { Message, ReceiptEnvelopeFields } from '@quilibrium/quorum-shared';

/** The two ReceiptService drains this needs, narrowed so tests can pass a stub. */
export interface PiggybackDrainSource {
  flushForPiggyback(address: string): string[];
  flushReadForPiggyback(
    address: string,
  ): { messageId: string; timestamp: number; messageIds: string[] } | null;
}

export type ReceiptKind = 'delivery' | 'read';

/**
 * Drain both ack buffers for one partner into the envelope fields an outgoing
 * DM can carry. Returns null when there is nothing to send, so callers can skip
 * copying the message entirely.
 *
 * Each half is gated independently on the user's settings, and a disabled half
 * is NOT drained — leaving the buffer alone rather than silently discarding
 * acks the settings merely forbid *sending right now*. This mirrors the
 * standalone paths, which check the same gate before buffering.
 *
 * Draining also cancels that half's standalone timer (the shared service does
 * both together), which is the point: the ack leaves now instead of after the
 * next pause. The cost is that a send which never lands takes the acks with it —
 * accepted as best-effort, exactly as the standalone path already does, and
 * softened by read acks naming what they read (a lost delivery ack is settled by
 * the next read ack; a lost read ack is repaired by the next high-water mark).
 */
export function drainPiggybackAcks(
  service: PiggybackDrainSource,
  partnerAddress: string,
  isReceiptEnabled: (kind: ReceiptKind, address: string) => boolean,
): ReceiptEnvelopeFields | null {
  const fields: ReceiptEnvelopeFields = {};

  if (isReceiptEnabled('delivery', partnerAddress)) {
    const ackMessageIds = service.flushForPiggyback(partnerAddress);
    if (ackMessageIds.length > 0) fields.ackMessageIds = ackMessageIds;
  }

  if (isReceiptEnabled('read', partnerAddress)) {
    const payload = service.flushReadForPiggyback(partnerAddress);
    if (payload) {
      fields.readAckUpTo = {
        messageId: payload.messageId,
        timestamp: payload.timestamp,
        // Omitted when empty so the wire shape stays byte-identical to the
        // pre-naming one for a peer on an older build. Mirrors onReadFlush.
        ...(payload.messageIds.length > 0 ? { messageIds: payload.messageIds } : {}),
      };
    }
  }

  return fields.ackMessageIds || fields.readAckUpTo ? fields : null;
}

/**
 * Return the message to actually send: a shallow copy carrying the ack fields,
 * or the original untouched when there is nothing to piggyback.
 *
 * ⚠️ This returns a COPY on purpose, and the send path must be given the return
 * value rather than a mutated original. Mobile's send is deferred:
 * sendEncryptedMessageToAllDevices serializes nothing, it hands a thunk to
 * enqueueOutbound, and the JSON.stringify that puts bytes on the wire runs later
 * when the queue drains. So desktop's attach-then-strip-after-send pattern would
 * strip these fields before they were ever serialized — draining the buffers,
 * cancelling the timers, and putting nothing on the wire. That failure is silent:
 * no throw, no log, and receipts have no observable behaviour to notice it by.
 *
 * Copying sidesteps it entirely. The thunk closes over the copy, while the
 * caller's object never holds a transient wire field — so nothing can leak into
 * the React Query cache or storage, and there is no strip to forget.
 *
 * Shallow is sufficient: the fields are added at the top level and the send path
 * only reads the message.
 */
export function withPiggybackedAcks(
  message: Message,
  fields: ReceiptEnvelopeFields | null,
): Message {
  if (!fields) return message;
  return { ...message, ...fields };
}
