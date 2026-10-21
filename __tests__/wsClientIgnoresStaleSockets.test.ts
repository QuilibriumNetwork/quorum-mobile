/**
 * The WebSocket client acts only on the socket that is current.
 *
 * ## The regression this pins (patched in `patches/@quilibrium+quorum-shared+*.patch`)
 *
 * `disconnect()` closed the socket without waiting for its close event, and a
 * `connect()` straight after (which the app did on every launch, whenever the
 * `user` object was replaced) opened a new one. The OLD socket's `onclose` then
 * ran against the live client: it stopped queue processing, reported the client
 * disconnected, and scheduled a reconnect that overwrote `this.ws`, orphaning
 * the socket that had just connected and subscribed. That socket stayed open,
 * so every frame it received was processed a second time. The reconnect timer
 * was never stored either, so a reconnect could reopen the socket after
 * sign-out.
 *
 * ## What is asserted
 *
 * - After disconnect + connect, the old socket's late close leaves the client
 *   connected, opens no extra socket, and its frames are ignored.
 * - A reconnect scheduled after a dropped connection is cancelled by
 *   `disconnect()`.
 * - CONTROL: a dropped current socket still reconnects.
 */
import { createRNWebSocketClient } from '@quilibrium/quorum-shared';

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  /** Close as a real socket does: the event arrives later. */
  close() {
    this.readyState = 3;
    setTimeout(() => this.onclose?.(), 0);
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  /** The server drops the connection. */
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
  receive(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const realWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;

beforeEach(() => {
  jest.useFakeTimers();
  FakeSocket.instances = [];
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket;
});
afterEach(() => {
  jest.useRealTimers();
  (globalThis as { WebSocket?: unknown }).WebSocket = realWebSocket;
});

function connectedClient() {
  const client = createRNWebSocketClient({ url: 'wss://relay.invalid', reconnectInterval: 1000 });
  const frames: unknown[] = [];
  client.setMessageHandler(async (message: unknown) => {
    frames.push(message);
  });
  return { client, frames };
}

it('ignores the old socket after a disconnect and reconnect', async () => {
  const { client } = connectedClient();
  const first = client.connect();
  FakeSocket.instances[0].open();
  await first;

  client.disconnect();
  const second = client.connect();
  FakeSocket.instances[1].open();
  await second;
  expect(client.isConnected).toBe(true);

  // The first socket's close event arrives now, after the second has opened.
  jest.advanceTimersByTime(0);
  jest.advanceTimersByTime(5000);

  expect(client.isConnected).toBe(true);
  expect(FakeSocket.instances).toHaveLength(2);
  client.disconnect();
});

/** Let the client's async queue processing run. */
async function flush() {
  for (let i = 0; i < 10; i++) {
    jest.advanceTimersByTime(0);
    await Promise.resolve();
  }
}

it('handles frames from the current socket only, not one it has replaced', async () => {
  const { client, frames } = connectedClient();
  const first = client.connect();
  FakeSocket.instances[0].open();
  await first;
  client.disconnect();
  const second = client.connect();
  FakeSocket.instances[1].open();
  await second;
  const frame = { inboxAddress: 'QmInbox', encryptedContent: 'x', timestamp: 1 };

  // The orphaned socket is still open and still receiving.
  FakeSocket.instances[0].receive(frame);
  await flush();
  expect(frames).toHaveLength(0);

  FakeSocket.instances[1].receive(frame);
  await flush();
  expect(frames).toHaveLength(1);
  client.disconnect();
});

it('cancels a scheduled reconnect on disconnect', async () => {
  const { client } = connectedClient();
  const first = client.connect();
  FakeSocket.instances[0].open();
  await first;

  FakeSocket.instances[0].drop();
  client.disconnect();
  jest.advanceTimersByTime(10_000);

  expect(FakeSocket.instances).toHaveLength(1);
  expect(client.isConnected).toBe(false);
});

it('CONTROL: still reconnects when the current socket drops', async () => {
  const { client } = connectedClient();
  const first = client.connect();
  FakeSocket.instances[0].open();
  await first;

  FakeSocket.instances[0].drop();
  jest.advanceTimersByTime(1000);

  expect(FakeSocket.instances).toHaveLength(2);
  client.disconnect();
});
