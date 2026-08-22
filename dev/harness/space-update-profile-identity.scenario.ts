// Can a key that belongs to nobody rewrite an existing member's identity?
//
// ── What this measures ──────────────────────────────────────────────────────
//
// `isUpdateProfileAuthorized` (services/space/spaceMessageAuth.ts) verifies the
// Ed448 signature, then asks who the signing key belongs to. When the answer is
// NOBODY it returns true — a deliberate exemption, because an `update-profile`
// doubles as a key-rotation/bootstrap announcement and a rotated key
// legitimately matches no member row yet.
//
// The handler then applies the update to the member row named by
// `content.senderId` — a different, attacker-chosen identifier. Nothing ties the
// two together. The authorization reads the KEY; the mutation acts on the
// CLAIMED ADDRESS.
//
// Creating a row that way is a separate, known-blocked problem: the upsert is
// mobile's only roster-population path (the space manifest carries no member
// list), so suppressing creation would leave every new joiner with a half-empty
// member list. That half is NOT what this scenario is about, and arm 3 below
// exists specifically to prove it still works.
//
// The INVARIANT under test, stated positively (it is what the assertions say):
//
//     an update-profile whose signing key is bound to nobody may INTRODUCE a
//     member this device has never recorded; it may never REWRITE one it
//     already has.
//
// ── Why the arms are shaped this way ────────────────────────────────────────
//
// "The victim's name is unchanged" is trivially satisfied by a scenario that
// delivers nothing at all — a frame the provider never routed, a signature the
// app rejected, a config key that did not decrypt, a handler never reached.
// Every one of those reads as a pass. So the invariant arm is worthless alone
// and is bracketed by arms that make it mean something:
//
//   1. CONTROL (delivery + bootstrap) — the SAME throwaway key, over the same
//      wire and handler, naming an address with NO member row, DOES create one.
//      This arm does double duty. It proves the bench is alive, so silence in
//      the invariant arm is a decision rather than a dead rig. And it is the
//      over-block guard for the roster-population path the prior art refuses to
//      let us break. It runs FIRST for that reason.
//
//      Note what makes this a proper control: arms 1 and 3 differ in EXACTLY
//      one variable — whether a row already exists. Same key type, same
//      builder, same wire, same handler. So a refusal in arm 3 can only be
//      about the existing row.
//
//   2. CONTROL (the authorizer discriminates) — a key that IS registered to
//      member `knownMember`, claiming `target`'s senderId, is refused. This is
//      the rule that already exists, and it isolates the unknown-key branch as
//      the cause of arm 3 rather than some general breakage.
//
//   3. THE INVARIANT — a throwaway key claiming `target`'s senderId must not
//      touch `target`'s stored row.
//
//   4. CONTROL (over-block: rotation) — the regression the prior art warns
//      about, and the one that matters most here. A member's SECOND DEVICE
//      signs with its own per-space key, which is never written to the member
//      row's anchor, and announces it via a real master-signed `announce-keys`
//      frame delivered through this same receive path. That member's own
//      profile update must still apply. Without this arm, a fix that narrows
//      the unknown-key branch would silently break every multi-device user and
//      the run would still be green.
//
//   5. CONTROL (over-block: bootstrap then rename) — the most common
//      legitimate flow, and the one most at risk from the bound. A row created
//      by bootstrap carries an EMPTY anchor by design, which matches no signing
//      key — so on the member's NEXT update their own key looks unbound while
//      their row now exists, exactly the shape arm 3 refuses. If nothing else
//      bound that key, every member introduced this way would be frozen under
//      their introduction name forever on that device. This arm measures that
//      it is not, via the `announce-keys` admission.
//
//   6. ACCEPTED COST — the other side of arm 4. A second device whose
//      `announce-keys` has NOT yet been seen is, on the wire, indistinguishable
//      from the attacker in arm 3: a valid signature by a key bound to nobody,
//      naming a member who already has a row. No rule can accept one and refuse
//      the other, so refusing it is inherent to the bound rather than a defect
//      in it. This arm records the SHAPE of that cost — one dropped send, not a
//      poisoned row — and proves recovery once the admission lands. It is here
//      because an independent review raised the ordering risk, and an untested
//      cost is worse than an acknowledged one.
//
//   7. CONTROL (over-block: ordinary update) — a member updating their own
//      profile with their own registered key still applies.
//
//   8. NO COLLATERAL — the React Query members cache must also still show the
//      genuine identity. Storage and cache are written from separate statements
//      in the handler, and the cache is what the UI actually reads, so a
//      cache-only overwrite is still a real client-state change. Both caches
//      are seeded in beforeAll precisely so these assertions can be
//      unconditional; `setQueryData(members, old => !old ? old : …)`
//      short-circuits on an empty cache, which would make the assertion
//      unfalsifiable.
//
// ── What this scenario deliberately does NOT cover ──────────────────────────
//
// The LAST-WRITE-WINS half. `createdDate` is a wire field used as an LWW clock
// with no skew bound, so a far-future value makes any applied write permanent —
// the victim's own genuine correction is refused by the same rule. That is a
// SEPARATE finding with its own fix and its own instrument
// (`space-profile-timestamp-clamp.scenario.ts`); every timestamp here is
// ordinary and increasing, so nothing below depends on or measures it.
//
// ── How faithful this is, and where it stops ────────────────────────────────
//
// REAL: mobile's `WebSocketProvider` and its `handleIncomingMessage` receive
// path, the whole `update-profile` handler, `isUpdateProfileAuthorized` and the
// shared `resolveVerifiedSender` beneath it, the real `announce-keys` statement
// path (`processDeviceKeyStatement` + shared `verifyDeviceKeyStatement`), real
// member storage on the real MMKV shim, real X448 envelope encryption and real
// Ed448 signing. Every frame is signed with a real key over the shared
// `buildMessageFingerprint`, so no authorization logic is transcribed or
// stubbed anywhere in this file.
//
// NOT real, and deliberately:
//   - The socket. `createRNWebSocketClient` is replaced by an in-process fake so
//     the frame reaches the provider's OWN message handler without a relay.
//     What is under test is receive-side handling, not transport.
//   - The counterparties are keypairs and frames, not second running clients. A
//     genuine two-client space is not reachable headlessly at all: joining one
//     needs `tripleRatchetResizeForInvites`, which is native-only and throws in
//     this harness. Since the defect is entirely in how the RECEIVER handles a
//     frame it has already authenticated, the signing identity is the part that
//     has to be real, and it is.
//   - ⚠️ ONLY THE PER-MESSAGE RECEIVE PATH IS EXERCISED. `update-profile` has a
//     SECOND handler on the native batch catch-up path
//     (WebSocketContext.tsx, `case 'update-profile'` in the batch loop). It
//     cannot run here at any effort: `batchProcessMessages` /
//     `batchUnsealEnvelopes` are native-only and throw, which is exactly why
//     frames fall back to the per-message path this scenario drives.
//
//     What saves this from being #270's unmeasured-twin problem is WHERE the
//     guard lives: both handlers reach the same `isUpdateProfileAuthorized`,
//     so there is one guard, measured once, rather than two edits of which one
//     is measured. That the batch handler calls it is READ (one line), not
//     measured. Do not read a green run as covering the batch path.
//
// Run: npx jest --config jest.harness.config.js space-update-profile-identity --forceExit
//
// No relay, no account registration, no persisted device — nothing this
// scenario asserts on touches the network. One exception, inherited from the
// receive path itself: after processing a space frame the handler fires a
// best-effort server-side inbox cleanup (`deleteSpaceInboxMessages`),
// fire-and-forget and `.catch`-swallowed. It is left alone rather than
// suppressed, because suppressing it would mean altering the path under test.
// It targets an address derived from a key generated in this run, so it can
// only ever reach an inbox nobody owns.

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
  queryKeys,
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
import { saveSpace, saveSpaceKey } from '@/services/config/spaceStorage';
import { getMMKVAdapter } from '@/services/storage/mmkvAdapter';
import {
  deriveAddress,
  initializeEncryptionKeys,
} from '@/services/onboarding/keyService';
import { storePrivateKey, storePublicKey } from '@/services/onboarding/secureStorage';

