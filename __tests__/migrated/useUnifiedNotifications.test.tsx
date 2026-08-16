/**
 * `useUnifiedNotifications`'s DM/background-ping rows must show the sender's
 * CURRENT resolved name in the "Bob: hey there" preview line, not the name
 * frozen on the conversation record at message-receive time.
 *
 * ## Why this is a hook test, not a component test
 *
 * `conversationDetails.senderName` (built here) feeds
 * `partitionNotifications.ts`'s `conversationSnippet`, which composes the
 * WHOLE preview string ("Bob: hey there") that `app/(tabs)/profile/index.tsx`
 * renders verbatim as `item.body`. Resolving inside the hook — rather than
 * moving composition into the screen — is safe specifically because this
 * hook is only ever called from inside the root `IdentityScopeProvider`
 * (`AppTabBar`, the notifications screen), so its own re-render already
 * reacts to a fresh identity context; nothing here is a plain string
 * computed once and frozen. Asserting on `result.current.items[0].body`
 * is the load-bearing case for this class stated in terms of what this
 * hook returns, since that return value IS what the screen renders
 * unchanged.
 *
 * ## The frozen field, and why 'You' and Farcaster stay untouched
 *
 * `Conversation.lastMessageSenderName` is written once, at message-receive
 * time (`context/WebSocketContext.tsx`), and never updated — a partner
 * rename between then and now leaves it stale. The write stays; only the
 * read here changes. 'You' (the viewer's own last message) is a literal,
 * never a lookup. A Farcaster conversation's `address` is a synthetic
 * `fid:<n>` — a separate identity namespace with no roster and no `.q` —
 * so it is excluded from resolution the same way `ShareInviteSheet`/
 * `SocialFeedModal` exclude Farcaster rows from the member resolver.
 *
 * ## What is mocked, and why
 *
 * Every OTHER input `useUnifiedNotifications` gathers
 * (`useFarcasterNotifications`, `useHaatzNotifications`, `useDMMute`,
 * `useUnifiedConversations`, the notification/mention logs, Farcaster
 * dismissal) is mocked wholesale — this file's job is only the
 * `conversationDetails` join, and `partitionNotifications` itself (real,
 * pure) already has its own coverage in `notificationPartition.test.ts`.
 * `IdentityScopeProvider` is real. `@/utils/verifyQnsClaim` is deliberately
 * NOT mocked — the verified case must prove a genuinely verified claim
 * renders `.q`, not merely that the row trusts whatever `verifiedQnsNames`
 * already contains.
 */
import React from 'react';
import { renderHook, waitFor, cleanup, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { IdentityScopeProvider } from '@/identity/identityProvider';
import { MAX_QNS_LOOKUPS } from '@/hooks/chat/useConversationsWithQnsNames';
import type { Conversation } from '@/hooks/chat/useConversations';
import type { NotificationLogEntry } from '@/services/notifications/notificationLog';

// See ReactionDetailsModal.test.tsx / SpaceSettingsModal.test.tsx for why this
// is required: notifyManager defers subscriber notifications through a real
// setTimeout(0), which lands IdentityScopeProvider's useQueries-driven
// re-render outside whatever act() scope wrapped the render call otherwise.
notifyManager.setNotifyFunction((callback) => {
  act(callback);
});

// A genuine ed448 key/address pair, reused verbatim from
// `shareInviteSheetName.test.tsx` — deriveAddress(KEY) === PARTNER, real
// math, not a placeholder.
const PARTNER = 'QmRxwsciKWz7fvph4PobmabjChKPZtvkBcE4oALnogXDYW';
const KEY =
  '030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b';

// `mock`-prefixed so the jest.mock factories below (hoisted) may close over
// them, per the convention the rest of this migration uses.
let mockConversations: Conversation[];
let mockChatEntries: NotificationLogEntry[];
let mockGetPublicProfile: jest.Mock;
let mockResolveBatch: jest.Mock;

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ farcasterAuthToken: undefined }),
}));

jest.mock('@/hooks/useFarcasterNotifications', () => ({
  useFarcasterNotifications: () => ({
    data: undefined,
    isLoading: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    fetchNextPage: jest.fn(),
    refetch: jest.fn(),
    error: null,
  }),
  flattenFarcasterNotifications: () => [],
}));

