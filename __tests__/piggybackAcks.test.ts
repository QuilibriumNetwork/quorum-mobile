/**
 * Piggybacking DM receipt acks on outgoing messages.
 *
 * Mobile only ever sent standalone acks: it consumed piggybacked ones on
 * receive but never produced them, so every ack cost a full encrypted message
 * plus a ratchet advance on both sides, and — because the flush timer is a
 * debounce that each new inbound message pushes back — arrived only once the
 * conversation paused. These tests cover the producing half.
 *
 * Why they matter more than usual: piggybacking has NO observable behaviour
 * difference. Same ticks, same states, same UI. "I sent a DM and the receipt
 * still worked" passes identically whether this feature is present, absent, or
 * subtly broken. So the invariants have to be asserted directly.
 *
 * Two of them are load-bearing against silent failures that would look fine:
 *
 *  - `withPiggybackedAcks` must COPY. Mobile's send is deferred — it enqueues a
 *    thunk that serializes the message later — so desktop's attach-then-strip
 *    pattern would strip the fields before they were ever written, draining the
 *    buffers and cancelling the timers while putting nothing on the wire.
 *  - a disabled half must NOT be drained. Draining discards; the buffer belongs
 *    to the standalone timer, which is the only path left in a one-sided
 *    conversation.
 */

import { ReceiptService } from '@quilibrium/quorum-shared';
import type { Message } from '@quilibrium/quorum-shared';
import {
  drainPiggybackAcks,
  withPiggybackedAcks,
  type PiggybackDrainSource,
} from '@/services/dm/piggybackAcks';

const PARTNER = 'partner-address';
const allowAll = () => true;
const denyAll = () => false;

/** A ReceiptService stand-in that records what was drained. */
function stubSource(
  overrides: Partial<PiggybackDrainSource> = {},
): PiggybackDrainSource & { deliveryDrains: string[]; readDrains: string[] } {
  const deliveryDrains: string[] = [];
  const readDrains: string[] = [];
  return {
    deliveryDrains,
    readDrains,
    flushForPiggyback(address) {
      deliveryDrains.push(address);
      return overrides.flushForPiggyback?.(address) ?? [];
    },
    flushReadForPiggyback(address) {
      readDrains.push(address);
      return overrides.flushReadForPiggyback?.(address) ?? null;
    },
  };
}

function baseMessage(): Message {
  return {
    messageId: 'msg-1',
    channelId: PARTNER,
    spaceId: PARTNER,
    digestAlgorithm: 'SHA-256',
    nonce: 'nonce-1',
    createdDate: 1000,
    modifiedDate: 1000,
    lastModifiedHash: '',
    content: { type: 'post', senderId: 'me', text: 'hello' },
    reactions: [],
    mentions: { memberIds: [], roleIds: [], channelIds: [] },
  } as unknown as Message;
}

describe('drainPiggybackAcks', () => {
  it('returns null when nothing is pending, so no copy is made', () => {
    expect(drainPiggybackAcks(stubSource(), PARTNER, allowAll)).toBeNull();
  });

  it('carries pending delivery ack ids', () => {
    const source = stubSource({ flushForPiggyback: () => ['m1', 'm2'] });
    expect(drainPiggybackAcks(source, PARTNER, allowAll)).toEqual({
      ackMessageIds: ['m1', 'm2'],
    });
  });

  it('carries the read high-water mark and the ids it named', () => {
    const source = stubSource({
      flushReadForPiggyback: () => ({ messageId: 'm9', timestamp: 500, messageIds: ['m8', 'm9'] }),
    });
    expect(drainPiggybackAcks(source, PARTNER, allowAll)).toEqual({
      readAckUpTo: { messageId: 'm9', timestamp: 500, messageIds: ['m8', 'm9'] },
    });
  });

  it('omits messageIds entirely when nothing was named', () => {
    // Keeps the envelope byte-identical to the pre-naming shape for a peer on
    // an older build. Mirrors the standalone onReadFlush path.
    const source = stubSource({
      flushReadForPiggyback: () => ({ messageId: 'm9', timestamp: 500, messageIds: [] }),
    });
    const fields = drainPiggybackAcks(source, PARTNER, allowAll);
    expect(fields?.readAckUpTo).toEqual({ messageId: 'm9', timestamp: 500 });
    expect(fields?.readAckUpTo).not.toHaveProperty('messageIds');
  });

  it('carries both halves together', () => {
    const source = stubSource({
      flushForPiggyback: () => ['m1'],
      flushReadForPiggyback: () => ({ messageId: 'm9', timestamp: 500, messageIds: ['m9'] }),
    });
    const fields = drainPiggybackAcks(source, PARTNER, allowAll);
    expect(fields?.ackMessageIds).toEqual(['m1']);
    expect(fields?.readAckUpTo?.messageId).toBe('m9');
  });

  it('passes the partner address through to both drains', () => {
    const source = stubSource();
    drainPiggybackAcks(source, PARTNER, allowAll);
    expect(source.deliveryDrains).toEqual([PARTNER]);
    expect(source.readDrains).toEqual([PARTNER]);
  });

  describe('settings gate', () => {
    it('does not even drain a disabled half', () => {
      // Draining discards: it empties the buffer AND cancels the standalone
      // timer. A setting that says "do not send this now" must not destroy the
      // acks — leave them to the path that still owns them.
      const source = stubSource({ flushForPiggyback: () => ['m1'] });
      expect(drainPiggybackAcks(source, PARTNER, denyAll)).toBeNull();
      expect(source.deliveryDrains).toEqual([]);
      expect(source.readDrains).toEqual([]);
    });

    it('gates each half independently', () => {
      const source = stubSource({
        flushForPiggyback: () => ['m1'],
        flushReadForPiggyback: () => ({ messageId: 'm9', timestamp: 500, messageIds: [] }),
      });
      const deliveryOnly = drainPiggybackAcks(source, PARTNER, (kind) => kind === 'delivery');
      expect(deliveryOnly?.ackMessageIds).toEqual(['m1']);
      expect(deliveryOnly?.readAckUpTo).toBeUndefined();
      expect(source.readDrains).toEqual([]);

      const readSource = stubSource({
        flushForPiggyback: () => ['m1'],
        flushReadForPiggyback: () => ({ messageId: 'm9', timestamp: 500, messageIds: [] }),
      });
      const readOnly = drainPiggybackAcks(readSource, PARTNER, (kind) => kind === 'read');
      expect(readOnly?.readAckUpTo?.messageId).toBe('m9');
      expect(readOnly?.ackMessageIds).toBeUndefined();
      expect(readSource.deliveryDrains).toEqual([]);
    });
  });
});

