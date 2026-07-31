// OFFLINE probe. Answers the two design questions that decide how a mobile bot
// can exist at all. It asserts capabilities of the runtime, not app behaviour —
// keep it, because if either answer flips the bot silently becomes wrong.
//
//   yarn harness two-bot-feasibility
//
// ── Q1: can two bots live in ONE process? ANSWER: no. ───────────────────────
//
// Desktop gives each bot its own MessageDB, so two bots in one process are
// naturally independent. Mobile cannot do that: its storage is reached through
// MODULE SINGLETONS — mmkvStorage, encryptionStateStorage, the messagesDb
// module, the SecureStore wrapper. Two bots sharing those would not be two
// clients; the second would overwrite the first's identity and ratchet state,
// and the run would measure nothing.
//
// jest.isolateModulesAsync looked like the answer, and the tests below show it
// genuinely does give each require-graph its own registry. It was still
// REJECTED, because that isolation covers only STATIC imports: app code also
// reaches storage through lazy requires (services/crypto/initEnvelopeGuard does
// `require('react-native-mmkv')` at call time), and those run after the isolate
// has closed, resolving against the shared registry instead.
//
// The leak is silent, it would fuse the two "devices" the bench is comparing,
// and any future lazy require would reopen it with nothing failing. So bots get
// one PROCESS each (see bot.ts) — which is also what a device actually is.
//
// These tests are kept anyway: they pin the behaviour the decision rests on, so
// if a jest upgrade changes it the reasoning can be rechecked rather than
// re-derived.
//
// ── Q2: can mobile's DM receive path run without a device? ──────────────────
//
// On desktop the receive path is MessageService, a plain class. Mobile's is
// ~4000 lines of useCallback INSIDE WebSocketProvider, a React component. There
// is no non-React seam, so the only faithful way to drive it is to render the
// provider — which is viable precisely because it renders no native views, just
// a context around its children.
import React from 'react';
import { act } from 'react';
import TestRenderer from 'react-test-renderer';

// react-test-renderer refuses to update outside act() unless this is set.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('two-bot feasibility (offline)', () => {
  it('Q1: isolateModulesAsync gives each bot its own storage singletons', async () => {
    // 'react-native-mmkv' resolves to the harness shim, whose stores live in one
    // module-level Map — exactly the sharing that would fuse two bots into one.
    const readBack = async (write: string) => {
      let value: string | undefined;
      await jest.isolateModulesAsync(async () => {
        const { createMMKV } = require('react-native-mmkv') as typeof import('./mmkv-shim');
        const store = createMMKV({ id: 'quorum-config' });
        // Same id in both isolates: real MMKV would hand back the SAME store.
        value = store.getString('whoami');
        store.set('whoami', write);
      });
      return value;
    };

    // First isolate writes; second must NOT see it. If it does, the registries
    // are shared and two bots in one process is off the table.
    expect(await readBack('bot-a')).toBeUndefined();
    expect(await readBack('bot-b')).toBeUndefined();
  });

  it('Q1b: isolated copies of a stateful app module do not share state', async () => {
    // The shim is harness-owned; this checks the property holds for MOBILE's own
    // module-scope state too, which is what actually matters.
    const idOf = async () => {
      let id: unknown;
      await jest.isolateModulesAsync(async () => {
        const mod = require('../../services/storage/mmkvAdapter');
        id = mod.getMMKVAdapter();
      });
      return id;
    };
    const a = await idOf();
    const b = await idOf();
    expect(a).toBeTruthy();
    // Different object identity ⇒ different module instance ⇒ different state.
    expect(a).not.toBe(b);
  });

  it('Q2: WebSocketProvider renders headlessly and yields its context value', async () => {
    const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
    const { WebSocketProvider, useWebSocket } = require('@/context/WebSocketContext');
    const AuthContext = require('@/context/AuthContext').default;
    const StorageContext = require('@/context/StorageContext').default;
    const { getMMKVAdapter } = require('@/services/storage/mmkvAdapter');

    let captured: Record<string, unknown> | null = null;
    const Probe = () => {
      captured = useWebSocket() as Record<string, unknown>;
      return null;
    };

    // Deliberately unauthenticated: this probe asks whether the component TREE
    // mounts and exposes its API, not whether it connects. Connecting is the
    // bot's job and needs a real identity.
    const auth = {
      authState: 'unauthenticated',
      user: null,
      isAuthenticated: false,
      isLoading: false,
      farcasterAuthToken: null,
      signIn: async () => {},
      signOut: async () => {},
      updateProfile: () => {},
      signMessage: async () => '',
      refreshFarcasterToken: async () => ({ error: 'no-credentials' as const }),
    };

    const tree = React.createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      React.createElement(
        AuthContext.Provider,
        { value: auth },
        React.createElement(
          StorageContext.Provider,
          { value: getMMKVAdapter() },
          React.createElement(WebSocketProvider, null, React.createElement(Probe, null))
        )
      )
    );

    let renderer: { unmount: () => void } | undefined;
    await act(async () => {
      renderer = TestRenderer.create(tree);
    });

    try {
      expect(captured).toBeTruthy();
      // The four entry points a bot needs: connect, subscribe to its inbox,
      // push frames, and read connection state.
      const value = captured as unknown as Record<string, unknown>;
      expect(typeof value.connect).toBe('function');
      expect(typeof value.subscribe).toBe('function');
      expect(typeof value.enqueueOutbound).toBe('function');
      expect(typeof value.disconnect).toBe('function');
      expect(value.connectionState).toBeDefined();
    } finally {
      await act(async () => {
        renderer?.unmount();
      });
    }
  }, 60_000);
});
