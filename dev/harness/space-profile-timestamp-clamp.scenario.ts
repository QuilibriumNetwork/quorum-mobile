// Can a sender-chosen timestamp pin a member's profile permanently?
//
// ── What this measures ──────────────────────────────────────────────────────
//
// Both `update-profile` receive handlers stamp the merged member row with
// `spaceMessage.createdDate` and then use that stamp as a last-write-wins
// high-water mark: a later update is applied only when its own timestamp is
// strictly newer (`!(existing.profileTimestamp >= ts)`).
//
// `createdDate` is a wire field. The sender picks it, and nothing bounded it.
//
// So the damage from any accepted write is not limited to that write. A value
// far enough in the future is written into the row as the high-water mark, and
// every subsequent update — including the rightful owner's own correction — is
// then refused by the same comparison that let it in. One frame becomes a
// permanent state change with no path back.
//
// The INVARIANT under test, stated positively (it is what the assertions say):
//
//     a profile stamp taken from the wire may never be in the future, so a
//     member can always correct their own row with a later genuine update.
//
// ── The door this uses, and why it is still open ────────────────────────────
//
// The companion scenario (`space-update-profile-identity`) bounds the
// unregistered-key exemption to CREATION: a key bound to nobody may introduce a
// member this device has no row for, but may not rewrite one it has. Creation
// stays open deliberately — it is mobile's only roster-population path, since
// the space manifest carries no member list.
//
// That open door is exactly what makes this finding worth fixing on its own.
// An attacker can still INTRODUCE a row for a member this device has not seen,
// and with an unbounded stamp that introduction is permanent: the real member's
// own later update is refused, so they wear the attacker's chosen name until
// the row is rebuilt from scratch. Clamping is what turns that from permanent
// into correctable, and it holds regardless of what happens to the creation
// half.
//
// ── Why the arms are shaped this way ────────────────────────────────────────
//
//   1. CONTROL (last-write-wins is live, and survives the clamp) — a member
//      updates their own profile, then a genuinely OLDER update from the same
//      member must not overwrite it.
//
//      This arm does double duty and is the reason the fix is a clamp rather
//      than a reset. It proves the LWW guard is actually running, so the
//      refusal in arm 2 is attributable to it. And it is the over-block guard:
//      the lazy repair — stamp every row with the receiver's own `Date.now()`
//      and ignore the wire — would make the LATER-ARRIVING message always win
//      regardless of when it was created, so this arm would go red. `Math.min`
//      only ever pulls a stamp backward, which is what keeps honest ordering
//      (including a queue-delayed message) intact.
//
//   2. THE INVARIANT — an introduction carrying a year-2099 stamp must not
//      prevent the member's own genuine correction from applying. Its three
//      steps are one `it` on purpose: steps 2 and 3 read step 1's aftermath,
//      and splitting them would create an arm that passes vacuously when run
//      alone with `-t` or `.only`.
//
//      It asserts the stored stamp directly (`<= now`) as well as the
//      downstream effect. The direct assertion is what distinguishes "the
//      clamp worked" from "the correction happened to win for some other
//      reason".
//
// ── How faithful this is, and where it stops ────────────────────────────────
//
// REAL: mobile's `WebSocketProvider` and its `handleIncomingMessage` receive
// path, the whole `update-profile` handler including both staleness slots, the
// real `announce-keys` statement path, real member storage on the real MMKV
// shim, real X448 envelope encryption and real Ed448 signing. Every frame is
// signed with a real key over the shared `buildMessageFingerprint`.
//
// NOT real, and deliberately:
//   - The socket, replaced by an in-process fake so a frame reaches the
//     provider's OWN message handler without a relay.
//   - The counterparties are keypairs and frames, not second running clients;
//     joining a space headlessly needs native-only `tripleRatchetResizeForInvites`.
//   - ⚠️ ONLY THE PER-MESSAGE RECEIVE PATH IS EXERCISED. The native batch
//     catch-up handler carries the same stamp line and gets the same clamp, but
//     `batchProcessMessages` / `batchUnsealEnvelopes` are native-only and throw
//     here, so that half is symmetry, not measurement. Unlike the authorization
//     bound in the companion scenario — which lives in one shared function —
//     this IS two edits, and only one of them is measured.
//
// Run: npx jest --config jest.harness.config.js space-profile-timestamp-clamp --forceExit
//
// No relay, no account registration, no persisted device. One exception,
// inherited from the receive path: after processing a space frame the handler
// fires a best-effort server-side inbox cleanup, fire-and-forget and
// `.catch`-swallowed. It targets an address derived from a key generated in
// this run, so it can only ever reach an inbox nobody owns.

