/**
 * Receipt truthfulness at the WebSocketContext wiring layer.
 *
 * The decision logic lives in quorum-shared (and is unit-tested there and, via
 * the SQLite path, in receiptReconciliation.test.ts). What is mobile-specific —
 * and therefore what can silently regress here — is the WIRING: that the ack
 * callbacks actually delegate to the shared resolvers instead of sweeping
 * inline, and that the read-ack watermark is recorded so a delivery ack landing
 * afterwards can still complete the ✓✓ upgrade.
 *
 * Why this test is static rather than behavioural: these callbacks are built
 * inside a `useEffect` in a ~6000-line provider wired to the websocket, MMKV,
 * SQLite and native crypto. There is no harness that can drive an ack through
 * them, so the invariants are asserted against the source text — the same
 * approach dmSelfEchoGuards.test.ts takes for the same file.
 *
 * The regression this prevents: `deliveredAt: m.deliveredAt || now` inside the
 * read-ack sweep. A read ack is only a high-water mark ("read up to Y"), so
 * that backfill stamped delivered+read onto messages that never reached the
 * recipient at all — the sender showed ✓✓ for messages nobody ever received.
 */

import * as fs from 'fs';
import * as path from 'path';

const SOURCE_PATH = path.join(__dirname, '..', 'context', 'WebSocketContext.tsx');
const source = fs.readFileSync(SOURCE_PATH, 'utf8');

