// Does a `space-manifest` only rewrite the space that delivered it?
//
// ── What this measures ──────────────────────────────────────────────────────
//
// Mobile authenticates a space-manifest entirely against the DELIVERING space:
// the signing key must appear in THAT space's registration
// (`getSpaceRegistration(spaceId).owner_public_keys`), the Ed448 signature is
// checked over the manifest bytes, and the payload is decrypted with THAT
// space's stored `config` key. Three real constraints, all correctly enforced.
//
// The object it then persists is the decrypted payload, and `saveSpace` keys the
// write on `space.spaceId` — a field INSIDE that payload, chosen by whoever
// signed it (services/config/spaceStorage.ts, `space:<spaceId>`). Nothing
// compares the two identifiers.
//
// The INVARIANT under test, stated positively (it is what the assertions say):
//
//     a manifest delivered through space A may only rewrite space A.
//
// ── Why the arms are shaped this way ────────────────────────────────────────
//
// "Space B was not overwritten" is trivially satisfied by a scenario that
// delivers nothing at all — a frame the provider never routed, a signature the
// app rejected, a config key that did not decrypt, a handler never reached.
// Every one of those reads as a pass. So the cross-space arm is worthless alone
// and is bracketed by arms that make it mean something:
//
//   1. CONTROL (owner gate) — the same cross-space frame signed by a key that is
//      NOT in the delivering space's registration is refused at the registration
//      lookup. This proves that gate discriminates rather than waving everything
//      through, which matters because the registration answer is the one thing
//      this scenario stubs.
//   2. CONTROL (signature gate) — a frame that CLAIMS a registered owner key but
//      is signed by a different one is refused at the Ed448 check. Separate from
//      arm 1 on purpose: arm 1 never reaches `verifyEd448` at all
//      (WebSocketContext.tsx:1840 returns first), so without this arm a shim
//      whose verify always returned true would go undetected and every "the
//      frame was genuinely authenticated" claim here would rest on nothing.
//   3. CONTROL (delivery) — the same construction, same wire, same handler,
//      naming the DELIVERING space, DOES rewrite it. This proves the whole path
//      can carry a manifest all the way to storage, so a survivor in space B is
//      a scoping decision rather than a dead bench. It is also the over-blocking
//      guard: whatever stops the cross-space arm must leave this one working.
//   4. NO LAUNDERING — after the cross-space attempt, the DELIVERING space's own
//      row and its React Query cache entry must be unchanged too. A "fix" that
//      rewrote `space.spaceId` to the delivering space and saved anyway would
//      pass the invariant while importing attacker-chosen roles, channels and
//      inviteUrl into space A. That is a different bug of the same family, and
//      this arm is what stops it being introduced as the repair.
//
// The cache assertion is not decoration. The handler writes storage keyed by the
// PAYLOAD's spaceId and the cache keyed by the DELIVERING spaceId, one statement
// apart, so the two identifiers are already known to disagree here — and a
// cache-only write is still a real client-state change.
//
// ── How faithful this is, and where it stops ────────────────────────────────
//
// REAL: mobile's `WebSocketProvider` and its `handleIncomingMessage` receive
// path, the whole `space-manifest` handler including the owner lookup, the Ed448
// verification, the config-key decrypt and the staleness guard, real
// `spaceStorage` on the real MMKV shim, real X448 envelope encryption and real
// Ed448 signing. No authorization logic is transcribed or stubbed in this file.
//
// NOT real, and deliberately:
//   - The socket. `createRNWebSocketClient` is replaced by an in-process fake so
//     the frame reaches the provider's OWN message handler without a relay. What
//     is under test is receive-side handling, not transport.
//   - `getSpaceRegistration`, and ONLY that method. It is an HTTP GET for server
//     state (which keys own a space), not client logic — there is no space to
//     register on production and registering one would not make the test better.
//     The check that CONSUMES the answer is untouched real code, and control (1)
//     proves the stub discriminates rather than waving everything through.
//   - The attacker is a keypair and a frame, not a second running client. A
//     genuine two-client space is not reachable headlessly at all: joining one
//     needs `tripleRatchetResizeForInvites`, which is native-only and throws in
//     this harness. Since the defect is entirely in how the RECEIVER handles a
//     frame it has already authenticated, the signing identity is the part that
//     has to be real, and it is.
//   - ⚠️ ONLY THE PER-MESSAGE RECEIVE PATH IS EXERCISED. Unlike `remove-message`,
//     `space-manifest` has NO second handler on the native batch catch-up path
//     (verified: `case 'space-manifest'` appears exactly once in
//     WebSocketContext.tsx). So there is no unmeasured twin here — but that is a
//     fact about the code, not something this green run establishes.
//
// Run: npx jest --config jest.harness.config.js space-manifest-scope
//
// No relay, no account registration, no persisted device — nothing this scenario
// asserts on touches the network. One exception, inherited from the receive path
// itself: after processing a space frame the handler fires a best-effort
// server-side inbox cleanup (`deleteSpaceInboxMessages`), fire-and-forget and
// `.catch`-swallowed. It is left alone rather than suppressed, because
// suppressing it would mean altering the path under test. It targets an address
// derived from a key generated in this run, so it can only ever reach an inbox
// nobody owns.