import React from 'react';
import { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  buildDeviceKeyStatementBytes,
  buildMessageFingerprint,
  computeMessageIdHex,
  deriveInboxAddress,
  logger,
  type AnnounceKeysStatement,
  type Channel,
  type EncryptedWebSocketMessage,
  type Message,
  type Space,
  type SpaceMember,
} from '@quilibrium/quorum-shared';

import { __resetAllMMKV } from './mmkv-shim';
import { NativeCryptoProvider } from './wasm-provider-shim';
import { NativeSigningProvider } from './wasm-signing-shim';

// The socket seam. See space-update-profile-identity.scenario.ts for why the
// fake is parked on globalThis rather than closed over.
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

import AuthContext, { type UserInfo } from '@/context/AuthContext';
import StorageContext from '@/context/StorageContext';
import { WebSocketProvider } from '@/context/WebSocketContext';
import { saveSpace, saveSpaceKey } from '@/services/config/spaceStorage';
import { getMMKVAdapter } from '@/services/storage/mmkvAdapter';
import { deriveAddress, initializeEncryptionKeys } from '@/services/onboarding/keyService';
import { storePrivateKey, storePublicKey } from '@/services/onboarding/secureStorage';

const SPACE_A = 'harness-space-profile-timestamp-clamp';
const CHANNEL_A = 'harness-channel-profile-timestamp-clamp';

const ORDINARY_FIRST = 'ordinary-name-set-later';
const ORDINARY_STALE = 'ordinary-name-from-an-older-message';
const PINNED_FORGED = 'pinned-by-a-year-2099-timestamp';
const PINNED_CORRECTED = 'corrected-by-the-real-member';

// Timestamps must be genuinely in the PAST relative to the wall clock, because
// the clamp under test is `Math.min(wireValue, now)`. A ladder set in the
// future would be flattened to `now` on arrival, every arm's stamp would
// collapse to "whenever the test happened to run", and the ordering these
// constants are supposed to fix would silently become a race against real
// elapsed milliseconds.
const T_BASE = 1_700_000_000_000; // 2023-11-14, comfortably past
const T_ORDINARY_NEW = T_BASE + 10_000;
const T_ORDINARY_OLD = T_BASE + 5_000;

/** The forged claim: year 2099. The whole point is that nothing bounded it. */
const T_FORGED_FUTURE = 4_100_000_000_000;

const hex = (b: ArrayLike<number>) => Buffer.from(Uint8Array.from(b)).toString('hex');
const b64 = (b: ArrayLike<number>) => Buffer.from(Uint8Array.from(b)).toString('base64');
const b64ToHex = (s: string) => Buffer.from(s, 'base64').toString('hex');

interface Signer {
  address: string;
  publicKeyHex: string;
  privateKeyHex: string;
  inboxAddress: string;
}

async function makeSigner(crypto: NativeCryptoProvider): Promise<Signer> {
  const ed = await crypto.generateEd448();
  const publicKeyHex = hex(ed.public_key);
  const privateKeyHex = hex(ed.private_key);
  return {
    address: deriveAddress(publicKeyHex as never),
    publicKeyHex,
    privateKeyHex,
    inboxAddress: deriveInboxAddress(publicKeyHex),
  };
}

function member(s: Signer, fields: Partial<SpaceMember> = {}): SpaceMember {
  return {
    address: s.address,
    user_address: s.address,
    inbox_address: s.inboxAddress,
    joinedAt: 1,
    ...fields,
  } as SpaceMember;
}

function channel(spaceId: string, channelId: string): Channel {
  return { channelId, spaceId, channelName: channelId, createdDate: 1, modifiedDate: 1 };
}

