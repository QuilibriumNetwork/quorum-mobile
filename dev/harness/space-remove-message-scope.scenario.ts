// Does a space `remove-message` stay inside the space that delivered it?
//
// ── What this measures ──────────────────────────────────────────────────────
//
// Mobile authorizes a space control message against the DELIVERING space and
// channel: the target message is looked up with a scoped
// `getMessage({spaceId, channelId, messageId})`. The removal it then performs
// is `storage.deleteMessage(messageId)` — keyed on the message id ALONE
// (messagesDb: `DELETE FROM messages WHERE message_id = ?`), with no space or
// channel in the predicate.
//
// Those two facts are only compatible while every honored removal has a target
// that actually lives in the delivering scope. This scenario measures whether
// that holds, by delivering a removal through space A that names a message
// stored in space B.
//
// The INVARIANT under test, stated positively (it is what the assertions say):
//
//     a removal delivered through space A may only affect rows in space A.
//
// ── Why the arms are shaped this way ────────────────────────────────────────
//
// "The other space's message survived" is trivially satisfied by a scenario
// that delivers nothing at all — a malformed frame, a signature the app
// rejects, a handler never reached, a provider that never mounted. Every one of
// those reads as a pass. So the cross-space arm is worthless on its own and is
// bracketed by two arms that make it mean something:
//
//   1. CONTROL (authorization) — the same frame, judged by mobile's own
//      `authorizeSpaceControlMessage`, is `allowed`. This proves the frame is
//      well-formed, correctly signed and genuinely honored, so a surviving
//      message in space B is a scoping decision rather than a rejected frame.
//   2. CONTROL (delivery) — the same construction, same wire, same handler,
//      naming a message that IS in the delivering scope and that the sender
//      authored, DOES delete it. This proves the whole path can carry a
//      removal to storage, so silence in the cross-space arm is not a dead
//      bench. It is also the over-blocking guard: whatever makes the
//      cross-space arm pass must leave this one working.
//
// Plus a bystander row in space B that no frame ever names, which fails if the
// scenario is deleting broadly rather than precisely.
//
// ── How faithful this is, and where it stops ────────────────────────────────
//
// REAL: mobile's `WebSocketProvider` and its `handleIncomingMessage` receive
// path, `authorizeSpaceControlMessage` and the shared verdict beneath it,
// `messagesDb` on real SQL, the real space/member/key storage, real X448
// envelope decryption and real Ed448 signing. The attacker's frame is signed
// with a real key over the shared `buildMessageFingerprint`, so no
// authorization logic is transcribed or stubbed anywhere in this file.
//
// NOT real, and deliberately:
//   - The socket. `createRNWebSocketClient` is replaced by an in-process fake
//     so the frame can be handed to the provider's own message handler without
//     a relay. What is under test is receive-side handling, not transport.
//   - The attacker is a keypair and a frame, not a second running client. A
//     genuine two-client space is not reachable headlessly at all: joining one
//     needs `tripleRatchetResizeForInvites`, which is native-only and throws in
//     this harness (wasm-provider-shim). A second bot would also need a second
//     PROCESS — see bot.ts on storage singletons — and would still not be able
//     to join. Since the defect is entirely in how the RECEIVER handles a frame
//     it has already authorized, a real signing identity is the part that has
//     to be real, and it is.
//   - ⚠️ ONLY THE PER-MESSAGE RECEIVE PATH IS EXERCISED. Mobile has a second
//     `remove-message` handler on the native batch catch-up path. It cannot run
//     here at any effort: `batchProcessMessages` / `batchUnsealEnvelopes` are
//     native-only and throw, which is exactly why frames fall back to the
//     per-message path this scenario drives. Whatever is asserted here about
//     the batch handler is NOT measured — read that handler, do not infer it
//     from a green run.
//
// Run: npx jest --config jest.harness.config.js space-remove-message-scope
//
// No relay, no account registration, no persisted device — nothing this
// scenario asserts on touches the network. One exception worth naming: on an
// honored removal the handler fires its best-effort server-side inbox cleanup
// (`deleteSpaceInboxMessages`), which is a real request, fire-and-forget and
// `.catch`-swallowed. It is left alone rather than suppressed, because
// suppressing it would mean altering the path under test. It targets an
// address derived from a key generated in this run, so it can only ever reach
// an inbox nobody owns.