jest.mock('@/hooks/useHaatzNotifications', () => ({
  useHaatzNotifications: () => ({ data: [], isLoading: false, refetch: jest.fn() }),
}));

jest.mock('@/hooks/chat/useDMMute', () => ({
  useDMMute: () => ({ mutedConversations: new Set<string>() }),
}));

jest.mock('@/hooks/chat/useUnifiedConversations', () => ({
  useUnifiedConversations: () => ({ conversations: mockConversations, isLoading: false }),
}));

jest.mock('@/services/notifications/notificationLog', () => ({
  // `partitionNotifications.ts` (real, unmocked) also imports the pure
  // `notificationLogOrigin` from this same module — preserve it, only stub
  // the hook and the watermark getter this file's own
  // `useUnifiedNotifications` calls directly.
  ...jest.requireActual('@/services/notifications/notificationLog'),
  useNotificationLog: () => ({ entries: mockChatEntries }),
  getLastSeenTimestamp: () => 0,
}));

jest.mock('@/services/notifications/mentionReplyLog', () => ({
  useMentionReplyLog: () => ({ entries: [] }),
  getQuorumTabSeenAt: () => 0,
}));

jest.mock('@/services/notifications/farcasterDismissal', () => ({
  // `partitionNotifications.ts` (real, unmocked) also imports the pure
  // `reachedWatermark`/`isDismissed`/`isItemDismissed` from this same
  // module — preserve them, only stub the two hooks this file's own
  // `useUnifiedNotifications` calls directly.
  ...jest.requireActual('@/services/notifications/farcasterDismissal'),
  useFarcasterClearedBefore: () => 0,
  useFarcasterDismissedKeys: () => ({}),
}));

jest.mock('@/services/api/quorumClient', () => ({
  getQuorumClient: () => ({
    getPublicProfile: (address: string) => mockGetPublicProfile(address),
  }),
}));

jest.mock('@/services/api/qnsClient', () => ({
  resolveBatch: (names: string[]) => mockResolveBatch(names),
}));

// `@/utils/verifyQnsClaim` is deliberately NOT mocked — see file header.

import { useUnifiedNotifications } from '@/hooks/useUnifiedNotifications';

