// Does a space synced from config only write the space it was asked to sync?
//
// ── What this measures ──────────────────────────────────────────────────────
//
// `syncSpaceFromConfig` (services/config/spaceSyncService.ts) is mobile's SECOND
// way to persist a space manifest. The first is the hub receive path, which
// authenticates a manifest against the delivering space and — since the scope
// guard landed — writes only that space. This one is different in every respect:
//
//   1. It FETCHES the manifest over HTTP (`getSpaceManifest(spaceId)`) rather
//      than receiving it.
//   2. It decrypts with the space config key and calls `saveSpace()` on the
//      result.
//   3. `saveSpace` keys the write on `space.spaceId` — a field inside the
//      decrypted payload — and nothing compares it against the `spaceId` that
//      was actually requested.
//
// The INVARIANT under test, stated positively (it is what the assertions say):
//
//     syncing space X may only write space X.
//
// ── The trigger, because it is not an exotic path ───────────────────────────
//
// configService.ts (the space-sync block) → `syncSpacesFromConfig` →
// `syncSpaceFromConfig`, on every config load listing a space this device does
// not have locally. In practice: onboarding, device restore, and a space
// appearing from another device via config sync. The `if (existingSpace) return`
// short-circuit at the top of the function checks the REQUESTED space, so it
// does not protect a different space the payload happens to name.
//
// ── Why the arms are shaped this way ────────────────────────────────────────
//
// "The other space survived" is trivially satisfied by a run that wrote nothing
// at all — a stub that never resolved, a decrypt that failed, a key that did not
// match. This function swallows every one of those into `return false`, so they
// are indistinguishable from a correctly-scoped sync unless the bench is proven
// alive. Hence:
//
//   1. CONTROL (delivery) — the same construction naming the REQUESTED space
//      does get stored, under that space, with its payload's name, and the
//      function returns true. This proves fetch → decrypt → save works end to
//      end, so a survivor in the other space is a scoping decision rather than a
//      dead bench. It is also the over-blocking guard: a first-ever sync of a
//      space is the ordinary, must-keep-working case.
//   2. CONTROL (decrypt discriminates) — a manifest encrypted to an unrelated
//      key writes nothing. Without it, "nothing was written" could mean the
//      decrypt step accepts anything and the earlier arms prove nothing.
//   3. NO LAUNDERING — after a refused cross-space sync, the REQUESTED space is
//      not written either. A "fix" that reassigned the payload's spaceId to the
//      requested one and saved anyway would satisfy the invariant while
//      importing attacker-chosen roles, channels and inviteUrl.
//
// Each arm re-seeds from scratch in `beforeEach`, so none of them depends on
// another having run. Running one alone with `-t` gives the same answer as
// running all of them.
//
// ── How faithful this is, and where it stops ────────────────────────────────
//
// REAL: `syncSpaceFromConfig` itself, unmodified and called directly; real
// `spaceStorage` on the MMKV shim; real X448 encrypt/decrypt from the Rust
// crate's WASM build; the real encryption-state store and MMKV adapter.
//
// NOT real, and deliberately:
//   - Three HTTP calls, stubbed on the real client singleton: `fetchSpace` and
//     `getSpaceManifest` (the two this function fetches) and `postHubAdd` (a
//     write to production that is fire-and-forget here — stubbing it keeps the
//     run offline; it is already wrapped in a swallowing try/catch, so stubbing
//     changes nothing about the path under test).
//   - ⚠️ This scenario says NOTHING about whether the fetched manifest is
//     AUTHENTIC. It cannot: the endpoint's response shape carries no signature
//     field at all (quorumClient.ts, `getSpaceManifest`), so there is nothing
//     for the client to verify. What is measured here is scope only — that a
//     sync of X cannot write Y. Authenticating this endpoint needs a wire
//     change and is tracked separately.
//
// Run: npx jest --config jest.harness.config.js config-sync-manifest-scope

import { type Space } from '@quilibrium/quorum-shared';

