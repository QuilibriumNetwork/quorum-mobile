/**
 * Deleting a channel group deletes everything inside it.
 *
 * `useDeleteGroup` removes the group with `space.groups.filter(...)`, and channels are
 * nested in the group object, so a populated group takes all of its channels with it —
 * for every member, since the same mutation broadcasts the new manifest. The settings
 * sheet told users "The group must be empty" while nothing checked it, which is worse
 * than an unguarded destructive action: the sentence gave them positive reason to
 * believe the attempt would fail harmlessly.
 *
 * These tests pin the guard where it has to live to be worth anything — inside the
 * mutation, not only in the sheet that renders the button — and pin the two facts a
 * future change is most likely to break: a refused delete must broadcast NOTHING (the
 * damage is what reaches other members), and an empty group must still delete and
 * still propagate.
 */

// The store hangs off globalThis rather than a module-scope const: jest hoists the
// mock factory above every declaration, and spaceStorage creates its MMKV instance at
// import time, so a const would still be in its TDZ. Same pattern as
// spaceOwnerPredicate.test.ts.
jest.mock('react-native-mmkv', () => ({
  createMMKV: ({ id }: { id: string }) => {
    const stores = ((globalThis as Record<string, unknown>).__mmkv ??= new Map()) as Map<
      string,
      Map<string, string>
    >;
    if (!stores.has(id)) stores.set(id, new Map());
    const store = stores.get(id)!;
    return {
      getString: (k: string) => store.get(k),
      set: (k: string, v: string) => store.set(k, v),
      remove: (k: string) => store.delete(k),
      delete: (k: string) => store.delete(k),
      getAllKeys: () => Array.from(store.keys()),
      clearAll: () => store.clear(),
      contains: (k: string) => store.has(k),
    };
  },
}));

// react-query is reduced to an identity wrapper so the hook can be called as a plain
// function and its mutationFn invoked directly. Nothing here needs a React tree.
jest.mock('@tanstack/react-query', () => ({
  useMutation: (options: unknown) => options,
  useQueryClient: () => ({ invalidateQueries: () => {} }),
}));

// Outbound work is queued as thunks. Collecting them instead of running them is the
// point: a refused delete must leave the queue empty.
jest.mock('@/context/WebSocketContext', () => ({
  useWebSocket: () => ({
    enqueueOutbound: (thunk: () => Promise<unknown>) => {
      ((globalThis as Record<string, unknown>).__outbound as unknown[]).push(thunk);
    },
  }),
}));

jest.mock('@/services/space/broadcastSpaceUpdate', () => ({
  broadcastSpaceUpdate: jest.fn(async (space: unknown) => {
    ((globalThis as Record<string, unknown>).__broadcasts as unknown[]).push(space);
    return { wsEnvelope: {} };
  }),
}));

jest.mock('@/services/storage/mmkvAdapter', () => ({
  getMMKVAdapter: () => ({ saveSpace: async () => {} }),
}));

// Imported only for its side-effect-free constructor reference in the module graph.
jest.mock('@/services/crypto/native-provider', () => ({ NativeCryptoProvider: class {} }));

import type { Channel, Space } from '@quilibrium/quorum-shared';
import { clearSpaceStorage, getSpace, saveSpace } from '@/services/config/spaceStorage';
import { useDeleteGroup } from '@/hooks/chat/useChannelManagement';
import { groupDeletionBlocker } from '@/utils/groupDeletion';

const SPACE_ID = 'space-under-test';
const DEFAULT_CHANNEL_ID = 'channel-default';

const channel = (channelId: string): Channel => ({
  channelId,
  spaceId: SPACE_ID,
  channelName: channelId,
  createdDate: 0,
  modifiedDate: 0,
});

/**
 * Group 0 holds the default channel, so it is the one every Space must keep.
 * Group 1 ("Projects") is the populated group under test; group 2 is empty.
 */
