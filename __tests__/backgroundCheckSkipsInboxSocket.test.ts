/**
 * Background wake-ups no longer re-download the Quorum inbox backlog.
 *
 * ## The regression this pins
 *
 * `checkForNewMessages` runs on every silent push (pushReceivedTask) and every
 * 15 minutes (backgroundTask). Besides the Farcaster direct-cast check it
 * opened a raw socket, sent `listen` for every inbox the device owns and
 * waited 5 s. The relay answers a `listen` by re-sending every envelope still
 * pending on those inboxes, and nothing here acked or deleted them, so every
 * wake-up downloaded the whole backlog again. It never raised a notification
 * either: it counted frames with `type === 'message'` and `encrypted_content`,
 * and the relay's inbox frames are `{ encryptedContent, inboxAddress,
 * timestamp }` with no `type` (quorum-api server/client.go).
 *
 * The push task also ran that check for Quorum pushes (`hub-log`, `inbox`),
 * which say nothing about Farcaster, after first fetching and decrypting the
 * hub-log entry for a mute decision that only ever gated the check itself.
 *
 * ## What is asserted
 *
 * - `checkForNewMessages` opens no socket, even with a device keyset and
 *   inboxes to listen on, and still runs the Farcaster check.
 * - `pushWarrantsFarcasterDmCheck`: no for hub-log / inbox, yes for farcaster
 *   or an unreadable type.
 * - The registered push task runs the check for a Farcaster push and not for
 *   a Quorum one, and fetches no hub-log entry for a space push.
 */

const mockGetDirectCastToken = jest.fn<Promise<string | null>, []>(async () => null);
jest.mock('../services/farcaster/directCastAuth', () => ({
  getDirectCastToken: () => mockGetDirectCastToken(),
}));
jest.mock('../services/onboarding/secureStorage', () => ({
  getDeviceKeyset: async () => ({ inboxAddress: 'QmDevice' }),
  getInboxAddress: async () => 'QmDevice',
}));
jest.mock('../services/config/spaceStorage', () => ({
  getAllSpaceInboxAddresses: () => ['QmSpaceInbox'],
  getSpaceByHubAddress: () => ({ spaceId: 'space-1' }),
}));
jest.mock('../services/crypto/encryption-state-storage', () => ({
  encryptionStateStorage: {
    getAllConversationInboxAddresses: () => ['QmConversationInbox'],
    getConversationInboxKeypairByAddress: () => null,
  },
}));
jest.mock('../services/notifications/NotificationService', () => ({
  showMessageNotification: jest.fn(async () => 'id'),
}));
jest.mock('../services/farcasterClient', () => ({
  getDirectCastConversations: jest.fn(async () => ({ conversations: [] })),
}));
jest.mock('../services/offline/storage', () => ({
  mmkvStorage: { getItem: () => null, setItem: jest.fn(), removeItem: jest.fn() },
}));
jest.mock('../services/api/config', () => ({
  getApiConfig: () => ({ wsUrl: 'wss://relay.invalid', apiUrl: 'https://relay.invalid' }),
}));

// Push-task dependencies, including the ones it used to have.
let mockPushTask: ((args: { data: unknown; error: unknown }) => Promise<void>) | null = null;
jest.mock('expo-task-manager', () => ({
  defineTask: (_name: string, fn: typeof mockPushTask) => {
    mockPushTask = fn;
  },
}));
jest.mock('expo-notifications', () => ({ registerTaskAsync: jest.fn() }));
jest.mock('../services/notifications/notificationPrefs', () => ({
  getGlobalNotificationsEnabled: () => true,
  getSpaceNotificationsEnabled: () => true,
  getChannelNotificationsEnabled: () => true,
}));
const mockClassifyHubLogEntry = jest.fn(async () => null);
jest.mock('../services/notifications/hubLogClassifier', () => ({
  classifyHubLogEntry: (...a: unknown[]) => mockClassifyHubLogEntry(...(a as [])),
  SUPPRESSED_CONTENT_TYPES: new Set(),
}));
jest.mock('../services/config/configService', () => ({
  isConversationMutedForCurrentUser: () => false,
}));

import { checkForNewMessages } from '../services/notifications/BackgroundMessageService';
import { pushWarrantsFarcasterDmCheck } from '../services/notifications/pushKind';

class CountingSocket {
  static instances: CountingSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    CountingSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
}

const realWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
beforeEach(() => {
  jest.useFakeTimers();
  CountingSocket.instances = [];
  (globalThis as { WebSocket?: unknown }).WebSocket = CountingSocket;
  mockGetDirectCastToken.mockClear();
  mockClassifyHubLogEntry.mockClear();
});
afterEach(() => {
  jest.useRealTimers();
  (globalThis as { WebSocket?: unknown }).WebSocket = realWebSocket;
});

describe('checkForNewMessages', () => {
  it('opens no socket to the Quorum relay', async () => {
    const run = checkForNewMessages();
    // Long enough for the old probe's 5 s listen window and 15 s timeout.
    await jest.advanceTimersByTimeAsync(20_000);
    await run;
    expect(CountingSocket.instances).toHaveLength(0);
  });

  it('still runs the Farcaster direct-cast check', async () => {
    const run = checkForNewMessages();
    await jest.advanceTimersByTimeAsync(20_000);
    const result = await run;
    expect(mockGetDirectCastToken).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });
});

describe('pushWarrantsFarcasterDmCheck', () => {
  it('skips Quorum message pushes', () => {
    expect(pushWarrantsFarcasterDmCheck('hub-log')).toBe(false);
    expect(pushWarrantsFarcasterDmCheck('inbox')).toBe(false);
  });

  it('runs for Farcaster pushes and for ones it cannot classify', () => {
    expect(pushWarrantsFarcasterDmCheck('farcaster')).toBe(true);
    expect(pushWarrantsFarcasterDmCheck(undefined)).toBe(true);
    expect(pushWarrantsFarcasterDmCheck('something-new')).toBe(true);
  });
});

describe('the push task', () => {
  // Loaded after the mocks above; registers its task through defineTask.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../services/notifications/pushReceivedTask');

  const deliver = async (data: Record<string, unknown>) => {
    expect(mockPushTask).not.toBeNull();
    const run = mockPushTask!({ data: { data }, error: null });
    await jest.advanceTimersByTimeAsync(20_000);
    await run;
  };

  it('does not run the direct-cast check for a space message push', async () => {
    await deliver({ type: 'hub-log', hub_address: 'QmHub', inbox_address: 'QmSpaceInbox', seq: 7 });
    expect(mockGetDirectCastToken).not.toHaveBeenCalled();
    // Nor fetch and decrypt the entry to decide on a mute that gates nothing.
    expect(mockClassifyHubLogEntry).not.toHaveBeenCalled();
  });

  it('does not run the direct-cast check for a DM push', async () => {
    await deliver({ type: 'inbox', inbox_address: 'QmConversationInbox' });
    expect(mockGetDirectCastToken).not.toHaveBeenCalled();
  });

  it('runs the direct-cast check for a Farcaster push', async () => {
    await deliver({ type: 'farcaster', cast_hash: '0xabc' });
    expect(mockGetDirectCastToken).toHaveBeenCalledTimes(1);
  });
});