import React from 'react';
import { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  buildMessageFingerprint,
  computeMessageIdHex,
  deriveInboxAddress,
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
import { authorizeSpaceControlMessage } from '@/services/space/spaceMessageAuth';
import { saveSpace, saveSpaceKey } from '@/services/config/spaceStorage';
import { getMMKVAdapter } from '@/services/storage/mmkvAdapter';
import * as messagesDb from '@/services/storage/messagesDb';
import {
  deriveAddress,
  initializeEncryptionKeys,
  keyPairFromHex,
} from '@/services/onboarding/keyService';
import { storePrivateKey, storePublicKey } from '@/services/onboarding/secureStorage';

const SPACE_A = 'harness-space-a-delivering';
const SPACE_B = 'harness-space-b-elsewhere';
const CHANNEL_A = 'harness-channel-a';
const CHANNEL_B = 'harness-channel-b';

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
  const privateKeyHex = hex(ed.private_key);
  const publicKeyHex = hex(ed.public_key);
  return {
    // Mobile's own derivation, so the member row and the frame agree by
    // construction rather than by a hand-built lookalike.
    address: deriveAddress(publicKeyHex as never),
    publicKeyHex,
    privateKeyHex,
    inboxAddress: deriveInboxAddress(publicKeyHex),
  };
}

function member(s: Signer, name: string): SpaceMember {
  return {
    address: s.address,
    user_address: s.address,
    display_name: name,
    inbox_address: s.inboxAddress,
    joinedAt: 1,
  };
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
    // Signatures are required for control messages regardless of this flag;
    // false is simply the ordinary space shape.
    isRepudiable: false,
    isPublic: false,
    groups: [{ groupName: 'general', channels: [channel(spaceId, channelId)] }],
    roles: [],
    emojis: [],
    stickers: [],
  };
}

/** A stored post, as the receive path would have persisted one. */
function post(params: {
  spaceId: string;
  channelId: string;
  messageId: string;
  author: Signer;
  text: string;
}): Message {
  return {
    channelId: params.channelId,
    spaceId: params.spaceId,
    messageId: params.messageId,
    digestAlgorithm: 'sha256',
    nonce: `nonce-${params.messageId}`,
    createdDate: 1_700_000_000_000,
    modifiedDate: 1_700_000_000_000,
    lastModifiedHash: '',
    content: { type: 'post', senderId: params.author.address, text: params.text },
    reactions: [],
    mentions: {} as Message['mentions'],
  };
}

/**
 * Build a `remove-message` frame the way a sending client does: canonical
 * fingerprint (shared `buildMessageFingerprint`), messageId = its SHA-256, and
 * a real Ed448 signature over that hash.
 *
 * `scopeSpaceId`/`scopeChannelId` are the space and channel the frame is signed
 * FOR, and must be the ones it is delivered through — the fingerprint
 * scope-binds them for control types, so a mismatch is a signature failure and
 * would make every downstream assertion vacuous. The message being removed is
 * named only by id, which is the whole point: `removeMessageId` carries no
 * scope of its own.
 */
async function buildRemoveFrame(params: {
  sender: Signer;
  scopeSpaceId: string;
  scopeChannelId: string;
  removeMessageId: string;
}): Promise<Message> {
  const content = {
    type: 'remove-message' as const,
    senderId: params.sender.address,
    removeMessageId: params.removeMessageId,
  };
  const nonce = `nonce-remove-${params.removeMessageId}`;
  const fingerprint = buildMessageFingerprint({
    nonce,
    content,
    senderId: params.sender.address,
    spaceId: params.scopeSpaceId,
    channelId: params.scopeChannelId,
  });
  const messageId = computeMessageIdHex(fingerprint);

  // Sign the hash bytes, base64 in/out — the contract verifySpaceMessageSignature
  // verifies against.
  const signatureB64 = await new NativeSigningProvider().signEd448(
    b64(Buffer.from(params.sender.privateKeyHex, 'hex')),
    b64(Buffer.from(messageId, 'hex'))
  );

  return {
    channelId: params.scopeChannelId,
    spaceId: params.scopeSpaceId,
    messageId,
    digestAlgorithm: 'sha256',
    nonce,
    createdDate: Date.now(),
    modifiedDate: Date.now(),
    lastModifiedHash: '',
    content,
    reactions: [],
    mentions: {} as Message['mentions'],
    publicKey: params.sender.publicKeyHex,
    signature: b64ToHex(signatureB64),
  };
}