import React from 'react';
import { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  deriveInboxAddress,
  int64ToBytes,
  queryKeys,
  type Channel,
  type EncryptedWebSocketMessage,
  type Space,
} from '@quilibrium/quorum-shared';

import { __resetAllMMKV } from './mmkv-shim';
import { NativeCryptoProvider } from './wasm-provider-shim';
import { NativeSigningProvider } from './wasm-signing-shim';

// The socket seam. The provider builds its client through this factory, so
// swapping the factory hands the harness the provider's OWN message handler —
// the real entry point, reached the real way, with only the wire replaced.
//
// The fake is parked on globalThis rather than a module variable because
// jest.mock factories are hoisted above every import in this file, so anything
// they close over is still uninitialised when the mock is registered.
jest.mock('@quilibrium/quorum-shared', () => {
  const actual = jest.requireActual('@quilibrium/quorum-shared');
  return {
    ...actual,
    createRNWebSocketClient: () => {
      let handler: ((m: EncryptedWebSocketMessage) => Promise<void>) | null = null;
      const client = {
        state: 'connected',
        isConnected: true,
        connect: async () => {},
        disconnect: () => {},
        send: async () => {},
        enqueueOutbound: () => {},
        subscribe: async () => {},
        unsubscribe: async () => {},
        setMessageHandler: (h: (m: EncryptedWebSocketMessage) => Promise<void>) => {
          handler = h;
        },
        setResubscribeHandler: () => {},
        onStateChange: (h: (s: string) => void) => {
          h('connected');
          return () => {};
        },
        onError: () => () => {},
        /** Hand a frame to the provider exactly as the socket would. */
        deliver: async (m: EncryptedWebSocketMessage) => {
          if (!handler) throw new Error('[harness] provider never set a message handler');
          await handler(m);
        },
        hasHandler: () => handler !== null,
      };
      (globalThis as Record<string, unknown>).__harnessWsClient = client;
      return client;
    },
  };
});

// Imported AFTER the mock is registered; these pull the app modules that build
// on the shared barrel.
import AuthContext, { type UserInfo } from '@/context/AuthContext';
import StorageContext from '@/context/StorageContext';
import { WebSocketProvider } from '@/context/WebSocketContext';
import { getQuorumClient } from '@/services/api/quorumClient';
import { getSpace, saveSpace, saveSpaceKey } from '@/services/config/spaceStorage';
import { getMMKVAdapter } from '@/services/storage/mmkvAdapter';
import { deriveAddress, initializeEncryptionKeys } from '@/services/onboarding/keyService';
import { storePrivateKey, storePublicKey } from '@/services/onboarding/secureStorage';