const SPACE_A = 'harness-space-update-profile-identity';
const CHANNEL_A = 'harness-channel-update-profile-identity';

/** What `target`'s row holds before anything is delivered. */
const GENUINE_NAME = 'the-real-member';
const GENUINE_ICON = 'https://avatar.example/genuine.png';
/** What a successful impersonation would leave behind. Distinctive on purpose. */
const FORGED_NAME = 'impersonated-by-an-unregistered-key';
const FORGED_ICON = 'https://avatar.example/attacker.png';
/** The bootstrap arm's payload — a member this device has never recorded. */
const BOOTSTRAP_NAME = 'a-member-we-had-never-seen';
/** The rotation arm's payload, sent from a second device. */
const ROTATED_NAME = 'renamed-from-my-second-device';
/** The accepted-cost arm: sent before this device's key was ever admitted. */
const STRANDED_NAME = 'renamed-before-my-key-was-announced';
/** The bootstrap-then-rename arm: the name a new member is introduced under. */
const INTRODUCED_NAME = 'introduced-by-my-own-rebroadcast';
/** ...and the name they change to afterwards, on the same device. */
const REINTRODUCED_NAME = 'renamed-after-being-introduced';
/** The ordinary-update arm's payload, sent with the member's own anchor key. */
const SELF_UPDATED_NAME = 'renamed-by-my-own-registered-key';

