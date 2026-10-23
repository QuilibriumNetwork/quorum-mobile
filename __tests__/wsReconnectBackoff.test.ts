/**
 * The Quorum socket reconnects with exponential backoff, not every 2 s.
 *
 * ## The regression this pins
 *
 * The shared client was created with `reconnectInterval: 2000` and
 * `maxReconnectAttempts: Infinity`, and its reconnect is a fixed interval. A
 * relay outage or a dead network therefore opened a new socket every 2 s for
 * as long as it lasted, each one re-sending `listen` for every inbox and
 * `log-since` for every space the moment it opened, and every client came
 * back in the same 2 s step when the relay did.
 *
 * ## What is asserted
 *
 * - `reconnectDelay` doubles from ~1 s, is jittered, and never exceeds 30 s.
 * - With the real shared client set to `maxReconnectAttempts: 0` (as the
 *   provider now creates it) and the scheduler driving `connect()`:
 *   successive failures wait longer and longer up to the cap; a connection
 *   that stays up resets the backoff; one that drops at once does not; and a
 *   deliberate disconnect is never retried.
 * - From the provider source: the client is created with its own reconnect
 *   off and its state changes go through the scheduler.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createRNWebSocketClient, type WebSocketConnectionState } from '@quilibrium/quorum-shared';
import {
  createReconnectScheduler,
  reconnectDelay,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  RECONNECT_STABLE_MS,
} from '../services/api/wsReconnectBackoff';

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
    setTimeout(() => this.onclose?.(), 0);
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  /** The server drops the connection, or the attempt fails. */
  drop() {
    this.readyState = 3;
    this.onclose?.();
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

describe('reconnectDelay', () => {
  it('starts near one second and doubles', () => {
    const mid = () => 0.5;
    expect(reconnectDelay(0, mid)).toBe(Math.round(RECONNECT_BASE_MS * 0.75));
    expect(reconnectDelay(1, mid)).toBe(Math.round(RECONNECT_BASE_MS * 2 * 0.75));
    expect(reconnectDelay(2, mid)).toBe(Math.round(RECONNECT_BASE_MS * 4 * 0.75));
  });

  it('never exceeds the cap, however many attempts', () => {
    expect(reconnectDelay(50, () => 1)).toBe(RECONNECT_MAX_MS);
    expect(reconnectDelay(1000, () => 0.999)).toBeLessThanOrEqual(RECONNECT_MAX_MS);
  });

  it('jitters within the upper half of the step', () => {
    expect(reconnectDelay(3, () => 0)).toBe(4_000);
    expect(reconnectDelay(3, () => 1)).toBe(8_000);
  });
});

/** The provider's wiring, minus React: client + scheduler, reconnect driven by connect(). */
function wiredClient() {
  const client = createRNWebSocketClient({ url: 'wss://relay.invalid', maxReconnectAttempts: 0 });
  const reported: WebSocketConnectionState[] = [];
  const scheduler = createReconnectScheduler({
    reconnect: () => {
      client.connect().catch(() => {});
    },
    random: () => 1, // the top of each step, so delays are exact
  });
  client.onStateChange((state) => reported.push(scheduler.onStateChange(state)));
  scheduler.setWanted(true);
  return { client, scheduler, reported };
}

/** Advance until a new socket is constructed; return how long that took. */
function msUntilNextSocket(limitMs = 120_000): number {
  const before = FakeSocket.instances.length;
  let elapsed = 0;
  while (FakeSocket.instances.length === before && elapsed < limitMs) {
    jest.advanceTimersByTime(100);
    elapsed += 100;
  }
  return elapsed;
}

const latest = () => FakeSocket.instances[FakeSocket.instances.length - 1];

it('waits longer after each failed attempt, up to the cap', async () => {
  const { client } = wiredClient();
  void client.connect().catch(() => {});
  latest().drop(); // the first attempt fails

  const waits: number[] = [];
  for (let i = 0; i < 8; i++) {
    waits.push(msUntilNextSocket());
    latest().drop();
  }

  expect(waits.slice(0, 5)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
  expect(waits.slice(5)).toEqual([30_000, 30_000, 30_000]);
  client.disconnect();
});

it('does not retry on its own: only the scheduler reconnects', async () => {
  // The control for the wiring above: with maxReconnectAttempts 0 and nobody
  // driving connect(), a drop stays down.
  const client = createRNWebSocketClient({ url: 'wss://relay.invalid', maxReconnectAttempts: 0 });
  const opening = client.connect();
  latest().open();
  await opening;
  latest().drop();
  jest.advanceTimersByTime(120_000);
  expect(FakeSocket.instances).toHaveLength(1);
  expect(client.state).toBe('disconnected');
});

it('resets to the short first step after a connection that stayed up', async () => {
  const { client } = wiredClient();
  void client.connect().catch(() => {});
  latest().drop();
  msUntilNextSocket(); // 1 s
  latest().drop();
  msUntilNextSocket(); // 2 s
  latest().drop();
  msUntilNextSocket(); // 4 s

  // This one opens and stays up long enough to count.
  latest().open();
  jest.advanceTimersByTime(RECONNECT_STABLE_MS);
  latest().drop();

  expect(msUntilNextSocket()).toBe(1_000);
  client.disconnect();
});

it('keeps backing off when connections open and drop straight away', async () => {
  const { client } = wiredClient();
  void client.connect().catch(() => {});
  latest().drop();
  expect(msUntilNextSocket()).toBe(1_000);

  latest().open();
  latest().drop(); // a flapping relay
  expect(msUntilNextSocket()).toBe(2_000);

  latest().open();
  latest().drop();
  expect(msUntilNextSocket()).toBe(4_000);
  client.disconnect();
});

it('never retries a deliberate disconnect', async () => {
  const { client, scheduler, reported } = wiredClient();
  const opening = client.connect();
  latest().open();
  await opening;

  // What the provider's disconnect() does: stop wanting, then close.
  scheduler.setWanted(false);
  client.disconnect();
  jest.advanceTimersByTime(120_000);

  expect(FakeSocket.instances).toHaveLength(1);
  expect(scheduler.pending).toBe(false);
  expect(reported[reported.length - 1]).toBe('disconnected');
});

it("reports 'reconnecting' while a retry is waiting", async () => {
  const { client, reported } = wiredClient();
  const opening = client.connect();
  latest().open();
  await opening;
  latest().drop();
  expect(reported[reported.length - 1]).toBe('reconnecting');
  client.disconnect();
});

describe('WebSocketContext wiring', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'context', 'WebSocketContext.tsx'),
    'utf8',
  );
  const start = source.indexOf('const getOrCreateClient = useCallback');
  const end = source.indexOf('const connect = useCallback', start);
  const body = source.slice(start, end);

  it("turns the client's fixed-interval reconnect off", () => {
    expect(body).toMatch(/maxReconnectAttempts:\s*0/);
    expect(body).not.toMatch(/reconnectInterval:\s*2000/);
    expect(body).not.toMatch(/maxReconnectAttempts:\s*Infinity/);
  });

  it('routes every state change through the scheduler', () => {
    expect(body).toContain('createReconnectScheduler(');
    expect(body).toContain('setConnectionState(scheduler.onStateChange(state))');
  });

  it('stops wanting the socket before a deliberate disconnect closes it', () => {
    const d = source.slice(
      source.indexOf('const disconnect = useCallback'),
      source.indexOf('const enqueueOutbound = useCallback'),
    );
    expect(d.indexOf('setWanted(false)')).toBeGreaterThan(-1);
    expect(d.indexOf('setWanted(false)')).toBeLessThan(d.indexOf('client.disconnect()'));
  });
});