import { NativeCryptoProvider } from './wasm-provider-shim';

import { getQuorumClient } from '@/services/api/quorumClient';
// clearSpaceStorage, NOT the harness's __resetAllMMKV. A scenario importing
// './mmkv-shim' relatively gets a DIFFERENT module instance from the one app
// code reaches through the `react-native-mmkv` mapping, so its reset clears an
// empty registry and silently does nothing (MEASURED 2026-08-22 — see the note
// on __resetAllMMKV). The app's own API holds the same handle as the code under
// test, so it cannot miss.
import { clearSpaceStorage, getSpace, saveSpace } from '@/services/config/spaceStorage';
import {
  syncSpaceFromConfig,
  type SpaceKeyInfo,
} from '@/services/config/spaceSyncService';

/** The space being synced — not stored locally yet, so the sync proceeds. */
const SPACE_X = 'requestedspace-harness-configsync-x';
/** Already stored locally. The space a sync of X must not be able to touch. */
const SPACE_Y = 'otherspace-harness-configsync-y';
const CHANNEL_X = 'requestedchannel-harness-configsync-x';
const CHANNEL_Y = 'otherchannel-harness-configsync-y';

const NAME_X = 'space-x-as-the-manifest-names-it';
const NAME_Y = 'space-y-as-already-stored';
const INVITE_Y = 'https://invite.example/space-y-genuine';
const FORGED_NAME = 'space-y-overwritten-by-a-sync-of-space-x';
const FORGED_INVITE = 'https://invite.example/attacker-controlled';

const hex = (b: ArrayLike<number>) => Buffer.from(Uint8Array.from(b)).toString('hex');

function space(params: {
  spaceId: string;
  channelId: string;
  spaceName: string;
  inviteUrl?: string;
}): Space {
  return {
    spaceId: params.spaceId,
    spaceName: params.spaceName,
    vanityUrl: '',
    inviteUrl: params.inviteUrl ?? '',
    iconUrl: '',
    bannerUrl: '',
    defaultChannelId: params.channelId,
    hubAddress: `hub-of-${params.spaceId}`,
    createdDate: 1,
    modifiedDate: 1,
    isRepudiable: false,
    isPublic: false,
    groups: [
      {
        groupName: 'general',
        channels: [
          {
            channelId: params.channelId,
            spaceId: params.spaceId,
            channelName: params.channelId,
            createdDate: 1,
            modifiedDate: 1,
          },
        ],
      },
    ],
    roles: [],
    emojis: [],
    stickers: [],
  };
}

