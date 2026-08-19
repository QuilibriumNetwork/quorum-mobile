/**
 * A generated public invite link has to reach the people who are already in the
 * Space, not just the owner's own device.
 *
 * Two defects sat in `generatePublicInviteLink`, and both were silent — nothing
 * threw, nothing logged, the owner saw a perfectly good link:
 *
 *   3a. `space.inviteUrl` was assigned AFTER the manifest was serialized, so the
 *       manifest that this very call published advertised no invite URL. Even a
 *       brand-new joiner fetching it landed without one.
 *   3b. No `space-manifest` control message was ever sent. The manifest POST only
 *       serves future joiners — no client refetches a manifest for a Space it has
 *       already joined — so existing members had no path to the URL at all until
 *       the owner happened to rename the Space for some unrelated reason.
 *
 * These tests pin the two facts that make the feature work, and they are written
 * against the observable output rather than the implementation: what does the
 * published manifest actually CONTAIN, and does the same manifest reach the wire.
 *
 * The regression they guard hardest is the ephemeral-key trap documented in
 * desktop's invite-system-analysis: the eval and the manifest are deliberately
 * encrypted with the SAME ephemeral X448 key, so the broadcast must reuse the
 * manifest that was POSTed rather than building a second one.
 */

// The store hangs off globalThis rather than a module-scope const: jest hoists the
// mock factory above every declaration, and spaceStorage creates its MMKV instance
// at import time, so a const would still be in its TDZ. Same pattern as
// groupDeletionGuard.test.ts.
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

// Crypto is faked, but NOT opaquely: encryptInboxMessage records what it was asked
// to encrypt and hands back a token. That lets a test read the plaintext back out
// of a ciphertext and assert on what was really published, which is the only way
// to catch 3a — the bug is entirely about WHAT went into the envelope.
jest.mock('@/services/crypto/native-provider', () => {
  const plaintexts = ((globalThis as Record<string, unknown>).__plaintexts = new Map<
    string,
    string
  >());
  let n = 0;
  return {
    NativeCryptoProvider: class {
      async generateX448() {
        n += 1;
        return { public_key: [n, 2, 3], private_key: [n, 5, 6] };
      }
      async encryptInboxMessage({ plaintext }: { plaintext: number[] }) {
        n += 1;
        const token = `ciphertext-${n}`;
        plaintexts.set(token, Buffer.from(plaintext).toString('utf8'));
        return token;
      }
      async signEd448() {
        return Buffer.from('signature').toString('base64');
      }
      async getPublicKeyX448() {
        return Buffer.from('point').toString('base64');
      }
    },
  };
});

jest.mock('@/services/api/quorumClient', () => ({
  getQuorumClient: () => ({
    postInviteEvals: async () => {},
    postSpaceManifest: async (spaceId: string, manifest: unknown) => {
      ((globalThis as Record<string, unknown>).__posted as unknown[]).push({ spaceId, manifest });
    },
  }),
}));

// A space owner's encryption state: a template plus a non-empty eval pool. This is
// exactly what a joiner's state lacks, which is why only owners can get this far.
jest.mock('@/services/crypto/encryption-state-storage', () => ({
  encryptionStateStorage: {
    getEncryptionStates: () => [
      {
        conversationId: 'c',
        inboxId: 'i',
        timestamp: 1,
        state: JSON.stringify({
          state: { root_key: 'root-key-value' },
          template: { dkg_ratchet: JSON.stringify({ id: 1 }) },
          evals: [[1, 2, 3, 4]],
        }),
      },
    ],
    saveEncryptionState: () => {},
  },
}));

// Capture what actually goes to the wire. Returning a token rather than a real
// envelope keeps the assertion on the INPUT: which manifest was broadcast.
jest.mock('@/services/space/spaceMessageService', () => ({
  sendSpaceManifestMessage: jest.fn(async (spaceId: string, manifest: unknown) => {
    ((globalThis as Record<string, unknown>).__sent as unknown[]).push({ spaceId, manifest });
    return 'ws-envelope';
  }),
}));

// Imported by inviteService for the private-invite self-heal path; never reached here.
jest.mock('@/services/space/spaceService', () => ({ republishSpace: async () => {} }));

import type { Space } from '@quilibrium/quorum-shared';
import { clearSpaceStorage, getSpace, saveSpace, saveSpaceKey } from '@/services/config/spaceStorage';
import { generatePublicInviteLink } from '@/services/space/inviteService';
import { sendSpaceManifestMessage } from '@/services/space/spaceMessageService';

const SPACE_ID = 'space-public-invite';
const CONFIG_PRIVATE = 'aa'.repeat(56);
const CONFIG_PUBLIC = 'bb'.repeat(56);

type Posted = { spaceId: string; manifest: Record<string, any> };
type Sent = { spaceId: string; manifest: Record<string, any> };

