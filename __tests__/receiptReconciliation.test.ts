/**
 * Receipt truthfulness at the storage layer.
 *
 * The invariant under test: a read ack may never invent a delivery. Read acks
 * carry only a high-water mark ("read up to Y"), so expanding them across the
 * whole range used to stamp delivered+read on messages that never landed — the
 * sender confidently showed ✓✓ for messages the recipient had never seen.
 *
 * Mirrors quorum-desktop's `src/dev/tests/db/receiptReconciliation.test.ts`.
 * Both platforms defer the decision to the same shared resolvers, so the two
 * suites assert the same behaviour against different storage engines.
 *
 * `expo-sqlite` is backed by node's built-in SQLite here, so these exercise the
 * real SQL — the WHERE clause and the ownership filter are part of what makes
 * the invariant hold, not just the resolver call.
 */

import type { Message } from '@quilibrium/quorum-shared';

const ME = 'QmMyAddress';
const PEER = 'QmPeerAddress';

jest.mock('expo-sqlite', () => {
  // node:sqlite gives real SQL semantics. Its API is close to expo's but not
  // identical, so map the handful of methods messagesDb actually uses.
  const { DatabaseSync } = require('node:sqlite');

  const wrap = (db: any) => ({
    execSync: (sql: string) => db.exec(sql),
    runSync: (sql: string, params: unknown[] = []) => db.prepare(sql).run(...params),
    getFirstSync: (sql: string, params: unknown[] = []) => db.prepare(sql).get(...params) ?? null,
    getAllSync: (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params),
    prepareSync: (sql: string) => {
      const stmt = db.prepare(sql);
      return { executeSync: (...params: unknown[]) => stmt.run(...params), finalizeSync: () => {} };
    },
    withTransactionSync: (fn: () => void) => fn(),
    closeSync: () => db.close(),
  });

  return {
    openDatabaseSync: () => wrap(new DatabaseSync(':memory:')),
    deleteDatabaseSync: () => {},
  };
});

// A 32-byte hex string standing in for the Ed448 identity key. messagesDb runs
// it through HKDF to derive the SQLCipher key; plain SQLite ignores PRAGMA key,
// so any well-formed hex works. Inlined because jest hoists mock factories above
// every module-scope const.
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
  getItem: () => 'ab'.repeat(32),
  getItemAsync: async () => 'ab'.repeat(32),
}));

// MMKV is native-only. The migration flag reads 'done' so the one-shot
// MMKV→SQLite sweep short-circuits — it is not what these tests are about.
jest.mock('../services/offline/storage', () => ({
  storage: {
    getString: (key: string) => (key === 'messages-sqlite-migration:v1' ? 'done' : undefined),
    getAllKeys: () => [],
    set: () => {},
    remove: () => {},
  },
}));

type Db = typeof import('../services/storage/messagesDb');

