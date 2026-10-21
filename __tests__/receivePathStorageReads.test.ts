/**
 * Receive-path storage reads don't re-parse what hasn't changed, and the
 * catch-up drain's yields really yield.
 *
 * ## The regressions this pins
 *
 * - `getSpaceMember`, called for every incoming space message, parsed the
 *   sender's whole roster (avatars inline) on every call, cache "hit"
 *   included. `saveConversation` parsed and rewrote the entire conversation
 *   list for every DM. Both now keep the parsed list, written through on save
 *   and dropped when MMKV reports the key changed.
 * - `getSpaceByHubAddress`, on every hub log update, parsed every space.
 * - The drain's "yield every 5 messages" used `runAfterInteractions`, a
 *   microtask under the New Architecture.
 *
 * ## What is asserted
 *
 * - Roster and conversation reads see every write: through the adapter, and
 *   straight to MMKV past it. Arrays handed out are copies.
 * - The hub-address lookup returns the space whose hub key matches.
 * - `yieldToEventLoop` lets an already-scheduled timer run first.
 */
import { MMKVAdapter } from '@/services/storage/mmkvAdapter';
import { storage } from '@/services/offline/storage';
import { getSpaceByHubAddress, saveSpace, saveSpaceKey } from '@/services/config/spaceStorage';
import { yieldToEventLoop } from '@/utils/yieldToEventLoop';
import type { SpaceMember, Conversation, Space } from '@quilibrium/quorum-shared';

jest.mock('@/services/storage/messagesDb', () => ({}));
// `offline/storage` reaches the config service, which loads the native crypto
// module at import.
jest.mock('@/modules/quorum-crypto/src', () => ({
  __esModule: true,
  default: {},
  generateX448: jest.fn(),
  generateEd448: jest.fn(),
  getPublicKeyX448: jest.fn(),
  getPublicKeyEd448: jest.fn(),
  signEd448: jest.fn(),
  verifyEd448: jest.fn(),
}));

const member = (address: string, name: string) =>
  ({ address, display_name: name }) as unknown as SpaceMember;

describe('space rosters', () => {
  const adapter = new MMKVAdapter();

  it('reflect saves through the adapter', async () => {
    await adapter.saveSpaceMember('s1', member('a', 'Alice'));
    expect((await adapter.getSpaceMember('s1', 'a'))?.display_name).toBe('Alice');
    await adapter.saveSpaceMember('s1', member('a', 'Alicia'));
    expect((await adapter.getSpaceMember('s1', 'a'))?.display_name).toBe('Alicia');
  });

  it('reflect a write made straight to MMKV, past the adapter', async () => {
    await adapter.saveSpaceMember('s2', member('b', 'Bob'));
    await adapter.getSpaceMember('s2', 'b');
    storage.set('spaceMembers:s2', JSON.stringify([member('b', 'Robert')]));
    expect((await adapter.getSpaceMember('s2', 'b'))?.display_name).toBe('Robert');
  });

  it('hand out copies, so a caller can’t change the cached list', async () => {
    await adapter.saveSpaceMember('s3', member('c', 'Carol'));
    const list = await adapter.getSpaceMembers('s3');
    list.push(member('x', 'Intruder'));
    expect(await adapter.getSpaceMembers('s3')).toHaveLength(1);
  });
});

describe('conversation lists', () => {
  const adapter = new MMKVAdapter();
  const convo = (id: string, timestamp: number) =>
    ({ conversationId: id, type: 'direct', timestamp }) as unknown as Conversation;

  it('reflect saves, in newest-first order', async () => {
    await adapter.saveConversation(convo('c1', 1));
    await adapter.saveConversation(convo('c2', 2));
    await adapter.saveConversation(convo('c1', 3));
    const { conversations } = await adapter.getConversations({ type: 'direct' });
    expect(conversations.map((c) => c.conversationId)).toEqual(['c1', 'c2']);
  });
});

describe('getSpaceByHubAddress', () => {
  it('returns the space whose hub key matches', () => {
    saveSpace({ spaceId: 'hub-a', spaceName: 'A' } as unknown as Space);
    saveSpace({ spaceId: 'hub-b', spaceName: 'B' } as unknown as Space);
    saveSpaceKey({ spaceId: 'hub-a', keyId: 'hub', address: 'QmHubA', publicKey: 'p', privateKey: 'k' });
    saveSpaceKey({ spaceId: 'hub-b', keyId: 'hub', address: 'QmHubB', publicKey: 'p', privateKey: 'k' });

    expect(getSpaceByHubAddress('QmHubB')?.spaceId).toBe('hub-b');
    expect(getSpaceByHubAddress('QmNone')).toBeNull();
  });
});

describe('yieldToEventLoop', () => {
  it('lets an already-scheduled timer run first', async () => {
    const order: string[] = [];
    setTimeout(() => order.push('timer'), 0);
    await yieldToEventLoop();
    order.push('after yield');
    expect(order).toEqual(['timer', 'after yield']);
  });
});