const posted = () => (globalThis as Record<string, unknown>).__posted as Posted[];
const sent = () => (globalThis as Record<string, unknown>).__sent as Sent[];
const plaintextOf = (token: string) =>
  ((globalThis as Record<string, unknown>).__plaintexts as Map<string, string>).get(token);

/** The Space as it is published: decrypt the manifest ciphertext back to the record. */
function publishedSpace(manifest: Record<string, any>): Space & Record<string, any> {
  const json = plaintextOf(manifest.space_manifest);
  if (!json) throw new Error('manifest ciphertext was never produced by the crypto provider');
  return JSON.parse(json);
}

/** Drain the outbound queue the way WebSocketContext would. */
async function runOutbound(queue: (() => Promise<string[]>)[]): Promise<string[]> {
  const envelopes: string[] = [];
  for (const thunk of queue) envelopes.push(...(await thunk()));
  return envelopes;
}

describe('public invite link propagation', () => {
  let outbound: (() => Promise<string[]>)[];

  beforeEach(() => {
    (globalThis as Record<string, unknown>).__posted = [];
    (globalThis as Record<string, unknown>).__sent = [];
    ((globalThis as Record<string, unknown>).__plaintexts as Map<string, string>)?.clear();
    (sendSpaceManifestMessage as jest.Mock).mockClear();
    outbound = [];
    clearSpaceStorage();

    saveSpace({
      spaceId: SPACE_ID,
      spaceName: 'Test Space',
      modifiedDate: 1000,
      groups: [],
    } as unknown as Space);

    for (const [keyId, publicKey, privateKey] of [
      ['owner', 'cc'.repeat(57), 'dd'.repeat(57)],
      ['hub', 'ee'.repeat(57), 'ff'.repeat(57)],
      ['config', CONFIG_PUBLIC, CONFIG_PRIVATE],
    ]) {
      saveSpaceKey({ spaceId: SPACE_ID, keyId, address: `addr-${keyId}`, publicKey, privateKey });
    }
  });

  const generate = () =>
    generatePublicInviteLink(SPACE_ID, (prepare) => {
      outbound.push(prepare);
    });

  it('publishes a manifest that already carries the invite URL', async () => {
    const { inviteLink } = await generate();

    expect(posted()).toHaveLength(1);
    const published = publishedSpace(posted()[0].manifest);

    // The whole of 3a: before the fix this was undefined, so a joiner fetching
    // this very manifest received a Space record with no invite URL in it.
    expect(published.inviteUrl).toBe(inviteLink);
    expect(inviteLink).toBe(
      `https://app.quorummessenger.com/invite/#spaceId=${SPACE_ID}&configKey=${CONFIG_PRIVATE}`
    );
  });

  it('advances modifiedDate with the manifest timestamp so a member watermark cannot go backwards', async () => {
    await generate();

    const manifest = posted()[0].manifest;
    const published = publishedSpace(manifest);

    // The receive path applies a manifest, then writes the record wholesale. A
    // fresh manifest.timestamp carrying a stale modifiedDate would lower the
    // member's replay-protection watermark.
    expect(published.modifiedDate).toBe(manifest.timestamp);
    expect(published.modifiedDate).toBeGreaterThan(1000);
  });

  it('broadcasts the manifest to existing members', async () => {
    await generate();

    // 3b: before the fix nothing was ever enqueued, so no member heard about it.
    expect(outbound).toHaveLength(1);

    const envelopes = await runOutbound(outbound);
    expect(envelopes).toEqual(['ws-envelope']);
    expect(sent()).toHaveLength(1);
    expect(sent()[0].spaceId).toBe(SPACE_ID);
  });

  it('broadcasts the SAME manifest it posted, not a rebuilt one', async () => {
    await generate();
    await runOutbound(outbound);

    // Rebuilding would mint a fresh ephemeral X448 key and break the deliberate
    // alignment between the eval's ephemeral key and the manifest's — the exact
    // trap that caused months of "invalid public invite link" reports.
    expect(sent()[0].manifest).toBe(posted()[0].manifest);
    expect(sent()[0].manifest.ephemeral_public_key).toBe(
      posted()[0].manifest.ephemeral_public_key
    );
  });

  it('persists the invite URL locally as well', async () => {
    const { inviteLink } = await generate();

    expect(getSpace(SPACE_ID)?.inviteUrl).toBe(inviteLink);
  });

  it('does not broadcast anything when generation fails', async () => {
    // A space with no owner key is a non-owner's device. It must fail before any
    // manifest is published, and must leave nothing queued for the wire.
    clearSpaceStorage();
    saveSpace({ spaceId: SPACE_ID, spaceName: 'No Owner', groups: [] } as unknown as Space);
    saveSpaceKey({
      spaceId: SPACE_ID,
      keyId: 'config',
      publicKey: CONFIG_PUBLIC,
      privateKey: CONFIG_PRIVATE,
    });

    await expect(generate()).rejects.toThrow(/Owner key not found/);
    expect(outbound).toHaveLength(0);
    expect(posted()).toHaveLength(0);
  });
});