let queryClient: QueryClient;

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <IdentityScopeProvider rostersBySpace={{}} selfAddress={null}>
        {children}
      </IdentityScopeProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockGetPublicProfile = jest.fn().mockResolvedValue({
    display_name: 'Bob Current',
    primary_username: 'bob',
    profile_image: '',
    bio: '',
    timestamp: 0,
    signature: '',
  });
  mockResolveBatch = jest.fn().mockResolvedValue([
    {
      header: { authorityKey: '0xabc', name: 'bob', parent: null, createdAt: 0, updatedAt: 0 },
      address: '0xrecord',
      resolveKey: KEY,
      metadata: null,
    },
  ]);
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe('useUnifiedNotifications — the DM sender prefix resolves through @/identity', () => {
  it("shows the sender's CURRENT verified .q, not the name frozen on the conversation at message-receive time", async () => {
    mockConversations = [
      {
        conversationId: 'conv-1',
        type: 'direct',
        timestamp: 1_700_000_000_000,
        address: PARTNER,
        icon: '',
        displayName: 'Conversation Title',
        source: 'quorum',
        lastMessageSenderName: 'Old Bob Name',
        lastMessagePreview: 'hey there',
      } as Conversation,
    ];
    mockChatEntries = [
      {
        id: 'chat-1',
        title: 'New message',
        body: 'fallback body',
        createdAt: 1_700_000_000_000,
        data: { type: 'message', conversationId: 'conv-1', origin: 'quorum' },
      } as NotificationLogEntry,
    ];

    const { result } = renderHook(
      () => useUnifiedNotifications({ enrichConversations: true }),
      { wrapper },
    );

    // The verified name now lands in the TITLE, and `conversationSnippet`
    // then suppresses the prefix because it would merely repeat it
    // (`who !== d.displayName`). So the row reads "bob.q" / "hey there"
    // rather than "Conversation Title" / "bob.q: hey there" — same
    // information, no duplication, and the stale string gone from both halves.
    // This assertion used to expect the duplicated form, which only looked
    // right because the title was stale.
    await waitFor(() => expect(result.current.items[0]?.title).toBe('bob.q'));
    expect(result.current.items[0]?.body).toBe('hey there');
    expect(result.current.items[0]?.title).not.toBe('Conversation Title');
    expect(result.current.items[0]?.body).not.toContain('Old Bob Name');
  });

  it("titles the row with the partner's verified .q, not the stored conversation title", async () => {
    // The row TITLE came from the raw `conversation.displayName`, so a DM
    // notification named the partner with whatever string the conversation was
    // created with and could never show a `.q` — while the very same person
    // rendered as `bob.q` inside the conversation. Only the sender prefix went
    // through the ladder, and the title does not use it.
    mockConversations = [
      {
        conversationId: 'conv-title',
        type: 'direct',
        timestamp: 1_700_000_000_000,
        address: PARTNER,
        icon: '',
        displayName: 'Stale Conversation Title',
        source: 'quorum',
        lastMessageSenderName: 'Old Bob Name',
        lastMessagePreview: 'hey there',
      } as Conversation,
    ];
    mockChatEntries = [
      {
        id: 'chat-title',
        title: 'New message',
        body: 'fallback body',
        createdAt: 1_700_000_000_000,
        data: { type: 'message', conversationId: 'conv-title', origin: 'quorum' },
      } as NotificationLogEntry,
    ];

    const { result } = renderHook(
      () => useUnifiedNotifications({ enrichConversations: true }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.items[0]?.title).toBe('bob.q'));
    expect(result.current.items[0]?.title).not.toBe('Stale Conversation Title');
  });

  it('titles the row with the partner\'s .q even when the VIEWER sent last', async () => {
    // The enrich set used to be gated on `isResolvableQuorumSender`, which
    // requires the partner to have sent the last message. The title names the
    // partner either way, so a conversation you replied to most recently was
    // never enriched and could never gain the `.q`. This is the case that gate
    // excluded.
    mockConversations = [
      {
        conversationId: 'conv-self-last',
        type: 'direct',
        timestamp: 1_700_000_000_000,
        address: PARTNER,
        icon: '',
        displayName: 'Stale Conversation Title',
        source: 'quorum',
        lastMessageSenderName: 'You',
        lastMessagePreview: 'my reply',
      } as Conversation,
    ];
    mockChatEntries = [
      {
        id: 'chat-self-last',
        title: 'New message',
        body: 'fallback body',
        createdAt: 1_700_000_000_000,
        data: { type: 'message', conversationId: 'conv-self-last', origin: 'quorum' },
      } as NotificationLogEntry,
    ];

    const { result } = renderHook(
      () => useUnifiedNotifications({ enrichConversations: true }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.items[0]?.title).toBe('bob.q'));
    // The prefix stays the literal 'You' — resolving the TITLE must not leak
    // into the "who spoke" slot, which is not a member lookup at all.
    expect(result.current.items[0]?.body).toBe('You: my reply');
  });

  it('keeps the stored title when the ladder can only offer an address', async () => {
    // CONTROL ARM. An unsynced partner must keep the name the conversation
    // carries rather than degrading to a hash — the stored string is often a
    // real name and is never worse.
    mockGetPublicProfile = jest.fn().mockResolvedValue(null);
    mockResolveBatch = jest.fn().mockResolvedValue([]);
    mockConversations = [
      {
        conversationId: 'conv-unsynced',
        type: 'direct',
        timestamp: 1_700_000_000_000,
        address: PARTNER,
        icon: '',
        displayName: 'Only Known Name',
        source: 'quorum',
        lastMessageSenderName: 'Only Known Name',
        lastMessagePreview: 'hi',
      } as Conversation,
    ];
    mockChatEntries = [
      {
        id: 'chat-unsynced',
        title: 'New message',
        body: 'fallback body',
        createdAt: 1_700_000_000_000,
        data: { type: 'message', conversationId: 'conv-unsynced', origin: 'quorum' },
      } as NotificationLogEntry,
    ];

    const { result } = renderHook(
      () => useUnifiedNotifications({ enrichConversations: true }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.items[0]?.title).toBe('Only Known Name'));
    expect(result.current.items[0]?.title).not.toContain(PARTNER.slice(0, 8));
  });

  it("shows the literal 'You' for the viewer's own last message, never a lookup", async () => {
    mockConversations = [
      {
        conversationId: 'conv-2',
        type: 'direct',
        timestamp: 1_700_000_000_000,
        address: PARTNER,
        icon: '',
        displayName: 'Conversation Title',
        source: 'quorum',
        lastMessageSenderName: 'You',
        lastMessagePreview: 'on my way',
      } as Conversation,
    ];
    mockChatEntries = [
      {
        id: 'chat-2',
        title: 'New message',
        body: 'fallback body',
        createdAt: 1_700_000_000_000,
        data: { type: 'message', conversationId: 'conv-2', origin: 'quorum' },
      } as NotificationLogEntry,
    ];

    const { result } = renderHook(
      () => useUnifiedNotifications({ enrichConversations: true }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.items[0]?.body).toBe('You: on my way'));
    // A lookup for the PARTNER is expected here now, and is the point: the
    // row's title names them whichever way the last message went, so the
    // enrich set is no longer gated on who spoke. This assertion previously
    // read `not.toHaveBeenCalled()`, which encoded that gate — and that gate
    // was the bug (a conversation you replied to last could never gain a `.q`).
    //
    // What must still never happen is a lookup driven by 'You', which is a
    // literal and not a member at all. Exactly one address, and it is theirs.
    expect(mockGetPublicProfile.mock.calls.flat()).toEqual([PARTNER]);
  });

  it('leaves a Farcaster conversation\'s synthetic fid address unresolved — never routed through the member resolver', async () => {
    mockConversations = [
      {
        conversationId: 'farcaster:conv-3',
        type: 'direct',
        timestamp: 1_700_000_000_000,
        address: 'fid:4242',
        icon: '',
        displayName: 'Farcaster Friend',
        source: 'farcaster',
        lastMessageSenderName: 'Farcaster Friend',
        lastMessagePreview: 'gm',
      } as Conversation,
    ];
    mockChatEntries = [
      {
        id: 'chat-3',
        title: 'New message',
        body: 'fallback body',
        createdAt: 1_700_000_000_000,
        data: { type: 'message', conversationId: 'farcaster:conv-3', origin: 'farcaster' },
      } as NotificationLogEntry,
    ];

    const { result } = renderHook(
      () => useUnifiedNotifications({ enrichConversations: true }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.items[0]?.body).toBe('gm'));
    expect(mockGetPublicProfile).not.toHaveBeenCalledWith('fid:4242');
  });
});

