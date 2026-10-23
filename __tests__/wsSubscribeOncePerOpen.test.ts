/**
 * Each socket open sends ONE `listen` per inbox.
 *
 * ## The regression this pins
 *
 * On every cold start the provider's `connect()` awaited `client.connect()`
 * and then subscribed the device inbox, every space inbox and every
 * conversation inbox itself. But the client's `onopen` had already run the
 * resubscribe handler, which listens on exactly those inboxes (it reads the
 * same storage, plus anything subscribed since). So every inbox got two
 * `listen`s, and the relay answers each `listen` by re-sending every envelope
 * still pending on that inbox (quorum-api server/client.go, `case "listen"`):
 * the whole backlog was downloaded twice on each launch.
 *
 * ## What is asserted
 *
 * - With the real shared client, the resubscribe handler runs on the first
 *   open AND on a reopen, so it alone covers both cases (the reason the
 *   explicit subscribes could go).
 * - From the provider source: the resubscribe handler gathers all three inbox
 *   sources, and `connect()` no longer subscribes anything itself.
 */
import * as fs from 'fs';
import * as path from 'path';
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
  close() {
    this.readyState = 3;
    setTimeout(() => this.onclose?.(), 0);
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
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

const INBOXES = ['QmDevice', 'QmSpace', 'QmConversation'];

/** Inbox → number of `listen` frames that named it, on one socket. */
function listensPerInbox(socket: FakeSocket): Map<string, number> {
  const counts = new Map<string, number>();
  for (const frame of socket.sent) {
    const parsed = JSON.parse(frame) as { type?: string; inbox_addresses?: string[] };
    if (parsed.type !== 'listen') continue;
    for (const inbox of parsed.inbox_addresses ?? []) {
      counts.set(inbox, (counts.get(inbox) ?? 0) + 1);
    }
  }
  return counts;
}

it('runs the resubscribe handler on the first open and on every reopen', async () => {
  const client = createRNWebSocketClient({ url: 'wss://relay.invalid', maxReconnectAttempts: 0 });
  client.setResubscribeHandler(async () => {
    await client.subscribe(INBOXES);
  });

  const first = client.connect();
  FakeSocket.instances[0].open();
  await first;
  expect(listensPerInbox(FakeSocket.instances[0])).toEqual(
    new Map(INBOXES.map((inbox) => [inbox, 1])),
  );

  FakeSocket.instances[0].drop();
  const second = client.connect();
  FakeSocket.instances[1].open();
  await second;
  expect(listensPerInbox(FakeSocket.instances[1])).toEqual(
    new Map(INBOXES.map((inbox) => [inbox, 1])),
  );
  client.disconnect();
});

describe('WebSocketContext wiring', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'context', 'WebSocketContext.tsx'),
    'utf8',
  );

  function section(startAnchor: string, endAnchor: string): string {
    const start = source.indexOf(startAnchor);
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf(endAnchor, start);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it('resubscribes the device, space and conversation inboxes on open', () => {
    const body = section('const handleResubscribe = useCallback', 'const getOrCreateClient = useCallback');
    expect(body).toContain('ownInboxAddressRef.current');
    expect(body).toContain('getAllSpaceInboxAddresses()');
    expect(body).toContain('encryptionStateStorage.getAllConversationInboxAddresses()');
    expect(body).toContain('client.subscribe(inboxArray)');
  });

  it('registers that handler on the client', () => {
    const body = section('const getOrCreateClient = useCallback', 'const connect = useCallback');
    expect(body).toContain('client.setResubscribeHandler(handleResubscribe)');
  });

  it('does not subscribe a second time from connect()', () => {
    const body = section('const connect = useCallback', 'const disconnect = useCallback');
    expect(body).toContain('client.connect()');
    expect(body).not.toMatch(/\.subscribe\(/);
  });
});
