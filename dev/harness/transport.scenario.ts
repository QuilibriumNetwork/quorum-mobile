// NETWORKED. Talks to the production relay. No account, no keys, no writes —
// it opens a socket, subscribes to a random address that owns nothing, and
// closes. Nothing is registered and nothing is sent.
//
// ─── Why this scenario is the point of the whole harness ────────────────────
//
// Issue #183 item 2: frames are handed to ws.send, signed, socket open, and
// never arrive. Client visibility ends there because below it is React Native's
// native WebSocket. §26 of the investigation puts the drop at ~80% node-side
// with exactly that residual unresolved.
//
// Mobile's transport is shared's RNWebSocketClient, and at rn-websocket.ts:113
// it does:
//
//     // React Native uses the global WebSocket class
//     this.ws = new WebSocket(this.url);
//
// It constructs the GLOBAL WebSocket. On a device that global is RN's native
// implementation; under Node it is Node's. So importing the very same client
// class here swaps the implementation underneath mobile's own transport JS and
// changes nothing else — the single-variable experiment 29 device rounds could
// never run, because each of those changed platform, transport and client code
// together.
//
// This scenario only proves the swap connects. Measuring loss across it needs
// identity + two bots, which is the next slice.
//
// Run: yarn harness transport      (skip with HARNESS_OFFLINE=1)
import { RNWebSocketClient } from '@quilibrium/quorum-shared';

const WS_URL = process.env.QUORUM_WS_URL ?? 'wss://api.quorummessenger.com/ws';
const OFFLINE = process.env.HARNESS_OFFLINE === '1';

// CI and offline work must not fail on a network scenario.
const maybe = OFFLINE ? describe.skip : describe;

maybe('transport (networked — production relay)', () => {
  it("connects with mobile's own RNWebSocketClient over Node's WebSocket", async () => {
    // The global the client will construct. Asserted rather than assumed: if a
    // future Node or a stray polyfill removed it, the failure below would look
    // like a relay problem instead of a missing global.
    expect(typeof globalThis.WebSocket).toBe('function');

    const client = new RNWebSocketClient({
      url: WS_URL,
      // One attempt. An infinite reconnect would turn a relay outage into a
      // hanging scenario rather than a clear failure.
      maxReconnectAttempts: 1,
      reconnectInterval: 1000,
    });

    const states: string[] = [];
    client.onStateChange?.((s: string) => states.push(s));

    try {
      await client.connect();
      expect(client.state).toBe('connected');

      // Subscribe to an address nobody owns. The relay accepts the listen and
      // has nothing to deliver, which exercises the send path without creating
      // any state — no registration, no frames, nothing to clean up.
      const orphan = 'Qm' + 'h'.repeat(44);
      await client.listen?.([orphan]);

      // Still connected after a write proves the socket is genuinely open, not
      // merely reported open by a handshake that the relay then dropped.
      await new Promise((r) => setTimeout(r, 1500));
      expect(client.state).toBe('connected');
    } finally {
      client.disconnect?.();
    }

    expect(states).toContain('connected');
  }, 60_000);
});