/**
 * Seal a space message into the hub-envelope shape the receive path unseals.
 *
 * The seal half of native-provider's sealHubEnvelope, config-key branch: the
 * space config key is used DIRECTLY as the X448 recipient key. The hub
 * signature fields are carried because the wire shape has them, and are not
 * checked on this path — the owner-signature gate applies to `control`
 * payloads, and this is a `message` payload.
 */
async function sealForSpace(
  crypto: NativeCryptoProvider,
  configPublicKeyHex: string,
  hubAddress: string,
  spaceMessage: Message
): Promise<string> {
  const ephemeral = await crypto.generateX448();
  const plaintext = JSON.stringify({ type: 'message', message: spaceMessage });
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

describe('space remove-message stays inside the space that delivered it', () => {
  let crypto: NativeCryptoProvider;
  let attacker: Signer;
  let bystander: Signer;
  let victimAddress: string;
  let inboxAddressA: string;
  let configPublicKeyA: string;
  let renderer: { unmount: () => void } | undefined;

  /** The message that lives in space B — the one a space-A frame must not reach. */
  const TARGET_IN_B = 'target-message-in-space-b';
  /** Never named by any frame; catches a scenario that deletes broadly. */
  const BYSTANDER_IN_B = 'bystander-message-in-space-b';
  /** In the delivering space, authored by the attacker — the delivery control. */
  const TARGET_IN_A = 'target-message-in-space-a';

  const ws = () =>
    (globalThis as Record<string, unknown>).__harnessWsClient as {
      deliver(m: EncryptedWebSocketMessage): Promise<void>;
      hasHandler(): boolean;
    };

  const storedIn = (spaceId: string, channelId: string, messageId: string) =>
    messagesDb.getMessage({ spaceId, channelId, messageId });

  beforeAll(async () => {
    __resetAllMMKV();
    crypto = new NativeCryptoProvider();

    // ---- identities ----
    attacker = await makeSigner(crypto);
    bystander = await makeSigner(crypto);

    // The victim is the device under test. Built through mobile's own
    // onboarding key code, with no registration upload — nothing here needs a
    // relay, and a harness that registered would mint a device per run.
    const victim = await makeSigner(crypto);
    victimAddress = victim.address;
    await storePrivateKey(victim.privateKeyHex);
    await storePublicKey(victim.publicKeyHex);
    await initializeEncryptionKeys(victim.publicKeyHex);

    // ---- two spaces the victim is in ----
    const hubA = await crypto.generateEd448();
    const configA = await crypto.generateX448();
    const inboxA = await crypto.generateX448();
    configPublicKeyA = hex(configA.public_key);
    // Space frames are routed by the INBOX key's address, not the hub's
    // (spaceStorage.getSpaceInboxAddress reads `space_key:<id>:inbox`). Leaving
    // it unset makes getAllSpaceInboxAddresses skip the space entirely, the
    // frame is then not recognised as a space message, and the whole receive
    // path is silently bypassed — which reads as "nothing was deleted".
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

    const hubB = await crypto.generateEd448();
    saveSpace(space(SPACE_B, CHANNEL_B, deriveInboxAddress(hex(hubB.public_key))));
    saveSpaceKey({
      spaceId: SPACE_B,
      keyId: 'hub',
      publicKey: hex(hubB.public_key),
      privateKey: hex(hubB.private_key),
      address: deriveInboxAddress(hex(hubB.public_key)),
    });

    // ---- membership ----
    // The attacker is an ORDINARY member of space A. No role, no ownership —
    // the lowest bar there is. They are NOT a member of space B.
    const adapter = getMMKVAdapter();
    await adapter.saveSpaceMember(SPACE_A, member(attacker, 'attacker'));
    await adapter.saveSpaceMember(SPACE_B, member(bystander, 'bystander'));

    // ---- stored messages ----
    await messagesDb.saveMessage(
      post({
        spaceId: SPACE_B,
        channelId: CHANNEL_B,
        messageId: TARGET_IN_B,
        author: bystander,
        text: 'a message in another space',
      })
    );
    await messagesDb.saveMessage(
      post({
        spaceId: SPACE_B,
        channelId: CHANNEL_B,
        messageId: BYSTANDER_IN_B,
        author: bystander,
        text: 'never named by any frame',
      })
    );
    await messagesDb.saveMessage(
      post({
        spaceId: SPACE_A,
        channelId: CHANNEL_A,
        messageId: TARGET_IN_A,
        author: attacker,
        text: "the attacker's own message, in the delivering space",
      })
    );

    // ---- mount mobile's real provider ----
    const user: UserInfo = {
      address: victimAddress,
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
    __resetAllMMKV();
  });

  /** Deliver a frame through space A's inbox, as the relay would. */
  async function deliverViaSpaceA(spaceMessage: Message): Promise<void> {
    const encryptedContent = await sealForSpace(
      crypto,
      configPublicKeyA,
      inboxAddressA,
      spaceMessage
    );
    await act(async () => {
      await ws().deliver({
        encryptedContent,
        inboxAddress: inboxAddressA,
        timestamp: Date.now(),
      });
    });
    // The receive path yields between messages; let its microtasks settle
    // before reading storage.
    await new Promise((r) => setTimeout(r, 250));
  }

  // ---- preconditions ----
  // A run where the bench never came up produces the same "nothing was
  // deleted" reading as a correctly-scoped removal. Assert the bench first.

  it('PRECONDITION: the provider mounted and installed its message handler', () => {
    expect(ws()?.hasHandler()).toBe(true);
  });

  it('PRECONDITION: all three messages are in storage, in their own spaces', async () => {
    expect(await storedIn(SPACE_B, CHANNEL_B, TARGET_IN_B)).toBeDefined();
    expect(await storedIn(SPACE_B, CHANNEL_B, BYSTANDER_IN_B)).toBeDefined();
    expect(await storedIn(SPACE_A, CHANNEL_A, TARGET_IN_A)).toBeDefined();
    // The attacker is a member of A only — the delete must not be explicable
    // by them having rights in B.
    expect(await storedIn(SPACE_A, CHANNEL_A, TARGET_IN_B)).toBeUndefined();
  });

  // ---- control: the frame is genuinely authorized ----

  it('CONTROL: mobile authorizes the cross-space frame, so a survivor is a scoping decision', async () => {
    const frame = await buildRemoveFrame({
      sender: attacker,
      scopeSpaceId: SPACE_A,
      scopeChannelId: CHANNEL_A,
      removeMessageId: TARGET_IN_B,
    });

    // Judged exactly as the handler judges it: the target is looked up in the
    // DELIVERING scope, where it does not exist.
    const targetAsHandlerSeesIt = await storedIn(SPACE_A, CHANNEL_A, TARGET_IN_B);
    expect(targetAsHandlerSeesIt).toBeUndefined();

    const verdict = await authorizeSpaceControlMessage({
      message: frame,
      spaceId: SPACE_A,
      space: undefined,
      channel: undefined,
      targetMessage: targetAsHandlerSeesIt,
    });

    // If this ever goes red, every assertion below is vacuous: the frame would
    // be getting dropped rather than scoped. The signature is real, so a
    // failure here is a broken frame builder, not a fixed defect.
    expect(verdict.allowed).toBe(true);
  });

  // ---- the invariant ----

  it('a removal delivered through space A does NOT delete a message stored in space B', async () => {
    const frame = await buildRemoveFrame({
      sender: attacker,
      scopeSpaceId: SPACE_A,
      scopeChannelId: CHANNEL_A,
      removeMessageId: TARGET_IN_B,
    });

    await deliverViaSpaceA(frame);

    // The row lives in space B. Space A delivered the removal, the attacker is
    // a member of A only, and the message was never in A's scope at all.
    expect(await storedIn(SPACE_B, CHANNEL_B, TARGET_IN_B)).toBeDefined();
  });

  it('a removal delivered through space A does not touch an unnamed message either', async () => {
    expect(await storedIn(SPACE_B, CHANNEL_B, BYSTANDER_IN_B)).toBeDefined();
  });

  // ---- control: the path can still carry a legitimate removal ----

  it('CONTROL: a removal whose target IS in the delivering space still deletes it', async () => {
    // Same builder, same wire, same handler — the only difference is that the
    // target is where the removal arrived. If scoping the removal also broke
    // this, the fix would be over-blocking and users would lose the ability to
    // delete their own messages.
    expect(await storedIn(SPACE_A, CHANNEL_A, TARGET_IN_A)).toBeDefined();

    const frame = await buildRemoveFrame({
      sender: attacker,
      scopeSpaceId: SPACE_A,
      scopeChannelId: CHANNEL_A,
      removeMessageId: TARGET_IN_A,
    });

    await deliverViaSpaceA(frame);

    expect(await storedIn(SPACE_A, CHANNEL_A, TARGET_IN_A)).toBeUndefined();
  });
});