/**
 * The `enrich` section of this row's brief: MEASURE the request count.
 * `QmPeerA<n>...` addresses, the repo's placeholder family — synthetic
 * distinct DM partners, not derivable/real ones, since this test only cares
 * about how many `getPublicProfile` calls a long conversation list produces.
 */
function fakeAddress(i: number): string {
  return `QmPeerA${i.toString().padStart(3, '0')}${'x'.repeat(38)}`;
}

describe('useUnifiedNotifications — enrichment fan-out is bounded, not per-row', () => {
  it(`caps the fan-out at MAX_QNS_LOOKUPS (${MAX_QNS_LOOKUPS}) for a long conversation list`, async () => {
    // 80 distinct DM partners, most-recent-first (qnsLookupAddresses relies
    // on this ordering, matching what useUnifiedConversations sorts by) —
    // over the cap.
    mockConversations = Array.from({ length: 80 }, (_, i) => ({
      conversationId: `conv-${i}`,
      type: 'direct',
      timestamp: 1_700_000_000_000 - i,
      address: fakeAddress(i),
      icon: '',
      displayName: `Conv ${i}`,
      source: 'quorum',
      lastMessageSenderName: `Sender ${i}`,
      lastMessagePreview: 'hi',
    } as Conversation));
    mockChatEntries = [];

    renderHook(() => useUnifiedNotifications({ enrichConversations: true }), { wrapper });

    await waitFor(() => expect(mockGetPublicProfile).toHaveBeenCalledTimes(MAX_QNS_LOOKUPS));
    await new Promise((r) => setTimeout(r, 10));
    expect(mockGetPublicProfile).toHaveBeenCalledTimes(MAX_QNS_LOOKUPS);
  });
});