function space(spaceId: string, channelId: string, hubAddress: string): Space {
  return {
    spaceId,
    spaceName: spaceId,
    vanityUrl: '',
    inviteUrl: '',
    iconUrl: '',
    bannerUrl: '',
    defaultChannelId: channelId,
    hubAddress,
    createdDate: 1,
    modifiedDate: 1,
    isRepudiable: false,
    isPublic: false,
    groups: [{ groupName: 'general', channels: [channel(spaceId, channelId)] }],
    roles: [],
    emojis: [],
    stickers: [],
  };
}

async function buildProfileFrame(params: {
  signer: Signer;
  claimSenderId: string;
  displayName: string;
  createdDate: number;
  nonce: string;
}): Promise<Message> {
  const content = {
    type: 'update-profile' as const,
    senderId: params.claimSenderId,
    displayName: params.displayName,
    userIcon: '',
  };
  const fingerprint = buildMessageFingerprint({
    nonce: params.nonce,
    content: content as Parameters<typeof buildMessageFingerprint>[0]['content'],
    senderId: params.claimSenderId,
    spaceId: SPACE_A,
    channelId: CHANNEL_A,
  });
  const messageId = computeMessageIdHex(fingerprint);
  const signatureB64 = await new NativeSigningProvider().signEd448(
    b64(Buffer.from(params.signer.privateKeyHex, 'hex')),
    b64(Buffer.from(messageId, 'hex'))
  );

  return {
    channelId: CHANNEL_A,
    spaceId: SPACE_A,
    messageId,
    digestAlgorithm: 'sha256',
    nonce: params.nonce,
    // The subject of this scenario. It is a plain wire field, and the sender
    // writes whatever it likes here.
    createdDate: params.createdDate,
    modifiedDate: params.createdDate,
    lastModifiedHash: '',
    content,
    reactions: [],
    mentions: {} as Message['mentions'],
    publicKey: params.signer.publicKeyHex,
    signature: b64ToHex(signatureB64),
  };
}

/** A master-signed announce-keys payload, so a device's signing key is admitted. */
async function buildAnnounceKeysControl(params: {
  master: Signer;
  deviceSigningPublicKeyHex: string;
  timestamp: number;
}): Promise<string> {
  const statement: AnnounceKeysStatement = {
    type: 'announce-keys',
    userAddress: deriveInboxAddress(params.master.publicKeyHex),
    userPublicKey: params.master.publicKeyHex,
    spaceId: SPACE_A,
    deviceInboxAddress: deriveInboxAddress(params.deviceSigningPublicKeyHex),
    spaceKeyPublicKey: params.deviceSigningPublicKeyHex,
    timestamp: params.timestamp,
    signature: '',
  };
  const signatureB64 = await new NativeSigningProvider().signEd448(
    b64(Buffer.from(params.master.privateKeyHex, 'hex')),
    b64(new TextEncoder().encode(buildDeviceKeyStatementBytes(statement)))
  );
  statement.signature = b64ToHex(signatureB64);
  return JSON.stringify({ type: 'control', message: statement });
}

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