// The two ids must differ within the first 12 characters: the handler truncates
// both to 12 when it logs a refusal, and this scenario asserts on that line. A
// shared prefix would render it as "names harness-mani, delivered on
// harness-mani" — still passing, but unreadable in the one place a failing run
// gets diagnosed from. Real space ids are hashes, so they never collide there.
const SPACE_A = 'deliveringspace-harness-manifest-a';
const SPACE_B = 'elsewherespace-harness-manifest-b';
const CHANNEL_A = 'deliveringchannel-harness-manifest-a';
const CHANNEL_B = 'elsewherechannel-harness-manifest-b';

const NAME_A = 'space-a-as-stored';
const NAME_B = 'space-b-as-stored';
const INVITE_B = 'https://invite.example/space-b-genuine';
/** What a successful attack would leave behind. Distinctive on purpose. */
const FORGED_NAME = 'space-b-overwritten-by-a-manifest-from-space-a';
const FORGED_INVITE = 'https://invite.example/attacker-controlled';
/** What the delivery control legitimately renames the delivering space to. */
const RENAMED_A = 'space-a-renamed-by-its-own-owner';

// Fixed rather than Date.now(), so ordering between arms is deterministic and a
// re-run cannot accidentally trip the handler's staleness guard.
const T_BASE = 1_800_000_000_000;
const T_ATTACK = T_BASE + 1_000;
const T_FORGED_OWNER = T_BASE + 2_000;
const T_FORGED_SIGNATURE = T_BASE + 2_500;
const T_LEGITIMATE = T_BASE + 3_000;

const hex = (b: ArrayLike<number>) => Buffer.from(Uint8Array.from(b)).toString('hex');
const b64 = (b: ArrayLike<number>) => Buffer.from(Uint8Array.from(b)).toString('base64');
const b64ToHex = (s: string) => Buffer.from(s, 'base64').toString('hex');

interface OwnerKey {
  publicKeyHex: string;
  privateKeyHex: string;
}

async function makeOwnerKey(crypto: NativeCryptoProvider): Promise<OwnerKey> {
  const ed = await crypto.generateEd448();
  return { publicKeyHex: hex(ed.public_key), privateKeyHex: hex(ed.private_key) };
}

function channel(spaceId: string, channelId: string): Channel {
  return {
    channelId,
    spaceId,
    channelName: channelId,
    createdDate: 1,
    modifiedDate: 1,
  };
}

function space(params: {
  spaceId: string;
  channelId: string;
  hubAddress: string;
  spaceName: string;
  inviteUrl?: string;
  modifiedDate?: number;
}): Space {
  return {
    spaceId: params.spaceId,
    spaceName: params.spaceName,
    vanityUrl: '',
    inviteUrl: params.inviteUrl ?? '',
    iconUrl: '',
    bannerUrl: '',
    defaultChannelId: params.channelId,
    hubAddress: params.hubAddress,
    createdDate: 1,
    modifiedDate: params.modifiedDate ?? 1,
    // Signatures are required for control messages regardless of this flag;
    // false is simply the ordinary space shape.
    isRepudiable: false,
    isPublic: false,
    groups: [{ groupName: 'general', channels: [channel(params.spaceId, params.channelId)] }],
    roles: [],
    emojis: [],
    stickers: [],
  };
}

/**
 * Build a `space-manifest` control frame the way a broadcasting owner does.
 *
 * Two identifiers are deliberately independent here, because their divergence is
 * the whole subject:
 *   - `configPublicKeyHex` / delivery — the space the frame is encrypted TO and
 *     arrives ON. Every authentication step uses this one.
 *   - `payloadSpace.spaceId` — the space named INSIDE the ciphertext, which is
 *     what `saveSpace` keys the write on.
 *
 * The signature covers `utf8(space_manifest) ++ int64(timestamp)` and nothing
 * else — notably not the payload's spaceId, which is only visible after
 * decryption. Signed with a real Ed448 key, base64 in, hex on the wire, exactly
 * as the handler reads it back (`hexToBytes(manifest.owner_signature)`).
 *
 * `claimAsPublicKeyHex` decouples the key that SIGNS from the key the frame
 * CLAIMS. They are the same for every honest sender; setting them apart is the
 * only way to reach the Ed448 check with a key the registration accepts, which
 * is what the signature-gate control needs.
 */