describe('a space synced from config only writes the space it was asked to sync', () => {
  let crypto: NativeCryptoProvider;

  /** Space X's config keypair — what an honest manifest for X is encrypted to. */
  let configXPublicKeyHex: string;
  let configXPrivateKeyHex: string;
  let hubXPublicKeyHex: string;
  let hubXPrivateKeyHex: string;

  /** The stubbed manifest response the next sync will fetch. */
  let servedManifest: {
    space_address: string;
    space_manifest: string;
    ephemeral_public_key: string;
  } | null = null;

  /** Every console.warn emitted during the current arm. */
  let warnings: string[] = [];
  let restoreWarn: (() => void) | undefined;

  beforeAll(() => {
    crypto = new NativeCryptoProvider();

    // Capture warnings without silencing them — the refusal reason is the trace
    // a failing run is diagnosed from, and this function is otherwise silent.
    const originalWarn = console.warn.bind(console);
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '));
      originalWarn(...args);
    };
    restoreWarn = () => {
      console.warn = originalWarn;
    };

    // Stub exactly three methods on the real client singleton, leaving the rest
    // real. `fetchSpace` and `getSpaceManifest` are what this function fetches;
    // `postHubAdd` is a real write to production that the function fires and
    // swallows, so stubbing it only keeps the run offline.
    const client = getQuorumClient() as unknown as Record<string, unknown>;
    client.fetchSpace = async (spaceId: string) => ({
      space_address: spaceId,
      space_public_key: '',
      space_signature: '',
      config_public_key: '',
      // Deliberately populated. The function fetches this and never reads it —
      // which is a finding in its own right, filed separately. Serving a real
      // list here means this scenario is not quietly relying on it being empty.
      owner_public_keys: ['00'.repeat(57)],
      owner_signatures: [],
      timestamp: 1,
    });
    client.getSpaceManifest = async () => {
      if (!servedManifest) throw new Error('[harness] no manifest staged for this arm');
      return servedManifest;
    };
    client.postHubAdd = async () => ({ status: 'ok' });
  });

  afterAll(() => {
    restoreWarn?.();
    clearSpaceStorage();
  });

  beforeEach(async () => {
    // Full reset per arm, so no arm can borrow another's state. `syncSpaceFromConfig`
    // returns early when the requested space already exists, so a leftover row
    // from a previous arm would silently skip the whole path under test.
    clearSpaceStorage();
    warnings = [];
    servedManifest = null;

    const configX = await crypto.generateX448();
    const hubX = await crypto.generateEd448();
    configXPublicKeyHex = hex(configX.public_key);
    configXPrivateKeyHex = hex(configX.private_key);
    hubXPublicKeyHex = hex(hubX.public_key);
    hubXPrivateKeyHex = hex(hubX.private_key);

    // Space Y is already on the device. Space X deliberately is NOT — that is
    // what makes the sync proceed past its existing-space short-circuit.
    saveSpace(
      space({
        spaceId: SPACE_Y,
        channelId: CHANNEL_Y,
        spaceName: NAME_Y,
        inviteUrl: INVITE_Y,
      })
    );
  });

  /**
   * Stage the manifest the next sync will fetch.
   *
   * `payloadSpace` is what the ciphertext NAMES; `encryptToPublicKeyHex` is the
   * key it is readable by. Keeping them independent is the point: an honest
   * manifest for X names X and is encrypted to X's config key, and the two
   * identifiers are never otherwise compared.
   */
  async function stageManifest(params: {
    payloadSpace: Space;
    encryptToPublicKeyHex: string;
  }): Promise<void> {
    const ephemeral = await crypto.generateX448();
    const spaceManifest = (await crypto.encryptInboxMessage({
      inbox_public_key: Array.from(Buffer.from(params.encryptToPublicKeyHex, 'hex')),
      ephemeral_private_key: ephemeral.private_key,
      plaintext: Array.from(new TextEncoder().encode(JSON.stringify(params.payloadSpace))),
    } as never)) as string;

    servedManifest = {
      space_address: SPACE_X,
      space_manifest: spaceManifest,
      ephemeral_public_key: hex(ephemeral.public_key),
    };
  }

  /** The config-blob entry that asks for space X to be synced. */
  const spaceKeyInfoForX = (): SpaceKeyInfo => ({
    spaceId: SPACE_X,
    encryptionState: {
      conversationId: SPACE_X,
      inboxId: '',
      state: '{}',
      timestamp: 1,
    },
    keys: [
      {
        keyId: 'config',
        spaceId: SPACE_X,
        publicKey: configXPublicKeyHex,
        privateKey: configXPrivateKeyHex,
      },
      {
        keyId: 'hub',
        spaceId: SPACE_X,
        address: `hub-of-${SPACE_X}`,
        publicKey: hubXPublicKeyHex,
        privateKey: hubXPrivateKeyHex,
      },
    ],
  });

  /** Space Y's row, as a payload naming a space the request never mentioned. */
  const forgedSpaceY = () =>
    space({
      spaceId: SPACE_Y,
      channelId: CHANNEL_Y,
      spaceName: FORGED_NAME,
      inviteUrl: FORGED_INVITE,
    });

  // ---- preconditions ----

  it('PRECONDITION: space Y is stored and space X is not', () => {
    expect(getSpace(SPACE_Y)?.spaceName).toBe(NAME_Y);
    expect(getSpace(SPACE_X)).toBeNull();
  });

  // ---- control: the path is alive ----

  it('CONTROL: syncing X with a manifest that names X stores it under X', async () => {
    await stageManifest({
      payloadSpace: space({ spaceId: SPACE_X, channelId: CHANNEL_X, spaceName: NAME_X }),
      encryptToPublicKeyHex: configXPublicKeyHex,
    });

    const ok = await syncSpaceFromConfig(spaceKeyInfoForX());

    // If this arm ever goes red, every "nothing was written" assertion below is
    // vacuous — the function would be failing for some unrelated reason and its
    // silence would be indistinguishable from correct scoping.
    expect(ok).toBe(true);
    expect(getSpace(SPACE_X)?.spaceName).toBe(NAME_X);
    expect(getSpace(SPACE_Y)?.spaceName).toBe(NAME_Y);
  });

  it('CONTROL: a manifest encrypted to an unrelated key writes nothing', async () => {
    // Guards the inverse mistake. If decrypt accepted anything, or the stub
    // returned a plaintext regardless of key, the arms either side of this would
    // pass for reasons that have nothing to do with scoping.
    const stranger = await crypto.generateX448();
    await stageManifest({
      payloadSpace: space({ spaceId: SPACE_X, channelId: CHANNEL_X, spaceName: NAME_X }),
      encryptToPublicKeyHex: hex(stranger.public_key),
    });

    // Self-check, not decoration: the function returns early (and reports
    // success) when the requested space is already stored, so a leaked row from
    // a previous arm would make this whole arm skip the code under test while
    // still looking like a clean result.
    expect(getSpace(SPACE_X)).toBeNull();

    const ok = await syncSpaceFromConfig(spaceKeyInfoForX());

    expect(ok).toBe(false);
    expect(getSpace(SPACE_X)).toBeNull();
    expect(getSpace(SPACE_Y)?.spaceName).toBe(NAME_Y);
  });

  // ---- the invariant ----

  it('syncing space X does NOT rewrite space Y', async () => {
    // Readable by X's config key — so every check this function performs passes
    // — but the ciphertext names Y.
    await stageManifest({
      payloadSpace: forgedSpaceY(),
      encryptToPublicKeyHex: configXPublicKeyHex,
    });

    // Same self-check as above, and it matters more here: an early return would
    // leave space Y untouched for a reason that has nothing to do with scoping,
    // which is precisely a vacuous pass on the security assertion below.
    expect(getSpace(SPACE_X)).toBeNull();

    const ok = await syncSpaceFromConfig(spaceKeyInfoForX());

    expect(getSpace(SPACE_Y)?.spaceName).toBe(NAME_Y);
    expect(getSpace(SPACE_Y)?.inviteUrl).toBe(INVITE_Y);

    // The refusal must come from the SCOPE decision, not from an earlier exit.
    // This function swallows every failure into `return false`, so without a
    // distinct reason a regression that broke the fetch or the decrypt would
    // look exactly like a correctly-scoped refusal and pass green.
    expect(ok).toBe(false);
    expect(
      warnings.some((w) => /\[space-sync\].*refusing cross-space write/.test(w))
    ).toBe(true);
  });

  it('NO LAUNDERING: the requested space is not written with the foreign payload either', async () => {
    await stageManifest({
      payloadSpace: forgedSpaceY(),
      encryptToPublicKeyHex: configXPublicKeyHex,
    });

    await syncSpaceFromConfig(spaceKeyInfoForX());

    // Reassigning the payload's spaceId to the requested one and saving anyway
    // would satisfy the invariant above while importing attacker-chosen
    // channels, roles and inviteUrl into space X.
    const storedX = getSpace(SPACE_X);
    if (storedX) {
      expect(storedX.spaceName).not.toBe(FORGED_NAME);
      expect(storedX.inviteUrl).not.toBe(FORGED_INVITE);
    }
  });
});