describe('messagesDb — DM receipt reconciliation', () => {
  let db: Db;

  beforeEach(() => {
    // messagesDb caches its connection and cipher key at module scope, so a
    // fresh module registry is what gives each test a fresh in-memory DB.
    jest.resetModules();
    db = require('../services/storage/messagesDb');
  });

  /** A DM has spaceId === channelId === the partner address. */
  async function saveDm(over: {
    messageId: string;
    createdDate: number;
    senderId?: string;
    deliveredAt?: number;
    readAt?: number;
  }) {
    await db.saveMessage({
      messageId: over.messageId,
      spaceId: PEER,
      channelId: PEER,
      createdDate: over.createdDate,
      modifiedDate: over.createdDate,
      content: { type: 'post', senderId: over.senderId ?? ME, text: 'hi' },
      deliveredAt: over.deliveredAt,
      readAt: over.readAt,
    } as unknown as Message);
  }

  const get = (messageId: string) => db.getMessage({ spaceId: PEER, channelId: PEER, messageId });

  const readAck = (upToMessageId: string, upToTimestamp: number, at = 9_000) =>
    db.updateMessagesReadAt(PEER, ME, upToMessageId, upToTimestamp, at);

  describe('read acks', () => {
    it('does NOT mark an undelivered message as read or delivered', async () => {
      // The core bug: this message never landed, so it has no deliveredAt.
      await saveDm({ messageId: 'lost', createdDate: 400 });
      await saveDm({ messageId: 'hwm', createdDate: 500, deliveredAt: 800 });

      await readAck('hwm', 500);

      const lost = await get('lost');
      expect(lost?.readAt).toBeUndefined();
      expect(lost?.deliveredAt).toBeUndefined();
    });

    it('marks a delivered in-range message as read', async () => {
      await saveDm({ messageId: 'm1', createdDate: 400, deliveredAt: 800 });

      await readAck('hwm', 500);

      const m1 = await get('m1');
      expect(m1?.readAt).toBe(9_000);
      expect(m1?.deliveredAt).toBe(800); // untouched — the real delivery time
    });

    it('stamps both on the high-water-mark message, since reading proves arrival', async () => {
      await saveDm({ messageId: 'hwm', createdDate: 500 });

      await readAck('hwm', 500);

      const hwm = await get('hwm');
      expect(hwm?.readAt).toBe(9_000);
      expect(hwm?.deliveredAt).toBe(9_000);
    });

    it("leaves the peer's own messages alone", async () => {
      await saveDm({ messageId: 'theirs', createdDate: 400, senderId: PEER });

      await readAck('hwm', 500);

      const theirs = await get('theirs');
      expect(theirs?.readAt).toBeUndefined();
    });

    it('ignores delivered messages newer than the high-water mark', async () => {
      await saveDm({ messageId: 'newer', createdDate: 600, deliveredAt: 800 });

      await readAck('hwm', 500);

      const newer = await get('newer');
      expect(newer?.readAt).toBeUndefined();
    });

    it('reproduces the reported bug: lost messages stay blank, neighbours upgrade', async () => {
      // Ten sent messages; #4 and #7 never landed on the recipient.
      for (let n = 1; n <= 10; n++) {
        const lost = n === 4 || n === 7;
        await saveDm({
          messageId: `m${n}`,
          createdDate: n * 100,
          deliveredAt: lost ? undefined : 800,
        });
      }

      await readAck('m10', 1000);

      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => get(`m${i + 1}`))
      );
      const readIds = results.filter((m) => m?.readAt !== undefined).map((m) => m!.messageId);

      expect(readIds).toEqual(['m1', 'm2', 'm3', 'm5', 'm6', 'm8', 'm9', 'm10']);
      expect(results[3]?.readAt).toBeUndefined(); // m4 lost
      expect(results[3]?.deliveredAt).toBeUndefined();
      expect(results[6]?.readAt).toBeUndefined(); // m7 lost
      expect(results[6]?.deliveredAt).toBeUndefined();
    });
  });

  describe('delivery acks', () => {
    it('stamps deliveredAt when no read ack has arrived', async () => {
      await saveDm({ messageId: 'm1', createdDate: 400 });

      await db.updateMessageDeliveredAt('m1', 9_000);

      const m1 = await get('m1');
      expect(m1?.deliveredAt).toBe(9_000);
      expect(m1?.readAt).toBeUndefined();
    });

    it('completes the upgrade when a read ack already covered the message', async () => {
      // The common out-of-order case: read debounce (5s) beats delivery (10s).
      await saveDm({ messageId: 'm1', createdDate: 400 });

      await db.updateMessageDeliveredAt('m1', 9_000, new Map([[PEER, 500]]));

      const m1 = await get('m1');
      expect(m1?.deliveredAt).toBe(9_000);
      expect(m1?.readAt).toBe(9_000);
    });

    it('does not mark read when the message is newer than the watermark', async () => {
      await saveDm({ messageId: 'm2', createdDate: 600 });

      await db.updateMessageDeliveredAt('m2', 9_000, new Map([[PEER, 500]]));

      const m2 = await get('m2');
      expect(m2?.deliveredAt).toBe(9_000);
      expect(m2?.readAt).toBeUndefined();
    });
  });

  describe('ack ordering', () => {
    it('converges on delivered+read when the read ack arrives first', async () => {
      await saveDm({ messageId: 'm1', createdDate: 400 });

      // Read ack lands first — nothing to write yet, delivery is unconfirmed.
      await readAck('hwm', 500);
      expect((await get('m1'))?.readAt).toBeUndefined();

      // Delivery ack lands second and completes the upgrade.
      await db.updateMessageDeliveredAt('m1', 9_000, new Map([[PEER, 500]]));

      const m1 = await get('m1');
      expect(m1?.deliveredAt).toBe(9_000);
      expect(m1?.readAt).toBe(9_000);
    });

    it('converges on delivered+read when the delivery ack arrives first', async () => {
      await saveDm({ messageId: 'm1', createdDate: 400 });

      await db.updateMessageDeliveredAt('m1', 800);
      await readAck('hwm', 500);

      const m1 = await get('m1');
      expect(m1?.deliveredAt).toBe(800);
      expect(m1?.readAt).toBe(9_000);
    });

    it('leaves a permanently lost message blank in both orders', async () => {
      await saveDm({ messageId: 'lost', createdDate: 400 });

      await readAck('hwm', 500);
      await readAck('hwm2', 600); // a later read ack must not rescue it either

      const lost = await get('lost');
      expect(lost?.readAt).toBeUndefined();
      expect(lost?.deliveredAt).toBeUndefined();
    });
  });
});
