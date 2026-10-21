/**
 * Reactions are not lost or resurrected at the storage layer.
 *
 * ## The regressions this pins
 *
 * 1. A reaction whose target message wasn't stored yet was applied to the
 *    cache only (where the message usually wasn't either), the storage write
 *    was skipped, and the reaction was deleted from the server inbox anyway.
 *    It was gone for good. It's now kept in `pending_reactions` and folded
 *    into the message when the message is saved, by whatever path.
 * 2. Removing a message's last reaction saved `reactions: []`, and the
 *    reaction-preservation rule (meant for replays, whose copies carry no
 *    reactions) put the old reactions back, so the removed reaction returned.
 *    Saves of an applied reaction are now marked authoritative.
 *
 * `expo-sqlite` is backed by node's built-in SQLite, as in
 * `receiptReconciliation.test.ts`, so these run the real SQL.
 */
import type { Message } from '@quilibrium/quorum-shared';
import { applyReactionOp, type ReactionOp } from '@/utils/reactionOps';

jest.mock('expo-sqlite', () => {
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
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
  getItem: () => 'ab'.repeat(32),
  getItemAsync: async () => 'ab'.repeat(32),
}));
jest.mock('../services/offline/storage', () => ({
  storage: {
    getString: (key: string) => (key === 'messages-sqlite-migration:v1' ? 'done' : undefined),
    getAllKeys: () => [],
    set: () => {},
    remove: () => {},
  },
}));

type Db = typeof import('../services/storage/messagesDb');

const SPACE = 'space-1';
const CHANNEL = 'channel-1';

function post(messageId: string, over: Partial<Message> = {}): Message {
  return {
    messageId,
    spaceId: SPACE,
    channelId: CHANNEL,
    createdDate: 1_000,
    modifiedDate: 1_000,
    content: { type: 'post', senderId: 'author', text: 'hi' },
    ...over,
  } as unknown as Message;
}

const op = (kind: ReactionOp['kind'], senderId: string, reaction = '👍'): ReactionOp => ({
  kind,
  reaction,
  senderId,
  spaceId: SPACE,
});

describe('reactions that arrive before their message', () => {
  let db: Db;
  beforeEach(() => {
    jest.resetModules();
    db = require('../services/storage/messagesDb');
  });
  const get = (messageId: string) => db.getMessage({ spaceId: SPACE, channelId: CHANNEL, messageId });

  it('are applied when the message is saved, in order, and only once', async () => {
    await db.addPendingReaction(SPACE, CHANNEL, 'm1', op('add', 'alice'));
    await db.addPendingReaction(SPACE, CHANNEL, 'm1', op('add', 'bob'));
    await db.addPendingReaction(SPACE, CHANNEL, 'm1', op('remove', 'alice'));

    await db.saveMessage(post('m1'));
    expect((await get('m1'))?.reactions).toEqual([
      { emojiId: '👍', emojiName: '👍', spaceId: SPACE, count: 1, memberIds: ['bob'] },
    ]);

    // A later save of the same message (a replay) doesn't apply them again.
    await db.saveMessage(post('m1'));
    expect((await get('m1'))?.reactions).toEqual([
      { emojiId: '👍', emojiName: '👍', spaceId: SPACE, count: 1, memberIds: ['bob'] },
    ]);
  });

  it('wait for their own message, not another one', async () => {
    await db.addPendingReaction(SPACE, CHANNEL, 'm2', op('add', 'alice'));
    await db.saveMessage(post('m1'));
    expect((await get('m1'))?.reactions ?? []).toEqual([]);

    await db.saveMessage(post('m2'));
    expect((await get('m2'))?.reactions?.[0]?.memberIds).toEqual(['alice']);
  });
});

describe('removing the last reaction', () => {
  let db: Db;
  beforeEach(() => {
    jest.resetModules();
    db = require('../services/storage/messagesDb');
  });
  const get = (messageId: string) => db.getMessage({ spaceId: SPACE, channelId: CHANNEL, messageId });

  it('stores no reactions, when the save is marked as an applied reaction', async () => {
    await db.saveMessage(post('m1', { reactions: applyReactionOp([], op('add', 'alice')) }));
    const stored = (await get('m1'))!;

    await db.saveMessage(
      db.withAuthoritativeReactions({ ...stored, reactions: applyReactionOp(stored.reactions, op('remove', 'alice')) }),
    );

    expect((await get('m1'))?.reactions).toEqual([]);
  });

  it('CONTROL: a replayed copy without reactions still keeps the stored ones', async () => {
    await db.saveMessage(post('m1', { reactions: applyReactionOp([], op('add', 'alice')) }));
    await db.saveMessage(post('m1'));
    expect((await get('m1'))?.reactions?.[0]?.memberIds).toEqual(['alice']);
  });

  it('keeps the marker out of what is stored', async () => {
    await db.saveMessage(db.withAuthoritativeReactions(post('m1', { reactions: [] })));
    const stored = (await get('m1')) as unknown as Record<string | symbol, unknown>;
    expect(Object.getOwnPropertySymbols(stored)).toEqual([]);
  });
});

describe('applyReactionOp', () => {
  it('adds once per member and matches an emoji by name', () => {
    const one = applyReactionOp([], op('add', 'alice'));
    expect(applyReactionOp(one, op('add', 'alice'))).toBe(one);
    const byName = applyReactionOp([{ ...one[0], emojiId: 'thumbs' }], op('add', 'bob'));
    expect(byName[0]).toMatchObject({ emojiId: 'thumbs', count: 2, memberIds: ['alice', 'bob'] });
  });

  it('removes only the given member, and drops an emoji nobody is left on', () => {
    const two = applyReactionOp(applyReactionOp([], op('add', 'alice')), op('add', 'bob'));
    expect(applyReactionOp(two, op('remove', 'carol'))[0].count).toBe(2);
    expect(applyReactionOp(two, op('remove', 'alice'))[0]).toMatchObject({ count: 1, memberIds: ['bob'] });
    expect(applyReactionOp(applyReactionOp(two, op('remove', 'alice')), op('remove', 'bob'))).toEqual([]);
  });
});