// Fixed rather than Date.now(), so ordering between arms is deterministic and a
// re-run cannot trip the handler's own LWW staleness guard. Every value is an
// ordinary past timestamp: the unbounded-future-timestamp defect is a separate
// finding and is measured by its own scenario, not here.
const T_BASE = 1_800_000_000_000;
const T_BOOTSTRAP = T_BASE + 1_000;
const T_KNOWN_KEY_FORGERY = T_BASE + 2_000;
const T_ATTACK = T_BASE + 3_000;
const T_ROTATION = T_BASE + 4_000;
const T_BOOTSTRAP_INTRO = T_BASE + 4_400;
const T_BOOTSTRAP_RENAME = T_BASE + 4_600;
const T_STRANDED = T_BASE + 5_000;
const T_STRANDED_RECOVERED = T_BASE + 6_000;
const T_SELF_UPDATE = T_BASE + 7_000;

const hex = (b: ArrayLike<number>) => Buffer.from(Uint8Array.from(b)).toString('hex');
const b64 = (b: ArrayLike<number>) => Buffer.from(Uint8Array.from(b)).toString('base64');
const b64ToHex = (s: string) => Buffer.from(s, 'base64').toString('hex');

interface Signer {
  address: string;
  publicKeyHex: string;
  privateKeyHex: string;
  inboxAddress: string;
}

/** An Ed448 identity: enough to sign a space frame and be resolved as a member. */
async function makeSigner(crypto: NativeCryptoProvider): Promise<Signer> {
  const ed = await crypto.generateEd448();
  const publicKeyHex = hex(ed.public_key);
  const privateKeyHex = hex(ed.private_key);
  return {
    // Mobile's own derivation, so the member row and the frame agree by
    // construction rather than by a hand-built lookalike. `deriveAddress` and
    // shared `deriveInboxAddress` are the same construction (sha256 →
    // multihash → base58), which is what lets an announce-keys `userAddress`
    // match a member row's `address` in the rotation arm below.
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
    // Signatures are required for update-profile regardless of this flag;
    // false is simply the ordinary space shape.
    isRepudiable: false,
    isPublic: false,
    groups: [{ groupName: 'general', channels: [channel(spaceId, channelId)] }],
    roles: [],
    emojis: [],
    stickers: [],
  };
}

/**
 * Build an `update-profile` frame the way a sending client does: canonical
 * fingerprint (shared `buildMessageFingerprint`), messageId = its SHA-256, and
 * a real Ed448 signature over that hash.
 *
 * Two identifiers are deliberately independent here, because their divergence is
 * the whole subject:
 *   - `signer` — the keypair that actually signs. This is what
 *     `isUpdateProfileAuthorized` resolves an owner for.
 *   - `claimSenderId` — the address written into the body, which is what the
 *     handler looks the member row up by.
 *
 * They are the same for every honest sender. Setting them apart is the attack.
 *
 * `update-profile` is NOT a control type, so `buildMessageFingerprint` does not
 * scope-bind spaceId/channelId into it (shared messageAuth: `scope` is '' for
 * non-control types). They are still passed because the verifier passes them,
 * and passing different ones would be a signature mismatch on some future day
 * when that changes.
 */