async function buildManifestControl(params: {
  crypto: NativeCryptoProvider;
  owner: OwnerKey;
  claimAsPublicKeyHex?: string;
  deliveringConfigPublicKeyHex: string;
  payloadSpace: Space;
  timestamp: number;
}): Promise<string> {
  const ephemeral = await params.crypto.generateX448();

  // encryptInboxMessage returns the serialized {ciphertext, initialization_vector,
  // associated_data} object as a string — which is exactly what the handler
  // JSON.parses out of manifest.space_manifest.
  const spaceManifest = (await params.crypto.encryptInboxMessage({
    inbox_public_key: Array.from(Buffer.from(params.deliveringConfigPublicKeyHex, 'hex')),
    ephemeral_private_key: ephemeral.private_key,
    plaintext: Array.from(new TextEncoder().encode(JSON.stringify(params.payloadSpace))),
  } as never)) as string;

  const signedBytes = new Uint8Array([
    ...new TextEncoder().encode(spaceManifest),
    ...int64ToBytes(params.timestamp),
  ]);
  const signatureB64 = await new NativeSigningProvider().signEd448(
    b64(Buffer.from(params.owner.privateKeyHex, 'hex')),
    b64(signedBytes)
  );

  return JSON.stringify({
    type: 'control',
    message: {
      type: 'space-manifest',
      manifest: {
        owner_public_key: params.claimAsPublicKeyHex ?? params.owner.publicKeyHex,
        owner_signature: b64ToHex(signatureB64),
        space_manifest: spaceManifest,
        ephemeral_public_key: hex(ephemeral.public_key),
        timestamp: params.timestamp,
      },
    },
  });
}

/**
 * Seal a payload into the hub-envelope shape the receive path unseals.
 *
 * The seal half of native-provider's sealHubEnvelope, config-key branch: the
 * space config key is used DIRECTLY as the X448 recipient key. The hub signature
 * fields are carried because the wire shape has them; they are not checked on
 * this path, since the outer owner-signature gate applies to sync envelopes
 * (kick / rekey) and space-manifest carries its own inner signature instead.
 */
async function sealForSpace(
  crypto: NativeCryptoProvider,
  configPublicKeyHex: string,
  hubAddress: string,
  plaintext: string
): Promise<string> {
  const ephemeral = await crypto.generateX448();
  const envelope = (await crypto.encryptInboxMessage({
    inbox_public_key: Array.from(Buffer.from(configPublicKeyHex, 'hex')),
    ephemeral_private_key: ephemeral.private_key,
    plaintext: Array.from(new TextEncoder().encode(plaintext)),
  } as never)) as string;

  return JSON.stringify({
    hub_address: hubAddress,
    ephemeral_public_key: hex(ephemeral.public_key),
    envelope,
    hub_public_key: '',
    hub_signature: '',
  });
}