describe('withPiggybackedAcks', () => {
  it('returns the very same object when there is nothing to attach', () => {
    const message = baseMessage();
    expect(withPiggybackedAcks(message, null)).toBe(message);
  });

  it('returns a COPY, never the original, when fields are attached', () => {
    // The whole feature depends on this. Mobile's send enqueues a thunk that
    // serializes the message LATER, so mutating the original and stripping
    // after the await would strip the fields before they were written: acks
    // drained, timers cancelled, nothing on the wire, and no error to notice.
    const message = baseMessage();
    const sent = withPiggybackedAcks(message, { ackMessageIds: ['m1'] });
    expect(sent).not.toBe(message);
    expect((sent as any).ackMessageIds).toEqual(['m1']);
  });

  it('leaves the original clean, so nothing leaks into the cache or storage', () => {
    const message = baseMessage();
    withPiggybackedAcks(message, {
      ackMessageIds: ['m1'],
      readAckUpTo: { messageId: 'm9', timestamp: 500 },
    });
    expect(message).not.toHaveProperty('ackMessageIds');
    expect(message).not.toHaveProperty('readAckUpTo');
  });

  it('preserves every field of the message it copies', () => {
    const message = baseMessage();
    const sent = withPiggybackedAcks(message, { ackMessageIds: ['m1'] });
    expect(sent.messageId).toBe(message.messageId);
    expect(sent.content).toEqual(message.content);
    expect(sent.createdDate).toBe(message.createdDate);
  });
});

/**
 * Against the real shared service, because the interaction that matters is with
 * its timers — and §7's stated regression risk is that draining cancels one.
 */
describe('with the real ReceiptService', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('a piggybacked ack replaces the standalone one instead of duplicating it', () => {
    const onFlush = jest.fn();
    const service = new ReceiptService({ onFlush });
    service.onMessageReceived(PARTNER, 'm1');

    const fields = drainPiggybackAcks(service, PARTNER, allowAll);
    expect(fields?.ackMessageIds).toEqual(['m1']);

    // Well past the 10s delivery debounce: the standalone ack must NOT follow,
    // or the peer receives the same ack twice and we paid for it anyway.
    jest.advanceTimersByTime(30_000);
    expect(onFlush).not.toHaveBeenCalled();
    service.destroy();
  });

  it('still fires the standalone ack when nothing piggybacked it out', () => {
    // The idle path — a one-sided conversation, where nothing outgoing exists
    // to ride on. Breaking this stops receipts entirely rather than slowing
    // them, so it is the real regression risk in this change.
    const onFlush = jest.fn();
    const service = new ReceiptService({ onFlush });
    service.onMessageReceived(PARTNER, 'm1');

    jest.advanceTimersByTime(10_000);
    expect(onFlush).toHaveBeenCalledWith(PARTNER, ['m1']);
    service.destroy();
  });

  it('leaves the timer alone for a partner with nothing pending', () => {
    // Sending to Bob must not disarm Alice's pending ack.
    const onFlush = jest.fn();
    const service = new ReceiptService({ onFlush });
    service.onMessageReceived('alice', 'm1');

    expect(drainPiggybackAcks(service, 'bob', allowAll)).toBeNull();

    jest.advanceTimersByTime(10_000);
    expect(onFlush).toHaveBeenCalledWith('alice', ['m1']);
    service.destroy();
  });

  it('does not disarm the standalone timer when the settings gate is closed', () => {
    // The gate must not become a way to silently lose acks: skipping the drain
    // has to leave the standalone path exactly as it was.
    const onFlush = jest.fn();
    const service = new ReceiptService({ onFlush });
    service.onMessageReceived(PARTNER, 'm1');

    expect(drainPiggybackAcks(service, PARTNER, denyAll)).toBeNull();

    jest.advanceTimersByTime(10_000);
    expect(onFlush).toHaveBeenCalledWith(PARTNER, ['m1']);
    service.destroy();
  });

  it('drains the read half without touching the delivery half', () => {
    const onFlush = jest.fn();
    const onReadFlush = jest.fn();
    const service = new ReceiptService({ onFlush, onReadFlush });
    service.onMessageReceived(PARTNER, 'm1');
    service.onMessageRead(PARTNER, 'm1', 1000);

    const fields = drainPiggybackAcks(service, PARTNER, (kind) => kind === 'read');
    expect(fields?.readAckUpTo?.messageId).toBe('m1');

    jest.advanceTimersByTime(30_000);
    // Read rode out on the message; delivery still owes its standalone ack.
    expect(onReadFlush).not.toHaveBeenCalled();
    expect(onFlush).toHaveBeenCalledWith(PARTNER, ['m1']);
    service.destroy();
  });
});