const makeSpace = (): Space => ({
  spaceId: SPACE_ID,
  spaceName: 'Test Space',
  description: '',
  vanityUrl: '',
  inviteUrl: '',
  iconUrl: '',
  bannerUrl: '',
  defaultChannelId: DEFAULT_CHANNEL_ID,
  hubAddress: 'hub',
  createdDate: 0,
  modifiedDate: 0,
  isRepudiable: false,
  isPublic: false,
  groups: [
    { groupName: 'General', channels: [channel(DEFAULT_CHANNEL_ID)] },
    { groupName: 'Projects', channels: [channel('channel-a'), channel('channel-b')] },
    { groupName: 'Empty', channels: [] },
  ],
  roles: [],
  emojis: [],
  stickers: [],
});

const outbound = () => (globalThis as Record<string, unknown>).__outbound as (() => Promise<unknown>)[];
const broadcasts = () => (globalThis as Record<string, unknown>).__broadcasts as Space[];

/**
 * Run the mutation exactly as the settings sheet does, minus React. The double cast is
 * the cost of the identity `useMutation` mock above: the declared return type is
 * react-query's result object, while at runtime it is the options object we passed in.
 */
const deleteGroup = (groupIndex: number) =>
  // Not a hook call in any real sense: `useMutation` is mocked to an identity
  // function above, so this just builds and returns the options object.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  (useDeleteGroup() as unknown as {
    mutationFn: (p: { spaceId: string; groupIndex: number }) => Promise<void>;
  }).mutationFn({ spaceId: SPACE_ID, groupIndex });

/** Drain the outbound queue so broadcasts land, as the WebSocket layer would. */
const flushOutbound = async () => {
  for (const thunk of outbound()) await thunk();
};

beforeEach(() => {
  clearSpaceStorage();
  (globalThis as Record<string, unknown>).__outbound = [];
  (globalThis as Record<string, unknown>).__broadcasts = [];
  saveSpace(makeSpace());
});

describe('useDeleteGroup', () => {
  it('refuses to delete a group that still contains channels', async () => {
    await expect(deleteGroup(1)).rejects.toThrow(/still contains 2 channels/);
  });

  it('leaves the group and its channels untouched when it refuses', async () => {
    await expect(deleteGroup(1)).rejects.toThrow();

    const stored = getSpace(SPACE_ID)!;
    expect(stored.groups.map((g) => g.groupName)).toEqual(['General', 'Projects', 'Empty']);
    expect(stored.groups[1].channels).toHaveLength(2);
  });

  it('broadcasts nothing to other members when it refuses', async () => {
    await expect(deleteGroup(1)).rejects.toThrow();
    await flushOutbound();

    // The damage this guard prevents is the part that reaches everyone else, so an
    // empty queue is the assertion that matters most here.
    expect(outbound()).toHaveLength(0);
    expect(broadcasts()).toHaveLength(0);
  });

  it('still refuses the group holding the default channel', async () => {
    await expect(deleteGroup(0)).rejects.toThrow();
  });

  it('deletes a genuinely empty group', async () => {
    await deleteGroup(2);

    const stored = getSpace(SPACE_ID)!;
    expect(stored.groups.map((g) => g.groupName)).toEqual(['General', 'Projects']);
  });

  it('still propagates the deletion of an empty group to other members', async () => {
    await deleteGroup(2);
    await flushOutbound();

    expect(broadcasts()).toHaveLength(1);
    expect(broadcasts()[0].groups.map((g) => g.groupName)).toEqual(['General', 'Projects']);
  });

  it('rejects an out-of-range group index without touching the space', async () => {
    await expect(deleteGroup(99)).rejects.toThrow(/Invalid group index/);
    expect(getSpace(SPACE_ID)!.groups).toHaveLength(3);
  });
});

describe('groupDeletionBlocker', () => {
  it('allows an empty group', () => {
    expect(groupDeletionBlocker({ groupName: 'Empty', channels: [] })).toBeNull();
  });

  it('names the channel count so the user knows what to empty', () => {
    expect(groupDeletionBlocker({ groupName: 'One', channels: [channel('a')] })).toBe(
      'This group still contains 1 channel. Move or delete it first.',
    );
    expect(
      groupDeletionBlocker({ groupName: 'Two', channels: [channel('a'), channel('b')] }),
    ).toBe('This group still contains 2 channels. Move or delete them first.');
  });
});