describe('a space-manifest only rewrites the space that delivered it', () => {
  let crypto: NativeCryptoProvider;
  /** In space A's registration — an owner, the lowest bar the handler checks. */
  let ownerA: OwnerKey;
  /** In NO registration — the owner-gate control. */
  let strangerKey: OwnerKey;
  let inboxAddressA: string;
  let configPublicKeyA: string;
  let queryClient: QueryClient;
  let renderer: { unmount: () => void } | undefined;

  /** Every console.warn emitted so far, so an arm can inspect its own slice. */
  const warnings: string[] = [];
  let restoreWarn: (() => void) | undefined;

  /**
   * Set by the invariant arm. The laundering arm inspects the aftermath of THAT
   * delivery rather than making its own, so run alone (`-t`, `.only`, per-`it`
   * sharding, a future `--randomize`) it would find a pristine bench and pass
   * without an attack ever having happened. It asserts this flag first, so that
   * configuration fails loudly instead of reporting a green that means nothing.
   */
  let attackDelivered = false;

  const ws = () =>
    (globalThis as Record<string, unknown>).__harnessWsClient as {
      deliver(m: EncryptedWebSocketMessage): Promise<void>;
      hasHandler(): boolean;
    };

  /** Both stored space rows as one comparable string, for change detection. */
  const snapshotSpaces = () => JSON.stringify([getSpace(SPACE_A), getSpace(SPACE_B)]);

  beforeAll(async () => {
    __resetAllMMKV();
    crypto = new NativeCryptoProvider();

    // Capture warnings without silencing them: the handler's own
    // `[space-manifest] dropped: …` lines are the trace a failing run is read
    // with, and swallowing them would make this harder to debug, not easier.
    const originalWarn = console.warn.bind(console);
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '));
      originalWarn(...args);
    };
    restoreWarn = () => {
      console.warn = originalWarn;
    };

    ownerA = await makeOwnerKey(crypto);
    strangerKey = await makeOwnerKey(crypto);

    // The victim is the device under test. Built through mobile's own onboarding
    // key code, with no registration upload — nothing here needs a relay, and a
    // harness that registered would mint a device per run.
    const victimEd = await crypto.generateEd448();
    const victimPublicKeyHex = hex(victimEd.public_key);
    await storePrivateKey(hex(victimEd.private_key));
    await storePublicKey(victimPublicKeyHex);
    await initializeEncryptionKeys(victimPublicKeyHex);

    // ---- space A: the delivering space, owned by the attacker ----
    const hubA = await crypto.generateEd448();
    const configA = await crypto.generateX448();
    const inboxA = await crypto.generateX448();
    configPublicKeyA = hex(configA.public_key);
    // Space frames are routed by the INBOX key's address, not the hub's
    // (spaceStorage.getSpaceInboxAddress reads `space_key:<id>:inbox`). Leaving
    // it unset makes getAllSpaceInboxAddresses skip the space entirely, the
    // frame is then not recognised as a space message, and the whole receive
    // path is silently bypassed — which reads as "nothing was overwritten".
    inboxAddressA = deriveInboxAddress(hex(inboxA.public_key));

    saveSpace(
      space({
        spaceId: SPACE_A,
        channelId: CHANNEL_A,
        hubAddress: deriveInboxAddress(hex(hubA.public_key)),
        spaceName: NAME_A,
      })
    );
    saveSpaceKey({
      spaceId: SPACE_A,
      keyId: 'hub',
      publicKey: hex(hubA.public_key),
      privateKey: hex(hubA.private_key),
      address: deriveInboxAddress(hex(hubA.public_key)),
    });
    saveSpaceKey({
      spaceId: SPACE_A,
      keyId: 'config',
      publicKey: configPublicKeyA,
      privateKey: hex(configA.private_key),
    });
    saveSpaceKey({
      spaceId: SPACE_A,
      keyId: 'inbox',
      publicKey: hex(inboxA.public_key),
      privateKey: hex(inboxA.private_key),
      address: inboxAddressA,
    });

    // ---- space B: a second space the victim is in, and the attacker is not ----
    // Fully keyed, so it is a genuinely joined space rather than a stub row. Its
    // config key is generated here and never leaves this scope — the attacker
    // cannot encrypt to it, which is precisely why the attack has to be
    // delivered through A.
    const hubB = await crypto.generateEd448();
    const configB = await crypto.generateX448();
    const inboxB = await crypto.generateX448();
    saveSpace(
      space({
        spaceId: SPACE_B,
        channelId: CHANNEL_B,
        hubAddress: deriveInboxAddress(hex(hubB.public_key)),
        spaceName: NAME_B,
        inviteUrl: INVITE_B,
      })
    );
    saveSpaceKey({
      spaceId: SPACE_B,
      keyId: 'hub',
      publicKey: hex(hubB.public_key),
      privateKey: hex(hubB.private_key),
      address: deriveInboxAddress(hex(hubB.public_key)),
    });
    saveSpaceKey({
      spaceId: SPACE_B,
      keyId: 'config',
      publicKey: hex(configB.public_key),
      privateKey: hex(configB.private_key),
    });
    saveSpaceKey({
      spaceId: SPACE_B,
      keyId: 'inbox',
      publicKey: hex(inboxB.public_key),
      privateKey: hex(inboxB.private_key),
      address: deriveInboxAddress(hex(inboxB.public_key)),
    });

    // ---- the one stubbed call: who owns a space, per the server ----
    // Replaced on the real singleton rather than jest.mock'd, so every OTHER
    // method of the real client stays real for whatever the provider does at
    // mount. Space A names ownerA; space B names an unrelated key, so no answer
    // here can be mistaken for the attacker having rights in B.
    const ownerBPlaceholder = await makeOwnerKey(crypto);
    const registrations: Record<string, string[]> = {
      [SPACE_A]: [ownerA.publicKeyHex],
      [SPACE_B]: [ownerBPlaceholder.publicKeyHex],
    };
    (
      getQuorumClient() as unknown as {
        getSpaceRegistration: (id: string) => Promise<unknown>;
      }
    ).getSpaceRegistration = async (spaceAddress: string) => {
      const owners = registrations[spaceAddress];
      if (!owners) throw new Error(`[harness] no registration for ${spaceAddress}`);
      return {
        space_address: spaceAddress,
        space_public_key: '',
        space_signature: '',
        config_public_key: '',
        owner_public_keys: owners,
        owner_signatures: [],
        timestamp: T_BASE,
      };
    };

    // ---- mount mobile's real provider ----
    const user: UserInfo = {
      address: deriveAddress(victimPublicKeyHex as never),
      quilibriumAddress: '',
      publicKey: victimPublicKeyHex,
      displayName: 'victim',
      privacyLevel: 'standard',
    };
    const notUsed = (fn: string) => () => {
      throw new Error(`[harness] AuthContext.${fn} is not implemented for this scenario`);
    };
    const auth = {
      authState: 'authenticated' as const,
      user,
      isAuthenticated: true,
      isLoading: false,
      farcasterAuthToken: null,
      signIn: notUsed('signIn'),
      signOut: notUsed('signOut'),
      updateProfile: notUsed('updateProfile'),
      signMessage: notUsed('signMessage'),
      refreshFarcasterToken: notUsed('refreshFarcasterToken'),
    };

    // Seed the two space caches the handler writes to. Without this they are
    // empty, `setQueryData(spaces.all, old => !old ? old : …)` short-circuits,
    // and any assertion about cache laundering would be unfalsifiable — green
    // whether or not the defect is present. Seeded with the genuine rows, so a
    // cross-space write shows up as a changed value rather than an appearance.
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData(queryKeys.spaces.detail(SPACE_A), getSpace(SPACE_A));
    queryClient.setQueryData(queryKeys.spaces.detail(SPACE_B), getSpace(SPACE_B));
    queryClient.setQueryData(queryKeys.spaces.all, [getSpace(SPACE_A), getSpace(SPACE_B)]);

    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(
            AuthContext.Provider,
            { value: auth },
            React.createElement(
              StorageContext.Provider,
              { value: getMMKVAdapter() },
              React.createElement(WebSocketProvider, null, null)
            )
          )
        )
      );
    });
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;

    // The provider's own connect effect installs the handler. Wait for it rather
    // than assuming a mount ordering.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !ws()?.hasHandler()) {
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  afterAll(async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => {
      renderer?.unmount();
    });
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;
    restoreWarn?.();
    __resetAllMMKV();
  });

  /**
   * Deliver a manifest through space A's inbox, as the relay would, and return
   * the warnings this delivery produced.
   */
  async function deliverViaSpaceA(params: {
    owner: OwnerKey;
    claimAsPublicKeyHex?: string;
    payloadSpace: Space;
    timestamp: number;
  }): Promise<string[]> {
    const control = await buildManifestControl({
      crypto,
      owner: params.owner,
      claimAsPublicKeyHex: params.claimAsPublicKeyHex,
      deliveringConfigPublicKeyHex: configPublicKeyA,
      payloadSpace: params.payloadSpace,
      timestamp: params.timestamp,
    });
    const encryptedContent = await sealForSpace(
      crypto,
      configPublicKeyA,
      inboxAddressA,
      control
    );

    const before = warnings.length;
    const stateBefore = snapshotSpaces();
    await act(async () => {
      await ws().deliver({
        encryptedContent,
        inboxAddress: inboxAddressA,
        timestamp: params.timestamp,
      });
    });

    // There is nothing to await here: `throttledMessageHandler` queues the frame
    // and calls processMessageQueue() WITHOUT awaiting it, so the settle wait is
    // load-bearing rather than paranoia.
    //
    // 250ms is the sibling scenario's proven baseline and is kept as a MINIMUM,
    // then extended while nothing has been observed. A purely fixed wait is a
    // silent correctness risk on a security test in one direction specifically:
    // too short, and a real cross-space overwrite lands just after the assertion
    // reads storage — reporting GREEN against a live defect. Extending costs
    // nothing in the normal case, because every outcome announces itself. A
    // refused frame emits a `[space-manifest]` warning; an applied one changes a
    // stored row.
    await new Promise((r) => setTimeout(r, 250));
    const deadline = Date.now() + 5_000;
    while (
      Date.now() < deadline &&
      warnings.length === before &&
      snapshotSpaces() === stateBefore
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }
    // The storage write, the bindings mirror and the three cache writes are
    // separate statements, and whichever lands first is what ended the wait
    // above. Let the rest arrive before any arm reads them.
    await new Promise((r) => setTimeout(r, 150));

    return warnings.slice(before);
  }

  /** The payload an attacker sends: space B's row, their content. */
  const forgedSpaceB = () =>
    space({
      spaceId: SPACE_B,
      channelId: CHANNEL_B,
      hubAddress: 'attacker-chosen-hub',
      spaceName: FORGED_NAME,
      inviteUrl: FORGED_INVITE,
      modifiedDate: T_ATTACK,
    });

  // ---- preconditions ----
  // A run where the bench never came up produces the same "space B is intact"
  // reading as a correctly-scoped manifest. Assert the bench first.

  it('PRECONDITION: the provider mounted and installed its message handler', () => {
    expect(ws()?.hasHandler()).toBe(true);
  });

  it('PRECONDITION: both spaces are stored under their own names', () => {
    expect(getSpace(SPACE_A)?.spaceName).toBe(NAME_A);
    expect(getSpace(SPACE_B)?.spaceName).toBe(NAME_B);
    expect(getSpace(SPACE_B)?.inviteUrl).toBe(INVITE_B);
  });

  // ---- control: the owner gate is live ----

  it('CONTROL: a manifest signed by a key outside the registration is refused', async () => {
    const emitted = await deliverViaSpaceA({
      owner: strangerKey,
      payloadSpace: forgedSpaceB(),
      timestamp: T_FORGED_OWNER,
    });

    // Nothing moved, and the handler named the gate that stopped it. This is
    // the arm that proves the ONE stubbed call still discriminates: if
    // `getSpaceRegistration` were waving every key through, this would go red.
    //
    // Note precisely what it does NOT prove. The rejection happens at the
    // registration lookup (WebSocketContext.tsx:1840), which returns before
    // `verifyEd448` is ever called — so signature verification is untested
    // here. That is the next arm's job.
    expect(getSpace(SPACE_B)?.spaceName).toBe(NAME_B);
    expect(getSpace(SPACE_A)?.spaceName).toBe(NAME_A);
    expect(emitted.some((w) => /\[space-manifest\].*owner key not in registration/.test(w))).toBe(
      true
    );
  });

  it('CONTROL: a manifest claiming a registered owner but signed by another key is refused', async () => {
    // Reaches the Ed448 check, which the arm above never does: the claimed key
    // IS in space A's registration, so the membership gate passes and the
    // signature is what has to fail.
    //
    // Without this, a harness signing shim whose verify always returned true
    // would be invisible, and every arm that reasons from "the frame was
    // genuinely authenticated" would be resting on an unchecked assumption.
    const emitted = await deliverViaSpaceA({
      owner: strangerKey,
      claimAsPublicKeyHex: ownerA.publicKeyHex,
      payloadSpace: forgedSpaceB(),
      timestamp: T_FORGED_SIGNATURE,
    });

    expect(getSpace(SPACE_B)?.spaceName).toBe(NAME_B);
    expect(getSpace(SPACE_A)?.spaceName).toBe(NAME_A);
    expect(emitted.some((w) => /\[space-manifest\].*signature invalid/.test(w))).toBe(true);
  });

  // ---- the invariant ----

  it('a manifest delivered through space A does NOT rewrite space B', async () => {
    const emitted = await deliverViaSpaceA({
      owner: ownerA,
      payloadSpace: forgedSpaceB(),
      timestamp: T_ATTACK,
    });
    attackDelivered = true;

    // The row belongs to space B. Space A delivered the manifest, the signer
    // owns A and only A, and B's config key never left this file.
    expect(getSpace(SPACE_B)?.spaceName).toBe(NAME_B);
    expect(getSpace(SPACE_B)?.inviteUrl).toBe(INVITE_B);

    // The refusal must come from the SCOPE decision, not from an earlier gate.
    // This warning fires only past unseal, owner lookup, Ed448 verification,
    // config-key decrypt and the staleness guard — so a future regression that
    // rejects this frame earlier (a broken config key, a changed signature
    // construction) fails here instead of passing green on a dead bench.
    expect(emitted.some((w) => /\[space-manifest\].*refusing cross-space write/.test(w))).toBe(
      true
    );
  });

  it('NO LAUNDERING: the delivering space is not rewritten with the foreign payload either', () => {
    // This arm reads the aftermath of the previous arm's delivery; it makes none
    // of its own. Without an attack to inspect, every assertion below is
    // trivially true — so refuse to report on a bench that never attacked.
    expect(attackDelivered).toBe(true);

    // Guards the wrong repair. Reassigning the payload's spaceId to the
    // delivering space and saving anyway would satisfy the invariant above while
    // importing attacker-chosen channels, roles and inviteUrl into space A.
    expect(getSpace(SPACE_A)?.spaceName).toBe(NAME_A);
    expect(getSpace(SPACE_A)?.inviteUrl).toBe('');

    // Storage and cache are written from DIFFERENT identifiers one statement
    // apart in the handler, so the caches need their own assertions: a
    // cache-only write is still a real client-state change, and it is what the
    // UI reads. Both keys are pre-seeded in beforeAll precisely so these can be
    // unconditional — an `if (cached)` here would pass on an empty cache, which
    // is the same vacuous shape the flag above exists to prevent.
    const cachedDetail = queryClient.getQueryData<Space>(queryKeys.spaces.detail(SPACE_A));
    expect(cachedDetail?.spaceId).toBe(SPACE_A);
    expect(cachedDetail?.spaceName).toBe(NAME_A);

    // The list cache is updated by `old.map(s => s.spaceId === spaceId ? …)`, so
    // pre-fix the forged payload replaces space A's ENTRY while keeping the
    // list's shape — a corruption the detail key alone would not reveal.
    const cachedList = queryClient.getQueryData<Space[]>(queryKeys.spaces.all);
    expect(cachedList?.map((s) => s.spaceId)).toEqual([SPACE_A, SPACE_B]);
    expect(cachedList?.find((s) => s.spaceId === SPACE_A)?.spaceName).toBe(NAME_A);
  });

  // ---- control: the path can still carry a legitimate manifest ----

  it('CONTROL: a manifest naming the delivering space still applies to it', async () => {
    // Same builder, same wire, same handler — the only difference is that the
    // payload names the space it arrived on. If scoping the write also broke
    // this, the fix would be over-blocking and every real space rename, channel
    // change and permission update would stop reaching mobile.
    expect(getSpace(SPACE_A)?.spaceName).toBe(NAME_A);

    await deliverViaSpaceA({
      owner: ownerA,
      payloadSpace: space({
        spaceId: SPACE_A,
        channelId: CHANNEL_A,
        hubAddress: getSpace(SPACE_A)!.hubAddress,
        spaceName: RENAMED_A,
        modifiedDate: T_LEGITIMATE,
      }),
      timestamp: T_LEGITIMATE,
    });

    expect(getSpace(SPACE_A)?.spaceName).toBe(RENAMED_A);
    // And it stayed inside its own space while doing so.
    expect(getSpace(SPACE_B)?.spaceName).toBe(NAME_B);
  });
});
