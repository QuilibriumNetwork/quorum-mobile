// A full headless mobile client: mobile's REAL WebSocketProvider (which is where
// the entire DM receive path lives), its REAL send hook, its REAL storage — with
// only the device-native leaves shimmed.
//
// ── Why this is shaped so differently from desktop's bot ────────────────────
//
// Desktop's harness constructs `new MessageService(deps)`: a plain class, no UI.
// Mobile has no such seam. Its DM receive path is ~4000 lines of useCallback
// INSIDE WebSocketProvider — handleIncomingMessage, applyDMGroupResults,
// processMessageQueue. There is no way to call that code without a React tree,
// and reimplementing it would test the harness rather than the app.
//
// So the bot renders the provider. That works because WebSocketProvider renders
// no native views — it returns a context around its children — and because the
// provider BOOTSTRAPS ITSELF: mount it with isAuthenticated + a user and its own
// effect calls connect(), which loads device keys from SecureStore, opens the
// socket and subscribes to the device inbox. All mobile's code, unmodified.
//
// A `Probe` child then calls mobile's own useWebSocket() and
// useSendDirectMessage() and hands them out, so the bot's send() IS the app's
// send path — nonce, message-id hash, Ed448 signing, device fan-out and all.
//
// ── ONE BOT PER PROCESS. This is not a style choice. ────────────────────────
//
// Mobile reaches its storage through module singletons (mmkvStorage,
// encryptionStateStorage, the messagesDb module, the SecureStore wrapper). Two
// bots in one process would share every one of them: the second identity would
// overwrite the first, and their ratchet state would fuse. They would not be two
// clients.
//
// jest.isolateModulesAsync was measured and DOES isolate a static require-graph
// (see two-bot-feasibility.scenario.ts), but it is not sufficient here: app code
// also reaches storage through LAZY requires — services/crypto/initEnvelopeGuard
// does `require('react-native-mmkv')` at call time — which run after the isolate
// closes and therefore resolve against the shared registry. That leak is silent,
// and silent cross-talk between the two "devices" is the one failure this bench
// must never have.
//
// Process isolation has no such holes, and it is also what the thing being
// modelled actually is: a device is a process. Two bots ⇒ two processes, paired
// by rendezvous.ts.
import React from 'react';
import { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// UserRegistration is mobile's own client type, NOT a shared export — it is
// declared in services/api/quorumClient.ts alongside the fetch that returns it.
// Importing it from shared compiled to nothing (type imports are erased) but
// broke tsc, so the harness looked green while the name did not exist.
import type { Message } from '@quilibrium/quorum-shared';
import AuthContext, { type UserInfo } from '@/context/AuthContext';
import StorageContext from '@/context/StorageContext';
import { WebSocketProvider, useWebSocket, deleteInboxMessages } from '@/context/WebSocketContext';
import { getApiConfig } from '@/services/api/config';
import { getDeviceKeyset } from '@/services/onboarding/secureStorage';
import { useSendDirectMessage } from '@/hooks/chat/useSendDirectMessage';
import { getMMKVAdapter } from '@/services/storage/mmkvAdapter';
import { getQuorumClient, type UserRegistration } from '@/services/api/quorumClient';
import { loadOrCreateIdentity, type HarnessIdentity } from './identity';

/**
 * Timestamps of every frame queued on a device inbox.
 *
 * Mobile's own client has no inbox FETCH — the app only ever receives frames
 * pushed over the socket, so there is nothing here to reuse. The relay does
 * expose the endpoint (desktop's client wraps it as getInbox), so the harness
 * reads it directly. Deletes still go through mobile's own signed path.
 */
async function fetchInboxTimestamps(inboxAddress: string): Promise<number[]> {
  const res = await fetch(`${getApiConfig().baseUrl}/inbox/${inboxAddress}`);
  if (!res.ok) throw new Error(`[harness] inbox fetch failed: ${res.status}`);
  const body: unknown = await res.json();
  const frames = (Array.isArray(body) ? body : ((body as { data?: unknown })?.data ?? [])) as {
    timestamp: number;
  }[];
  return frames.map((f) => f.timestamp).filter((t) => typeof t === 'number');
}

/** DM conversation ids are `<partner>/<partner>` — the app's own convention. */
export const conversationIdFor = (partnerAddress: string) =>
  `${partnerAddress}/${partnerAddress}`;

export interface MobileBot {
  identity: HarnessIdentity;
  /** Every message mobile's own code persisted, in the order it persisted them. */
  captured: Message[];
  /** Fires as each message is persisted (received, or locally saved on send). */
  onSaved?: (m: Message) => void;
  connectionState(): string;
  /** Resolves once the provider's own connect() has reached 'connected'. */
  waitForConnected(timeoutMs?: number): Promise<void>;
  /** Send a DM through mobile's real useSendDirectMessage mutation. */
  send(toAddress: string, text: string): Promise<void>;
  /** Registration as the relay currently reports it — device count included. */
  registration(): Promise<UserRegistration | null>;
  /**
   * Fetch and delete everything queued on this bot's device inbox. Returns how
   * many were removed.
   *
   * Un-acked frames are redelivered on every listen, so without this a run
   * begins on whatever a previous run left undecryptable and counts those as
   * fresh losses. Desktop's harness drains for the same reason.
   */
  drainInbox(): Promise<number>;
  /**
   * How many frames are sitting on this bot's device inbox right now, without
   * removing them.
   *
   * This is what separates the two very different explanations for a missing
   * message: frames still queued here reached the relay and were never taken by
   * this client (a subscribe/push problem), while an empty inbox means they
   * were consumed — or never posted at all. Guessing between those from a
   * delivery count alone is not possible.
   */
  inboxDepth(): Promise<number>;
  stop(): Promise<void>;
}

/**
 * react-test-renderer refuses to mount outside act() when this is set, but React
 * also WARNS when a state update lands outside act() while it is set — and this
 * bot's updates arrive from a socket, not from test code. So it is enabled only
 * around mount/unmount and disabled in between, which keeps the mount legal
 * without burying a real run in act() warnings.
 */
function setActEnvironment(on: boolean): void {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = on;
}

export async function createBot(
  name: string,
  opts: { privateKeyHex?: string } = {}
): Promise<MobileBot> {
  // Registers the account if new, and seeds SecureStore so the provider's
  // initializeDeviceKeys finds an existing keyset instead of minting a device.
  const identity = await loadOrCreateIdentity(name, opts);

  const captured: Message[] = [];
  const bot: Partial<MobileBot> = { identity, captured };

  // Capture seam: tee the storage adapter's saveMessage. Every DM the receive
  // path keeps funnels through it, so what lands in `captured` is exactly the
  // Message object mobile's own code chose to persist — no parallel bookkeeping
  // that could disagree with the app. Patching the singleton is safe precisely
  // because this process holds one bot (see header).
  const adapter = getMMKVAdapter();
  const origSave = adapter.saveMessage.bind(adapter);
  (adapter as unknown as { saveMessage: typeof adapter.saveMessage }).saveMessage = async (
    message: Message,
    ...rest: unknown[]
  ) => {
    captured.push(message);
    (bot as MobileBot).onSaved?.(message);
    return (origSave as (...a: unknown[]) => Promise<void>)(message, ...rest);
  };

  const user: UserInfo = {
    address: identity.address,
    // QNS-only; no DM path reads it. Left empty rather than faked into something
    // that looks like a real Quilibrium address.
    quilibriumAddress: '',
    publicKey: identity.publicKeyHex,
    displayName: name,
    privacyLevel: 'standard',
  };

  // Only the fields the DM paths touch are real. The rest throw if reached, so a
  // path that quietly depends on auth behaviour cannot pass unnoticed.
  const notUsed = (fn: string) => () => {
    throw new Error(`[harness] AuthContext.${fn} is not implemented for the bot`);
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

  let ws: ReturnType<typeof useWebSocket> | null = null;
  let sender: ReturnType<typeof useSendDirectMessage> | null = null;

  const Probe = () => {
    // Reassigned every render, so reads below always see the current value —
    // connectionState in particular changes as the socket comes up.
    ws = useWebSocket();
    sender = useSendDirectMessage();
    return null;
  };

  const queryClient = new QueryClient({
    // A bench must not hide a failed fetch behind a retry that masks timing.
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  const tree = React.createElement(
    QueryClientProvider,
    { client: queryClient },
    React.createElement(
      AuthContext.Provider,
      { value: auth },
      React.createElement(
        StorageContext.Provider,
        { value: adapter },
        // Mounting authenticated is what triggers the provider's own connect
        // effect. The bot never calls connect() itself.
        React.createElement(WebSocketProvider, null, React.createElement(Probe, null))
      )
    )
  );

  let renderer: { unmount: () => void } | undefined;
  setActEnvironment(true);
  await act(async () => {
    renderer = TestRenderer.create(tree);
  });
  setActEnvironment(false);

  const full: MobileBot = {
    identity,
    captured,
    connectionState: () => (ws?.connectionState as string) ?? 'unknown',
    waitForConnected: async (timeoutMs = 60_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (ws?.isConnected) return;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error(
        `[harness] ${name} did not connect within ${timeoutMs}ms ` +
          `(state=${ws?.connectionState ?? 'unknown'})`
      );
    },
    send: async (toAddress: string, text: string) => {
      if (!sender) throw new Error('[harness] send hook not mounted');
      // Only the three required params: the hook fetches both registrations and
      // builds the device fan-out itself, which is the behaviour under test.
      await sender.mutateAsync({
        conversationId: conversationIdFor(toAddress),
        recipientAddress: toAddress,
        text,
      });
    },
    registration: async () =>
      (await getQuorumClient().fetchUserRegistration(identity.address, {
        fresh: true,
      })) as UserRegistration | null,
    inboxDepth: async () => (await fetchInboxTimestamps(identity.inboxAddress)).length,
    drainInbox: async () => {
      const timestamps = await fetchInboxTimestamps(identity.inboxAddress);
      if (timestamps.length) {
        const keyset = await getDeviceKeyset();
        if (!keyset) throw new Error('[harness] no device keyset to sign the inbox delete');
        await deleteInboxMessages(identity.inboxAddress, timestamps, keyset);
      }
      return timestamps.length;
    },
    stop: async () => {
      ws?.disconnect();
      setActEnvironment(true);
      await act(async () => {
        renderer?.unmount();
      });
      setActEnvironment(false);
    },
  };

  Object.assign(bot, full);
  return bot as MobileBot;
}