async function buildProfileFrame(params: {
  signer: Signer;
  claimSenderId: string;
  displayName: string;
  userIcon: string;
  createdDate: number;
  nonce: string;
}): Promise<Message> {
  const content = {
    type: 'update-profile' as const,
    senderId: params.claimSenderId,
    displayName: params.displayName,
    userIcon: params.userIcon,
  };
  const fingerprint = buildMessageFingerprint({
    nonce: params.nonce,
    content: content as Parameters<typeof buildMessageFingerprint>[0]['content'],
    senderId: params.claimSenderId,
    spaceId: SPACE_A,
    channelId: CHANNEL_A,
  });
  const messageId = computeMessageIdHex(fingerprint);

  // Sign the hash bytes, base64 in/out — the contract
  // `verifySpaceMessageSignature` verifies against.
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

/**
 * Build a master-signed `announce-keys` control payload — the real statement a
 * second device sends so its own per-space signing key is admitted for its
 * owner.
 *
 * Signed over shared `buildDeviceKeyStatementBytes` (fixed field order,
 * newline-delimited, domain-prefixed) and carried as HEX, which is what
 * `verifyDeviceKeyStatement` reads back. Hand-rolling the byte layout instead
 * would make a mismatch look like a rejected rotation.
 */
async function buildAnnounceKeysControl(params: {
  master: Signer;
  deviceSigningPublicKeyHex: string;
  timestamp: number;
}): Promise<string> {
  const statement: AnnounceKeysStatement = {
    type: 'announce-keys',
    // Self-certifying: shared verification requires
    // deriveInboxAddress(userPublicKey) === userAddress.
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

/**
 * Seal a payload into the hub-envelope shape the receive path unseals.
 *
 * The seal half of native-provider's sealHubEnvelope, config-key branch: the
 * space config key is used DIRECTLY as the X448 recipient key. The hub
 * signature fields are carried because the wire shape has them; they are not
 * checked on either path used here (the outer owner-signature gate applies to
 * kick / rekey only).
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

describe('only a key bound to a member may rewrite that member', () => {
  let crypto: NativeCryptoProvider;
  /** The impersonation victim: an ordinary member with a genuine identity. */
  let target: Signer;
  /** An ordinary member whose key IS registered — the discriminating control. */
  let knownMember: Signer;
  /** A member whose second device announces its own signing key. */
  let rotator: Signer;
  /** The rotator's SECOND device signing key. Never a member-row anchor. */
  let rotatorDevice: Signer;
  /** A member whose second device has NOT announced yet — the accepted cost. */
  let stranded: Signer;
  /** That device's signing key. Unadmitted at first, admitted later. */
  let strandedDevice: Signer;
  /** Registered to nobody. The whole qualification the exemption requires. */
  let throwaway: Signer;
  /** An address with no member row — what the bootstrap arm introduces. */
  let newcomer: Signer;
  /** A member introduced by bootstrap, who then renames — the common flow. */
  let bootstrapped: Signer;
  /** That member's signing key, announced before they are introduced. */
  let bootstrappedDevice: Signer;

  let inboxAddressA: string;
  let configPublicKeyA: string;
  let queryClient: QueryClient;
  let renderer: { unmount: () => void } | undefined;

  /**
   * Every console.warn AND console.debug emitted so far, so an arm can inspect
   * its own slice.
   *
   * `debug` is included because that is where this receive path puts its
   * refusal lines — `[SpaceMsg] dropped …` and the authorizer's own
   * `[update-profile] …` are both `logger.debug`, deliberately (production
   * sets minLevel 'warn', and these are routine outcomes rather than attack
   * signals). `dev/harness/shim.ts` reconfigures the shared logger to
   * minLevel 'debug', which is what makes them observable here at all.
   */
  const logLines: string[] = [];
  let restoreConsole: (() => void) | undefined;

  /**
   * Tags that mean "the receive path reached a decision about this frame".
   * The settle loop below extends the wait until one of these appears or a
   * stored row changes; matching on ANY log line instead would end the wait on
   * the first unrelated debug line, silently shortening a security test's
   * observation window.
   */
  const DECISION_LINE = /\[SpaceMsg\]|\[BatchMsg\]|\[update-profile\]|\[DeviceKeys\]/;

  /**
   * Set by the invariant arm. The collateral arm inspects the aftermath of THAT
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

  const storedMember = (address: string) =>
    getMMKVAdapter().getSpaceMember(SPACE_A, address);

  /** The whole member table as one comparable string, for change detection. */
  const snapshotMembers = async () =>
    JSON.stringify(await getMMKVAdapter().getSpaceMembers(SPACE_A));

  beforeAll(async () => {
    __resetAllMMKV();
    crypto = new NativeCryptoProvider();

    // This receive path reports its refusals at `debug`, and `shim.ts` leaves
    // the shared logger at minLevel 'log' unless HARNESS_LOG_DEBUG=1 — so
    // without this the refusal lines this scenario asserts on would not exist
    // and every reason assertion would be red for a reason unrelated to the
    // code under test. Scoped to this file: jest gives each suite its own
    // module registry, so nothing leaks into a sibling scenario.
    logger.configure({ minLevel: 'debug' });

    // Capture without silencing: the handler's and the authorizer's own
    // refusal lines are the trace a failing run is read with, and swallowing
    // them would make this harder to read, not easier.
    //
    // `debug` is captured but only RE-EMITTED under HARNESS_LOG_DEBUG=1. A
    // debug-level run of this path is extremely verbose, and printing all of it
    // by default would bury the assertion failures that are the point of the
    // suite. The capture is unconditional, so an arm's reason assertion never
    // depends on how noisy the operator asked the run to be.
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

    // ---- identities ----
    target = await makeSigner(crypto);
    knownMember = await makeSigner(crypto);
    rotator = await makeSigner(crypto);
    rotatorDevice = await makeSigner(crypto);
    stranded = await makeSigner(crypto);
    strandedDevice = await makeSigner(crypto);
    throwaway = await makeSigner(crypto);
    newcomer = await makeSigner(crypto);
    bootstrapped = await makeSigner(crypto);
    bootstrappedDevice = await makeSigner(crypto);

    // The victim device is the one under test. Built through mobile's own
    // onboarding key code, with no registration upload — nothing here needs a
    // relay, and a harness that registered would mint a device per run.
    const victim = await makeSigner(crypto);
    await storePrivateKey(victim.privateKeyHex);
    await storePublicKey(victim.publicKeyHex);
    await initializeEncryptionKeys(victim.publicKeyHex);

    // ---- the space the victim device is in ----
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

    // ---- membership ----
    // `target` carries a genuine display identity. `knownMember` and `rotator`
    // are ordinary members with no role and no ownership — the lowest bar there
    // is. `newcomer` and `throwaway` have no rows at all.
    const adapter = getMMKVAdapter();
    await adapter.saveSpaceMember(
      SPACE_A,
      member(target, { display_name: GENUINE_NAME, profile_image: GENUINE_ICON })
    );
    await adapter.saveSpaceMember(SPACE_A, member(knownMember, { display_name: 'known-member' }));
    await adapter.saveSpaceMember(SPACE_A, member(rotator, { display_name: 'rotator' }));
    await adapter.saveSpaceMember(SPACE_A, member(stranded, { display_name: 'stranded' }));

    // ---- mount mobile's real provider ----
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

    // Seed the members cache the handler writes to. Without this it is empty,
    // `setQueryData(members, old => !old ? old : …)` short-circuits, and any
    // assertion about the cache would be unfalsifiable — green whether or not
    // the defect is present. Seeded with the genuine rows, so an overwrite
    // shows up as a changed value rather than an appearance.
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData(
      queryKeys.spaces.members(SPACE_A),
      await adapter.getSpaceMembers(SPACE_A)
    );

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

    // The provider's own connect effect installs the handler. Wait for it
    // rather than assuming a mount ordering.
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

  /**
   * Deliver a sealed payload through the space's inbox, as the relay would, and
   * return the log lines this delivery produced.
   */
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

    // There is nothing to await here: `throttledMessageHandler` queues the frame
    // and calls processMessageQueue() WITHOUT awaiting it, so the settle wait is
    // load-bearing rather than paranoia.
    //
    // 250ms is the sibling scenarios' proven baseline and is kept as a MINIMUM,
    // then extended while nothing has been observed. A purely fixed wait is a
    // silent correctness risk on a security test in one direction specifically:
    // too short, and a real overwrite lands just after the assertion reads
    // storage — reporting GREEN against a live defect. Extending costs nothing
    // in the normal case, because every outcome announces itself. A refused
    // frame emits a decision line; an applied one changes a stored row.
    await new Promise((r) => setTimeout(r, 250));
    const deadline = Date.now() + 5_000;
    while (
      Date.now() < deadline &&
      !sawDecision() &&
      (await snapshotMembers()) === stateBefore
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }
    // The storage write and the cache write are separate statements, and
    // whichever landed first is what ended the wait above. Let the rest arrive
    // before any arm reads them.
    await new Promise((r) => setTimeout(r, 150));

    return logLines.slice(before);
  }

  /** Deliver an `update-profile` space message. */
  async function deliverProfile(params: {
    signer: Signer;
    claimSenderId: string;
    displayName: string;
    userIcon: string;
    createdDate: number;
    nonce: string;
  }): Promise<string[]> {
    const frame = await buildProfileFrame(params);
    return deliverToSpace(
      JSON.stringify({ type: 'message', message: frame }),
      params.createdDate
    );
  }

  // ---- preconditions ----
  // A run where the bench never came up produces the same "nothing was
  // overwritten" reading as a correctly-bound rejection. Assert the bench first.

  it('PRECONDITION: the provider mounted and installed its message handler', () => {
    expect(ws()?.hasHandler()).toBe(true);
  });

  it("PRECONDITION: the target holds its genuine identity and the newcomer has no row", async () => {
    const row = await storedMember(target.address);
    expect(row?.display_name).toBe(GENUINE_NAME);
    expect((row as { profile_image?: string })?.profile_image).toBe(GENUINE_ICON);
    expect(await storedMember(newcomer.address)).toBeUndefined();
  });

  // ---- control: the path is alive, and bootstrap still works ----

  it('CONTROL: an unregistered key DOES introduce a member this device has never seen', async () => {
    // Runs first on purpose. It proves the whole path can carry a profile update
    // to storage, so a survivor in the invariant arm is a binding decision
    // rather than a dead bench.
    //
    // It is also the over-block guard for the roster-population path. Mobile's
    // space manifest carries no member list, so an existing member's
    // connect-time profile re-broadcast landing in this upsert is the ONLY way
    // a new joiner learns who was already there. A fix that suppressed creation
    // would close the hole and leave every new joiner with a half-empty member
    // list — which is why the invariant is scoped to REWRITES, not writes.
    expect(await storedMember(newcomer.address)).toBeUndefined();

    await deliverProfile({
      signer: throwaway,
      claimSenderId: newcomer.address,
      displayName: BOOTSTRAP_NAME,
      userIcon: '',
      createdDate: T_BOOTSTRAP,
      nonce: 'nonce-bootstrap',
    });

    const created = await storedMember(newcomer.address);
    expect(created?.display_name).toBe(BOOTSTRAP_NAME);
    // The row lands with a blank anchor by design — the authoritative value
    // comes from a verified join, never from this self-asserted message.
    expect(created?.inbox_address).toBe('');
  });

  // ---- control: the authorizer already discriminates on a REGISTERED key ----

  it('CONTROL: a registered key claiming another member is refused', async () => {
    // `knownMember`'s key IS bound to a row, so the existing
    // `ownerAddress === senderId` rule applies and this is refused today. It
    // isolates the unregistered-key branch as the cause of the next arm: if
    // this ever goes red, the authorizer is not running at all and every
    // "refused" reading below would be meaningless.
    await deliverProfile({
      signer: knownMember,
      claimSenderId: target.address,
      displayName: FORGED_NAME,
      userIcon: FORGED_ICON,
      createdDate: T_KNOWN_KEY_FORGERY,
      nonce: 'nonce-known-key-forgery',
    });

    const row = await storedMember(target.address);
    expect(row?.display_name).toBe(GENUINE_NAME);
    expect((row as { profile_image?: string })?.profile_image).toBe(GENUINE_ICON);
  });

  // ---- the invariant ----

  it('a key bound to nobody does NOT rewrite an existing member', async () => {
    const emitted = await deliverProfile({
      signer: throwaway,
      claimSenderId: target.address,
      displayName: FORGED_NAME,
      userIcon: FORGED_ICON,
      createdDate: T_ATTACK,
      nonce: 'nonce-attack',
    });
    attackDelivered = true;

    const row = await storedMember(target.address);
    expect(row?.display_name).toBe(GENUINE_NAME);
    expect((row as { profile_image?: string })?.profile_image).toBe(GENUINE_ICON);

    // The refusal must come from the BINDING decision, not from an earlier
    // gate. This warning fires only past unseal, decrypt, fingerprint
    // recomputation and Ed448 verification — so a future regression that
    // rejects the frame earlier (a broken config key, a changed fingerprint
    // construction) fails here instead of passing green on a dead bench.
    //
    // The identical arm above with a REGISTERED key proves the authorizer runs;
    // this one proves it now covers the unregistered branch too.
    expect(
      emitted.some((w) =>
        /\[update-profile\].*unregistered key may not rewrite an existing member/.test(w)
      )
    ).toBe(true);
  });

  it('NO COLLATERAL: the members cache still shows the genuine identity too', async () => {
    // This arm reads the aftermath of the previous arm's delivery; it makes
    // none of its own. Without an attack to inspect, every assertion below is
    // trivially true — so refuse to report on a bench that never attacked.
    expect(attackDelivered).toBe(true);

    // Storage and cache are written from separate statements in the handler,
    // and the cache is what the UI renders. A cache-only overwrite would be a
    // real client-state change that a storage assertion alone would not reveal.
    // The key is pre-seeded in beforeAll precisely so this can be
    // unconditional — an `if (cached)` here would pass on an empty cache.
    const cached = queryClient.getQueryData<SpaceMember[]>(queryKeys.spaces.members(SPACE_A));
    const cachedTarget = cached?.find((m) => m.address === target.address);
    expect(cachedTarget?.display_name).toBe(GENUINE_NAME);
    expect((cachedTarget as { profile_image?: string } | undefined)?.profile_image).toBe(
      GENUINE_ICON
    );
  });

  // ---- control: over-blocking guards ----

  it('CONTROL: a second device whose key was announced can still update its own profile', async () => {
    // The regression the prior art warns about, and the reason a naive
    // "unregistered keys may not touch existing rows" rule is not enough on its
    // own. A second device signs with its OWN per-space key
    // (`getSpaceSigningKey` = signing ?? inbox), which is never written to the
    // member row's anchor — mobile refuses to repoint an anchor at all. So
    // without the announce-keys admission being consulted, this device looks
    // exactly like the attacker above and every multi-device profile update
    // would break, silently and permanently.
    const announceEmitted = await deliverToSpace(
      await buildAnnounceKeysControl({
        master: rotator,
        deviceSigningPublicKeyHex: rotatorDevice.publicKeyHex,
        // announce-keys is skew-bounded against the real clock
        // (DEVICE_KEY_STATEMENT_MAX_SKEW_MS), so this one value must be a real
        // `Date.now()` rather than the fixed T_* ladder the profile frames use.
        timestamp: Date.now(),
      }),
      T_ROTATION
    );

    // Assert the admission actually landed. Without this the arm could pass for
    // the wrong reason: a rejected announce leaves the device key unknown, and
    // pre-fix an unknown key is accepted anyway — so the arm would be green
    // while proving nothing about rotation at all.
    const devices = await getMMKVAdapter().getSpaceMemberDevices(SPACE_A);
    const admitted = devices.find((d) => d.inboxAddress === rotatorDevice.inboxAddress);
    expect(admitted).toBeDefined();
    expect(admitted?.userAddress).toBe(rotator.address);
    expect(admitted?.revoked).toBeFalsy();
    // A rejected statement warns with its reason; nothing should have.
    expect(announceEmitted.filter((w) => /\[DeviceKeys\] rejected/.test(w))).toEqual([]);

    await deliverProfile({
      signer: rotatorDevice,
      claimSenderId: rotator.address,
      displayName: ROTATED_NAME,
      userIcon: '',
      createdDate: T_ROTATION,
      nonce: 'nonce-rotation',
    });

    expect((await storedMember(rotator.address))?.display_name).toBe(ROTATED_NAME);
    // And it stayed on its own row while doing so. `knownMember` is the
    // bystander here rather than `target`, deliberately: no arm ever writes to
    // it, so this assertion depends on nothing but the rotation. Reading
    // `target` instead would make this arm red purely as a knock-on of the
    // invariant arm's attack, which is the "an arm that reads another arm's
    // aftermath" trap.
    expect((await storedMember(knownMember.address))?.display_name).toBe('known-member');
  });

  it('CONTROL: a member INTRODUCED by bootstrap can still rename themselves afterwards', async () => {
    // The most common legitimate flow there is, and the one most at risk from
    // the bound — so it is measured rather than reasoned about.
    //
    // A bootstrapped row is created with an EMPTY anchor (`inbox_address: ''`),
    // on purpose: the authoritative anchor comes from a verified join, never
    // from a self-asserted profile message. An empty anchor matches no signing
    // key, so on the second update the member's own key looks unbound while
    // their row now exists — which is precisely the shape the bound refuses.
    // If nothing else bound the key, every member introduced this way would be
    // frozen under the name they were introduced with, forever, on that device.
    //
    // What saves it is the `announce-keys` admission, which is stored
    // independently of any member row (processDeviceKeyStatement never looks
    // one up) and is re-sent on every connect for every space
    // (WebSocketContext hub-log setup). So the admission is already on file by
    // the time the row exists, and the rename resolves through it.
    expect(await storedMember(bootstrapped.address)).toBeUndefined();

    // 1. The device announces the key it signs with — as it does on every
    //    connect, ~2.5s before its profile rebroadcast, on the same hub log.
    await deliverToSpace(
      await buildAnnounceKeysControl({
        master: bootstrapped,
        deviceSigningPublicKeyHex: bootstrappedDevice.publicKeyHex,
        timestamp: Date.now(),
      }),
      T_BOOTSTRAP_INTRO
    );

    // 2. The connect-time profile rebroadcast introduces them. At this instant
    //    the key still resolves to nobody — the admission exists but its owner
    //    has no row for the lookup to land on — so this goes through the
    //    bootstrap branch, exactly as an introduction should.
    await deliverProfile({
      signer: bootstrappedDevice,
      claimSenderId: bootstrapped.address,
      displayName: INTRODUCED_NAME,
      userIcon: '',
      createdDate: T_BOOTSTRAP_INTRO,
      nonce: 'nonce-bootstrap-intro',
    });
    const introduced = await storedMember(bootstrapped.address);
    expect(introduced?.display_name).toBe(INTRODUCED_NAME);
    // Empty anchor confirmed, so the next step really is the risky shape and
    // not an accident of the fixture.
    expect(introduced?.inbox_address).toBe('');

    // 3. Now they rename. Row exists, anchor empty — the admission from step 1
    //    is the only thing that can bind this key.
    await deliverProfile({
      signer: bootstrappedDevice,
      claimSenderId: bootstrapped.address,
      displayName: REINTRODUCED_NAME,
      userIcon: '',
      createdDate: T_BOOTSTRAP_RENAME,
      nonce: 'nonce-bootstrap-rename',
    });

    expect((await storedMember(bootstrapped.address))?.display_name).toBe(REINTRODUCED_NAME);
  });

  it('ACCEPTED COST: a second device whose key is not YET announced is refused, and recovers once it is', async () => {
    // This arm exists because an independent review raised it, and an
    // untested cost is worse than an acknowledged one. It records a real
    // behaviour change rather than asserting the fix is free.
    //
    // An unadmitted second device is, on the wire, INDISTINGUISHABLE from the
    // attacker in the invariant arm: a valid signature by a key bound to
    // nobody, naming a member who already has a row. There is no rule that
    // accepts one and refuses the other, so refusing it is inherent to the
    // fix, not a defect in it. What this arm pins down is the SHAPE of the
    // cost — is the update delayed, or destroyed?
    //
    // Bounding it matters, because the handler ACKS a refused frame off the
    // server inbox (`deleteSpaceInboxMessages` on the drop path), so that send
    // is gone. The second half below shows the member row is not poisoned: as
    // soon as the admission lands, the next broadcast applies normally.
    //
    // Ordering in practice is better than the worst case suggests. Both
    // `announce-keys` and `update-profile` are sent as `log-append` frames
    // into the SAME hub log (spaceMessageService `sendGenericMessage`,
    // deviceKeyStatements `sealControlFrame`), a receiver replays a log page
    // onto one FIFO queue in seq order, and the sender enqueues the announce
    // ~2.5s before the connect-time profile rebroadcast. So the log-replay
    // route is ordered by construction. Whether a live inbox push can
    // interleave ahead of a paginated catch-up is server behaviour and is NOT
    // established here.
    expect((await storedMember(stranded.address))?.display_name).toBe('stranded');

    const refused = await deliverProfile({
      signer: strandedDevice,
      claimSenderId: stranded.address,
      displayName: STRANDED_NAME,
      userIcon: '',
      createdDate: T_STRANDED,
      nonce: 'nonce-stranded',
    });

    expect((await storedMember(stranded.address))?.display_name).toBe('stranded');
    expect(
      refused.some((w) =>
        /\[update-profile\].*unregistered key may not rewrite an existing member/.test(w)
      )
    ).toBe(true);

    // ---- and now the admission arrives ----
    await deliverToSpace(
      await buildAnnounceKeysControl({
        master: stranded,
        deviceSigningPublicKeyHex: strandedDevice.publicKeyHex,
        timestamp: Date.now(),
      }),
      T_STRANDED_RECOVERED
    );

    await deliverProfile({
      signer: strandedDevice,
      claimSenderId: stranded.address,
      displayName: STRANDED_NAME,
      userIcon: '',
      createdDate: T_STRANDED_RECOVERED,
      nonce: 'nonce-stranded-recovered',
    });

    // Recoverable, not poisoned. The cost is one dropped send, not a member
    // stuck with a stale name forever.
    expect((await storedMember(stranded.address))?.display_name).toBe(STRANDED_NAME);
  });

  it('CONTROL: a member updating their own profile with their own key still applies', async () => {
    // The ordinary case, and the plainest over-block guard there is. Same
    // builder, same wire, same handler — the only difference from the invariant
    // arm is that the signing key is bound to the row being written.
    await deliverProfile({
      signer: target,
      claimSenderId: target.address,
      displayName: SELF_UPDATED_NAME,
      userIcon: GENUINE_ICON,
      createdDate: T_SELF_UPDATE,
      nonce: 'nonce-self-update',
    });

    expect((await storedMember(target.address))?.display_name).toBe(SELF_UPDATED_NAME);
  });
});