/** Slice the source between two anchors, failing loudly if either moved. */
function section(startAnchor: string, endAnchor: string): string {
  const start = source.indexOf(startAnchor);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(endAnchor, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

const readAckBody = () => section('onReadAckProcessed: (', '\n    });');
const deliveryAckBody = () => section('onAckProcessed: (messageIds)', 'onReadFlush:');
const readFlushBody = () => section('onReadFlush: (address, payload)', 'onReadAckProcessed:');
const interceptBody = () => section('const handleDmReceipt = useCallback', '}, [isReceiptEnabled]);');

describe('WebSocketContext — receipt ack wiring', () => {
  describe('read acks', () => {
    it('never backfills deliveredAt from a read ack', () => {
      // The exact shape of the shipped bug, plus the generic form.
      expect(readAckBody()).not.toMatch(/deliveredAt:\s*m\.deliveredAt\s*\|\|/);
      expect(readAckBody()).not.toMatch(/deliveredAt:\s*\w+\.deliveredAt\s*\|\|\s*now/);
    });

    it('validates the inbound timestamp before writing anything', () => {
      const body = readAckBody();
      expect(body).toContain('isReadAckTimestampValid(upToTimestamp, now)');
      // Must guard, not merely compute: an unbounded timestamp from a peer would
      // otherwise mark our entire outbound history read.
      expect(body).toMatch(/if\s*\(!isReadAckTimestampValid\(upToTimestamp,\s*now\)\)\s*return;/);
      // And it must come before the cache write.
      expect(body.indexOf('isReadAckTimestampValid')).toBeLessThan(body.indexOf('setQueryData'));
    });

    it('records the watermark so a later delivery ack can finish the upgrade', () => {
      const body = readAckBody();
      expect(body).toContain('readWatermarksRef.current.set(');
      expect(body).toContain('advanceReadWatermark(');
    });

    it('delegates the per-message decision to the shared resolver', () => {
      const body = readAckBody();
      expect(body).toContain('resolveReadAckPatch(m, ctx)');
      // No inline high-water-mark sweep — that IS the bug.
      expect(body).not.toMatch(/m\.createdDate\s*<=\s*upToTimestamp/);
    });

    it('passes the high-water-mark id through to persistence', () => {
      // The HWM message is the one case a read ack may stamp deliveredAt on
      // (reading it proves it arrived), so the id has to reach the DB layer.
      expect(readAckBody()).toMatch(
        /updateMessagesReadAt\(\s*conversationAddress,\s*self,\s*upToMessageId,\s*upToTimestamp,\s*now,/
      );
    });
  });

  // A read ack may also name the messages it read. Each named id is self-proving
  // on the same grounds as the high-water mark, so it settles ✓✓ for a message
  // whose delivery ack was lost. The mark is NOT retired by it: naming dies with
  // a dropped ack, the mark is restated by every later one and so repairs it.
  describe('read acks that name what they read', () => {
    it('sends the named ids alongside the mark', () => {
      const body = readFlushBody();
      expect(body).toContain('upToMessageId: payload.messageId');
      expect(body).toContain('upToTimestamp: payload.timestamp');
      expect(body).toContain('messageIds: payload.messageIds');
    });

    it('omits the field entirely when nothing was named', () => {
      // Keeps the wire shape byte-identical to the pre-naming one, so a peer on
      // an older build sees exactly what it saw before.
      expect(readFlushBody()).toMatch(/payload\.messageIds\.length\s*\?/);
    });

    it('keeps the high-water mark on the wire', () => {
      // Deleting the mark once ids are on the wire is the tempting mistake: the
      // mark is the only thing that repairs a read ack lost in transport.
      const body = readFlushBody();
      expect(body).toContain('upToMessageId:');
      expect(body).toContain('upToTimestamp:');
    });

    it('still records the watermark on receive', () => {
      expect(readAckBody()).toContain('advanceReadWatermark(');
    });

    it('passes the received ids into the resolver context and to persistence', () => {
      const body = readAckBody();
      expect(body).toMatch(/const readMessageIds = messageIds\?\.length \? new Set\(messageIds\) : undefined;/);
      expect(body).toContain('const ctx = { upToMessageId, upToTimestamp, now, readMessageIds };');
      expect(body).toContain('now, readMessageIds,');
    });

    it('forwards the raw peer value to the shared service, which sanitizes it', () => {
      // The value is untrusted peer JSON. An array-LIKE object is valid JSON and
      // throws inside `new Set(...)`, and this intercept has no try/catch around
      // it — a throw here would discard the whole ack, mark included. The shared
      // service coerces it and degrades to mark-only instead.
      const body = interceptBody();
      expect(body).toContain(
        'svc.onReadAckReceived(raw.upToMessageId, raw.upToTimestamp, partner, raw.messageIds)'
      );
      expect(body).not.toMatch(/new Set\(raw\.messageIds\)/);
    });

    it('forwards them on the piggyback path too', () => {
      // Same ids ride the envelope on a normal outgoing DM; the two receive
      // sites must not drift.
      expect(interceptBody()).toMatch(
        /raw\.readAckUpTo\.messageId,\s*raw\.readAckUpTo\.timestamp,\s*partner,\s*raw\.readAckUpTo\.messageIds/
      );
    });

    it('keeps the self-echo guard in front of both', () => {
      // Our own acks fan out to our other devices. A self-echoed read ack would
      // mark our own sent messages read; named ids do not change that.
      const body = interceptBody();
      const guardAt = body.indexOf("raw.type === 'read-ack'");
      const callAt = body.indexOf('svc.onReadAckReceived(raw.upToMessageId');
      expect(guardAt).toBeGreaterThan(-1);
      expect(body.slice(guardAt, callAt)).toContain('raw.senderId !== self');
    });
  });

  describe('delivery acks', () => {
    it('delegates the per-message decision to the shared resolver', () => {
      expect(deliveryAckBody()).toContain('resolveDeliveryAckPatch(m, { readWatermark, now })');
    });

    it('resolves the watermark per conversation from the query key', () => {
      // The ack itself carries no conversation; the cache key does.
      expect(deliveryAckBody()).toMatch(/readWatermarksRef\.current\.get\(String\(queryKey\[2\]/);
    });

    it('hands the watermarks to persistence too', () => {
      expect(deliveryAckBody()).toContain(
        'updateMessageDeliveredAt(id, now, readWatermarksRef.current)'
      );
    });
  });

  // Producing piggybacked acks. The decision logic is pure and tested directly
  // in piggybackAcks.test.ts; what can only regress here is the wiring.
  describe('piggybacked acks — the producing side', () => {
    it('exposes the drain on the context so the send hooks can reach it', () => {
      // The buffers live in receiptServiceRef inside this provider; the DM send
      // lives in useSendDirectMessage. Without this method there is no route.
      expect(source).toContain('takePendingReceiptAcks: (partnerAddress: string) => ReceiptEnvelopeFields | null;');
      expect(source).toMatch(/value = useMemo[\s\S]{0,600}takePendingReceiptAcks,/);
    });

    it('delegates the drain decision instead of inlining it', () => {
      const body = section('const takePendingReceiptAcks = useCallback', '}, [isReceiptEnabled]);');
      expect(body).toContain('drainPiggybackAcks(svc, partnerAddress, isReceiptEnabled)');
      // The settings gate is the shared function's job, and it must actually be
      // handed the gate rather than a stub that always allows.
      expect(body).not.toMatch(/drainPiggybackAcks\([^)]*=>\s*true/);
    });

    it('no-ops before the service exists rather than throwing into a send', () => {
      const body = section('const takePendingReceiptAcks = useCallback', '}, [isReceiptEnabled]);');
      expect(body).toMatch(/if\s*\(!svc\)\s*return null;/);
    });
  });

  describe('receipt settings', () => {
    it('gates read receipts on delivery receipts at the service layer', () => {
      // Delivery is load-bearing for read now: ✓✓ requires a real deliveredAt.
      // A stale `readReceipts: true, deliveryReceipts: false` override would
      // otherwise leave a conversation with permanently blank receipts.
      const body = section('const isReceiptEnabled = useCallback', '}, []);');
      expect(body).toContain("kind === 'delivery' ? delivery : delivery && resolve('readReceipts')");
    });
  });
});

/**
 * The DM send sites that carry piggybacked acks.
 *
 * These assertions exist for one specific silent failure. Mobile's send is
 * deferred: sendEncryptedMessageToAllDevices serializes nothing, it hands a
 * thunk to enqueueOutbound, and the JSON.stringify that puts bytes on the wire
 * runs later when the queue drains. So desktop's attach-to-the-message-then-
 * strip-after-the-await pattern strips the fields BEFORE they are written —
 * draining the buffers, cancelling the standalone timers, and sending nothing.
 * No throw, no log, and receipts have no observable behaviour to notice it by.
 *
 * Passing a copy is what makes it correct, so "did it pass a copy" is the thing
 * worth pinning down. A future edit that reverts to attach/strip because it
 * "matches desktop" is exactly the regression this catches.
 */
describe('DM send sites — piggyback carriers', () => {
  const CARRIERS = [
    { file: 'useSendDirectMessage.ts', address: 'recipientAddress' },
    { file: 'useEditDirectMessage.ts', address: 'params.recipientAddress' },
    { file: 'useDeleteDirectMessage.ts', address: 'params.recipientAddress' },
  ];

  const hookSource = (file: string) =>
    fs.readFileSync(path.join(__dirname, '..', 'hooks', 'chat', file), 'utf8');

  it.each(CARRIERS)('$file drains for the partner it is sending to', ({ file, address }) => {
    expect(hookSource(file)).toContain(`takePendingReceiptAcks(${address})`);
  });

  it.each(CARRIERS)('$file sends a copy, never a mutated original', ({ file }) => {
    const src = hookSource(file);
    // The copy reaches the send…
    expect(src).toMatch(/withPiggybackedAcks\(\s*message,/);
    // …and the original is never given the fields directly.
    expect(src).not.toMatch(/message\.(ackMessageIds|readAckUpTo)\s*=/);
    expect(src).not.toMatch(/delete\s+message\.(ackMessageIds|readAckUpTo)/);
    expect(src).not.toMatch(/Object\.assign\(\s*message,/);
  });

  it('never piggybacks onto a send that reaches only one of the partner devices', () => {
    // A carrier must fan out to EVERY device of the partner, because that is
    // what the standalone ack does. Draining into a single-session send trades
    // "arrives everywhere within 10s" for "arrives on one device now, and on
    // the others never" — the buffer is emptied either way. Reactions and
    // embeds both seal against one getLatestState session, so they are excluded
    // on that ground; revisit if they ever gain full fan-out.
    for (const file of ['useSendDirectReaction.ts', 'useSendDirectEmbedMessage.ts']) {
      const src = hookSource(file);
      expect(src).not.toContain('takePendingReceiptAcks');
      expect(src).not.toContain('withPiggybackedAcks');
    }
  });

  it('never piggybacks an ack onto an ack', () => {
    // sendDmReceiptAck is itself a standalone ack. Attaching there would be an
    // ack riding an ack — and would drain the buffer into a message the peer
    // handles on the flat-control-message path, which never reads the envelope
    // fields, destroying them.
    const ackSend = source.slice(
      source.indexOf('const sendDmReceiptAck = useCallback'),
      source.indexOf('sendDmReceiptAckRef.current = sendDmReceiptAck;'),
    );
    expect(ackSend.length).toBeGreaterThan(0);
    expect(ackSend).not.toContain('takePendingReceiptAcks');
    expect(ackSend).not.toContain('withPiggybackedAcks');
  });
});