describe('a wire timestamp cannot pin a member profile in the future', () => {
  let crypto: NativeCryptoProvider;
  /** An ordinary member with a bound key — the last-write-wins control. */
  let ordinary: Signer;
  /** The impersonation target. Has NO row, so the creation door applies. */
  let pinned: Signer;
  /** The target's own signing key, admitted via announce-keys. */
  let pinnedDevice: Signer;
  /** Bound to nobody. */
  let impostor: Signer;

  let inboxAddressA: string;
  let configPublicKeyA: string;
  let renderer: { unmount: () => void } | undefined;

  const logLines: string[] = [];
  let restoreConsole: (() => void) | undefined;
  const DECISION_LINE = /\[SpaceMsg\]|\[BatchMsg\]|\[update-profile\]|\[DeviceKeys\]/;

  const ws = () =>
    (globalThis as Record<string, unknown>).__harnessWsClient as {
      deliver(m: EncryptedWebSocketMessage): Promise<void>;
      hasHandler(): boolean;
    };

  const storedMember = (address: string) =>
    getMMKVAdapter().getSpaceMember(SPACE_A, address) as Promise<
      (SpaceMember & { profileTimestamp?: number }) | undefined
    >;

  const snapshotMembers = async () =>
    JSON.stringify(await getMMKVAdapter().getSpaceMembers(SPACE_A));

  beforeAll(async () => {
    __resetAllMMKV();
    crypto = new NativeCryptoProvider();

    // This path reports refusals at `debug`, and shim.ts leaves the shared
    // logger at minLevel 'log' unless HARNESS_LOG_DEBUG=1. Raising it here is
    // what makes the settle loop's decision signal observable. Scoped to this
    // file: jest gives each suite its own module registry.
    logger.configure({ minLevel: 'debug' });

    const echoDebug = process.env.HARNESS_LOG_DEBUG === '1';
    const originalWarn = console.warn.bind(console);
    const originalDebug = console.debug.bind(console);
    console.warn = (...args: unknown[]) => {
      logLines.push(args.map((a) => String(a)).join(' '));
      originalWarn(...args);
    };
    console.debug = (...args: unknown[]) => {
      logLines.push(args.map((a) => String(a)).join(' '));
      if (echoDebug) originalDebug(...args);
    };
    restoreConsole = () => {
      console.warn = originalWarn;
      console.debug = originalDebug;
    };

    ordinary = await makeSigner(crypto);
    pinned = await makeSigner(crypto);
    pinnedDevice = await makeSigner(crypto);
    impostor = await makeSigner(crypto);

    const victim = await makeSigner(crypto);
    await storePrivateKey(victim.privateKeyHex);
    await storePublicKey(victim.publicKeyHex);
    await initializeEncryptionKeys(victim.publicKeyHex);

    const hubA = await crypto.generateEd448();
    const configA = await crypto.generateX448();
    const inboxA = await crypto.generateX448();
    configPublicKeyA = hex(configA.public_key);
    // Space frames route by the INBOX key's address, not the hub's. Leave it
    // unset and the space is skipped entirely, the frame is never recognised
    // as a space message, and the whole receive path is silently bypassed —
    // which reads as "nothing was overwritten".
    inboxAddressA = deriveInboxAddress(hex(inboxA.public_key));

    saveSpace(space(SPACE_A, CHANNEL_A, deriveInboxAddress(hex(hubA.public_key))));
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

    // `ordinary` is a member. `pinned` deliberately is NOT — its row is the one
    // the forged introduction creates.
    await getMMKVAdapter().saveSpaceMember(
      SPACE_A,
      member(ordinary, { display_name: 'ordinary' })
    );

    const user: UserInfo = {
      address: victim.address,
      quilibriumAddress: '',
      publicKey: victim.publicKeyHex,
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

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

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
    restoreConsole?.();
    __resetAllMMKV();
  });

  async function deliverToSpace(plaintext: string, timestamp: number): Promise<string[]> {
    const encryptedContent = await sealForSpace(
      crypto,
      configPublicKeyA,
      inboxAddressA,
      plaintext
    );

    const before = logLines.length;
    const stateBefore = await snapshotMembers();
    const sawDecision = () => logLines.slice(before).some((l) => DECISION_LINE.test(l));

    await act(async () => {
      await ws().deliver({ encryptedContent, inboxAddress: inboxAddressA, timestamp });
    });

    // `throttledMessageHandler` queues the frame and calls processMessageQueue()
    // WITHOUT awaiting it, so the settle wait is load-bearing. 250ms is the
    // sibling scenarios' proven baseline, kept as a MINIMUM and then extended
    // while nothing has been observed — a purely fixed wait is a one-sided risk
    // on a security test, because too short reports GREEN against a real write
    // that lands just after the assertion reads storage.
    await new Promise((r) => setTimeout(r, 250));
    const deadline = Date.now() + 5_000;
    while (
      Date.now() < deadline &&
      !sawDecision() &&
      (await snapshotMembers()) === stateBefore
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 150));

    return logLines.slice(before);
  }

  async function deliverProfile(params: {
    signer: Signer;
    claimSenderId: string;
    displayName: string;
    createdDate: number;
    nonce: string;
  }): Promise<string[]> {
    const frame = await buildProfileFrame(params);
    return deliverToSpace(JSON.stringify({ type: 'message', message: frame }), params.createdDate);
  }

  it('PRECONDITION: the provider mounted and installed its message handler', () => {
    expect(ws()?.hasHandler()).toBe(true);
  });

  it('PRECONDITION: the ordinary member has a row and the target does not', async () => {
    expect((await storedMember(ordinary.address))?.display_name).toBe('ordinary');
    expect(await storedMember(pinned.address)).toBeUndefined();
  });

  it('CONTROL: last-write-wins is live, and a genuinely older update does not win', async () => {
    // Proves the LWW comparison is actually running, so the refusal the
    // invariant arm exercises is attributable to it rather than to some other
    // gate.
    //
    // It is also the over-block guard for the shape of the fix. The lazy
    // repair — ignore the wire and stamp every row with the receiver's own
    // `Date.now()` — would make the later-ARRIVING message win regardless of
    // when it was created, so the stale update below would take effect and
    // this arm would go red. Clamping with `Math.min` can only pull a stamp
    // backward, which leaves honest ordering (and queue-delayed messages)
    // intact.
    await deliverProfile({
      signer: ordinary,
      claimSenderId: ordinary.address,
      displayName: ORDINARY_FIRST,
      createdDate: T_ORDINARY_NEW,
      nonce: 'nonce-ordinary-new',
    });
    expect((await storedMember(ordinary.address))?.display_name).toBe(ORDINARY_FIRST);

    await deliverProfile({
      signer: ordinary,
      claimSenderId: ordinary.address,
      displayName: ORDINARY_STALE,
      createdDate: T_ORDINARY_OLD,
      nonce: 'nonce-ordinary-old',
    });
    expect((await storedMember(ordinary.address))?.display_name).toBe(ORDINARY_FIRST);
  });

  it('a year-2099 stamp does not pin a profile: the member can still correct it', async () => {
    // Three steps in ONE arm on purpose. Steps 2 and 3 read step 1's
    // aftermath, so as separate `it` blocks either could be run alone with
    // `-t` / `.only` against a pristine bench and pass while proving nothing.

    // ---- 1. the member's own device announces the key it signs with ----
    // Needed so the correction in step 3 is AUTHORIZED and the only thing left
    // deciding its fate is the timestamp. Without it the correction would be
    // refused by the identity bound instead, and this arm would go red for a
    // reason that has nothing to do with the clamp.
    await deliverToSpace(
      await buildAnnounceKeysControl({
        master: pinned,
        deviceSigningPublicKeyHex: pinnedDevice.publicKeyHex,
        // Real clock: announce-keys is skew-bounded against `Date.now()`
        // (DEVICE_KEY_STATEMENT_MAX_SKEW_MS), unlike the profile ladder.
        timestamp: Date.now(),
      }),
      T_ORDINARY_NEW
    );
    const admitted = (await getMMKVAdapter().getSpaceMemberDevices(SPACE_A)).find(
      (d) => d.inboxAddress === pinnedDevice.inboxAddress
    );
    expect(admitted?.userAddress).toBe(pinned.address);

    // ---- 2. an unbound key INTRODUCES the member, claiming the year 2099 ----
    // Introduction is still permitted (roster bootstrap), so this write lands
    // either way — which is what makes the arm meaningful rather than a test of
    // the identity bound.
    await deliverProfile({
      signer: impostor,
      claimSenderId: pinned.address,
      displayName: PINNED_FORGED,
      createdDate: T_FORGED_FUTURE,
      nonce: 'nonce-forged-future',
    });

    const introduced = await storedMember(pinned.address);
    // The frame was honored. Without this the next assertions could pass on a
    // frame that never arrived at all.
    expect(introduced?.display_name).toBe(PINNED_FORGED);

    // The direct measurement of the fix, independent of any downstream effect:
    // whatever the sender claimed, the stored clock is not in the future.
    expect(introduced?.profileTimestamp).toBeLessThanOrEqual(Date.now());

    // ---- 3. the real member corrects their own row ----
    // A real clock reading, taken AFTER the forged write has been processed.
    // The clamp pulls the forged stamp down to roughly "now at arrival", so a
    // correction sent afterwards is genuinely newer — which is exactly the
    // real-world sequence. A fixed past constant would legitimately lose the
    // LWW comparison and would say nothing about the clamp.
    const correctionSentAt = Date.now();
    await deliverProfile({
      signer: pinnedDevice,
      claimSenderId: pinned.address,
      displayName: PINNED_CORRECTED,
      createdDate: correctionSentAt,
      nonce: 'nonce-correction',
    });

    expect((await storedMember(pinned.address))?.display_name).toBe(PINNED_CORRECTED);
  });
});
