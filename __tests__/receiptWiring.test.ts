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
