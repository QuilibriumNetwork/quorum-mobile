/**
 * "New link" really does mint a new one-time link, and the display string really
 * does stay on one line.
 *
 * These two facts are tested together because the second is why the first was
 * doubted. Two freshly generated one-time links differ ONLY in `template` and
 * `secret`, which sit in the middle of the URL between a constant `spaceId` and a
 * constant `hubKey`. So the visible head and tail are byte-identical, and a user
 * comparing the on-screen link after tapping the button sees no change and
 * reasonably concludes the button is broken.
 *
 * It is not broken; it is unobservable. That is a UI feedback problem, not a
 * generation problem, and this file pins the generation half so the UI half can
 * be trusted to be the only thing that needed fixing.
 */

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

jest.mock('@/services/crypto/native-provider', () => ({ NativeCryptoProvider: class {} }));

// The self-heal probe runs before an invite is handed out. A manifest that is
// already present is the uneventful path, and keeps this test about link minting.
jest.mock('@/services/api/quorumClient', () => ({
  getQuorumClient: () => ({ getSpaceManifest: async () => ({}) }),
}));

jest.mock('@/services/space/spaceService', () => ({ republishSpace: async () => {} }));
jest.mock('@/services/space/spaceMessageService', () => ({
  sendSpaceManifestMessage: async () => 'ws-envelope',
}));

// A real invite pool: each generate consumes one eval, so successive links must
// differ. Held on globalThis because jest hoists this factory above every
// declaration, so a module-scope const would still be in its TDZ — same reason
// groupDeletionGuard.test.ts does it.
type Pool = {
  state: { root_key: string };
  template: { dkg_ratchet: string };
  evals: number[][];
};

jest.mock('@/services/crypto/encryption-state-storage', () => ({
  encryptionStateStorage: {
    getEncryptionStates: () => [
      {
        conversationId: 'c',
        inboxId: 'i',
        timestamp: 1,
        state: JSON.stringify((globalThis as Record<string, unknown>).__pool),
      },
    ],
    saveEncryptionState: (entry: { state: string }) => {
      (globalThis as Record<string, unknown>).__pool = JSON.parse(entry.state);
    },
  },
}));

import type { Space } from '@quilibrium/quorum-shared';
import { clearSpaceStorage, saveSpace, saveSpaceKey } from '@/services/config/spaceStorage';
import {
  generatePrivateInviteLink,
  getShortenedInviteLink,
  parseInviteLink,
} from '@/services/space/inviteService';

const SPACE_ID = 'space-one-time-invite';

const pool = () => (globalThis as Record<string, unknown>).__pool as Pool;

describe('generating a replacement one-time link', () => {
  beforeEach(() => {
    clearSpaceStorage();
    (globalThis as Record<string, unknown>).__pool = {
      state: { root_key: 'root-key-value' },
      template: { dkg_ratchet: JSON.stringify({ id: 1 }) },
      evals: [
        [1, 1, 1, 1],
        [2, 2, 2, 2],
        [3, 3, 3, 3],
      ],
    } satisfies Pool;

    saveSpace({ spaceId: SPACE_ID, spaceName: 'Test Space', groups: [] } as unknown as Space);
    for (const [keyId, publicKey, privateKey] of [
      ['config', 'aa'.repeat(56), 'bb'.repeat(56)],
      ['hub', 'cc'.repeat(57), 'dd'.repeat(57)],
    ]) {
      saveSpaceKey({ spaceId: SPACE_ID, keyId, address: `addr-${keyId}`, publicKey, privateKey });
    }
  });

  it('produces a genuinely different link each time', async () => {
    const first = await generatePrivateInviteLink(SPACE_ID);
    const second = await generatePrivateInviteLink(SPACE_ID);

    expect(second.inviteLink).not.toBe(first.inviteLink);
    expect(parseInviteLink(second.inviteLink)?.secret).not.toBe(
      parseInviteLink(first.inviteLink)?.secret
    );
  });

  it('consumes one invite slot per generated link', async () => {
    expect(pool().evals).toHaveLength(3);
    await generatePrivateInviteLink(SPACE_ID);
    expect(pool().evals).toHaveLength(2);
    await generatePrivateInviteLink(SPACE_ID);
    expect(pool().evals).toHaveLength(1);
  });

  it('leaves the visible part of the link unchanged, which is why the UI must confirm', async () => {
    const first = await generatePrivateInviteLink(SPACE_ID);
    const second = await generatePrivateInviteLink(SPACE_ID);

    // The regression this documents is a UX one: the links differ, but nothing a
    // user can see does. Any future attempt to signal "it worked" by showing more
    // of the URL is answered here.
    expect(second.inviteLink).not.toBe(first.inviteLink);
    expect(getShortenedInviteLink(second.inviteLink)).toBe(
      getShortenedInviteLink(first.inviteLink)
    );
  });
});

describe('the display string for a link', () => {
  it('fits one line and keeps the real host', () => {
    const long =
      'https://app.quorummessenger.com/invite/#spaceId=QmPeerAbcdefghijklmnop&configKey=' +
      'ab'.repeat(56);
    const shown = getShortenedInviteLink(long);

    expect(shown.length).toBeLessThanOrEqual(40);
    expect(shown).toContain('…');
    expect(shown.startsWith('app.quorummessenger.com')).toBe(true);
    expect(shown).not.toContain('\n');
  });

  it('does not misreport a dev link as production', () => {
    // The previous implementation hardcoded the production domain, so a link
    // generated against localhost was DISPLAYED as app.quorummessenger.com.
    const local = `http://localhost:5173/invite/#spaceId=QmPeerAbc&configKey=${'cd'.repeat(56)}`;
    const shown = getShortenedInviteLink(local);

    expect(shown.startsWith('localhost:5173')).toBe(true);
    expect(shown).not.toContain('quorummessenger.com');
  });

  it('leaves a short link alone and survives empty input', () => {
    expect(getShortenedInviteLink('https://qm.one/#a=1')).toBe('qm.one/#a=1');
    expect(getShortenedInviteLink('')).toBe('');
  });
});
