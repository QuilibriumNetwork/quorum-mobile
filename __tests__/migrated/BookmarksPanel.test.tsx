/**
 * BookmarksPanel renders a bookmark's sender and source labels from the
 * MEMBER, not from the frozen strings a bookmark's `cachedPreview` stores.
 *
 * ## Why this row is different from every earlier one
 *
 * A bookmark's `cachedPreview.senderName`/`sourceName` are captured once, at
 * bookmark time, and rendered verbatim forever after — the "frozen name"
 * class the audit ratchet cannot see (neither field spells `displayName` or
 * any of its siblings). A rename after the bookmark was made is invisible to
 * every earlier migrated row; this file proves it is no longer invisible
 * here.
 *
 * ## `bookmarks` is NOT filtered to one space
 *
 * `useBookmarks()` (`hooks/useUserConfig.ts`) loads every bookmark the user
 * has ever made, across every space and every DM, via
 * `getLocalBookmarks(user.address)` — no space/channel/conversation filter
 * anywhere in that path. `BookmarksPanel` itself takes no `spaceId` prop.
 * So a single ambient scope is wrong; each row must resolve against ITS OWN
 * `bookmark.spaceId`. The two-space case below (SPACE_A vs SPACE_B) is the
 * proof: the same panel, one render, two different per-space nicknames.
 *
 * ## The DM `sourceName` defect (`DMChatArea.tsx:498`)
 *
 * `DMChatArea`'s bookmark write freezes
 * `sourceName: conversationData?.displayName || 'DM'` — a DM partner's name,
 * captured once. The WRITE stays (standing decision). What changes is the
 * READ: `BookmarksPanel` now looks up the bookmark's `conversationId` via
 * `getConversationSync` (a local, synchronous MMKV read — no network) to
 * recover the partner's ADDRESS, then resolves through the ladder the same
 * as any other member. A bookmark whose conversation is gone locally falls
 * back to the frozen string — the "no address available" case.
 *
 * ## What is mocked, and why
 *
 * `react-native-safe-area-context` — reached by the always-mounted
 * `BaseModal`. `@/services/storage/mmkvAdapter` — the local DM-conversation
 * lookup for the `sourceName` fix; only `getConversationSync` is used.
 * `IdentityScopeProvider` is real. `claimedNameBelongsTo` is deliberately
 * NOT mocked — the verified case must prove a genuinely verified claim
 * renders `.q`, not merely that the row trusts whatever `verifiedQnsNames`
 * already contains.
 */
import React from 'react';
import { screen, waitFor, cleanup, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { renderWithProviders } from '@/jest/renderWithProviders';
import { IdentityScopeProvider } from '@/identity/identityProvider';
import { MAX_QNS_LOOKUPS } from '@/hooks/chat/useConversationsWithQnsNames';
import type { Bookmark } from '@quilibrium/quorum-shared';

// See ReactionDetailsModal.test.tsx / SpaceSettingsModal.test.tsx for why this
// is required: notifyManager defers subscriber notifications through a real
// setTimeout(0), which lands IdentityScopeProvider's useQueries-driven
// re-render outside whatever act() scope wrapped the render call otherwise.
notifyManager.setNotifyFunction((callback) => {
  act(callback);
});

// A genuine ed448 key/address pair, reused verbatim from
// `shareInviteSheetName.test.tsx` — deriveAddress(KEY) === TARGET, real math,
// not a placeholder.
const TARGET = 'QmRxwsciKWz7fvph4PobmabjChKPZtvkBcE4oALnogXDYW';
const KEY =
  '030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b';
const SPACE_A = 'space-a';
const SPACE_B = 'space-b';
const NICKNAME_MEMBER = 'QmPeerANicknameNicknameNicknameNicknameNickna';

let mockGetPublicProfile: jest.Mock;
let mockResolveBatch: jest.Mock;

jest.mock('@/services/api/quorumClient', () => ({
  getQuorumClient: () => ({
    getPublicProfile: (address: string) => mockGetPublicProfile(address),
  }),
}));

jest.mock('@/services/api/qnsClient', () => ({
  resolveBatch: (names: string[]) => mockResolveBatch(names),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// `mock`-prefixed so the jest.mock factory (hoisted) may close over it.
let mockGetConversationSync: jest.Mock;
jest.mock('@/services/storage/mmkvAdapter', () => ({
  getConversationSync: (conversationId: string) => mockGetConversationSync(conversationId),
}));

// `claimedNameBelongsTo` is deliberately NOT mocked — see file header.

import { BookmarksPanel } from '@/components/Chat/BookmarksPanel';

let queryClient: QueryClient;

function baseBookmark(overrides: Partial<Bookmark> & { bookmarkId: string }): Bookmark {
  return {
    messageId: `msg-${overrides.bookmarkId}`,
    sourceType: 'channel',
    createdAt: 1_700_000_000_000,
    cachedPreview: {
      senderAddress: TARGET,
      senderName: 'Stale Name',
      textSnippet: 'hello there',
      messageDate: 1_700_000_000_000,
      sourceName: 'stale-source',
      contentType: 'text',
    },
    ...overrides,
  } as Bookmark;
}

function renderPanel(
  bookmarks: Bookmark[],
  rostersBySpace: Record<string, Record<string, { display_name?: string; global_display_name?: string }>> = {},
) {
  return renderWithProviders(
    <QueryClientProvider client={queryClient}>
      <IdentityScopeProvider rostersBySpace={rostersBySpace} selfAddress={null}>
        <BookmarksPanel
          visible
          onClose={() => {}}
          bookmarks={bookmarks}
          onRemoveBookmark={() => {}}
          theme={
            {
              colors: {
                primary: '#000',
                textMuted: '#000',
                textStrong: '#000',
                textMain: '#000',
                textSubtle: '#000',
                surface2: '#000',
                surface3: '#000',
                surface5: '#000',
              },
              fonts: {
                medium: { fontFamily: 'System', fontWeight: '500' },
                regular: { fontFamily: 'System', fontWeight: '400' },
              },
            } as never
          }
        />
      </IdentityScopeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockGetConversationSync = jest.fn().mockReturnValue(undefined);
  mockGetPublicProfile = jest.fn().mockResolvedValue({
    display_name: 'Alice Smith',
    primary_username: 'alice',
    profile_image: '',
    bio: '',
    timestamp: 0,
    signature: '',
  });
  mockResolveBatch = jest.fn().mockResolvedValue([
    {
      header: { authorityKey: '0xabc', name: 'alice', parent: null, createdAt: 0, updatedAt: 0 },
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

describe('BookmarksPanel — sender and source resolve through @/identity', () => {
  it('renders the sender under their CURRENT verified .q, not the stale name frozen on the bookmark', async () => {
    const bookmark = baseBookmark({
      bookmarkId: 'bm-1',
      spaceId: SPACE_A,
      channelId: 'chan-1',
      cachedPreview: {
        senderAddress: TARGET,
        senderName: 'Stale Name',
        textSnippet: 'hello there',
        messageDate: 1_700_000_000_000,
        sourceName: '#general',
        contentType: 'text',
      },
    });

    renderPanel([bookmark]);

    await waitFor(() => expect(screen.getByText('alice.q')).toBeTruthy());
    expect(screen.queryByText('Stale Name')).toBeNull();
    // A channel's own name is not a member's — never resolved, never touched.
    expect(screen.getByText('#general')).toBeTruthy();
  });

  it('spans spaces: two bookmarks in different spaces each resolve against THEIR OWN roster, not one ambient scope', async () => {
    const bookmarkSpaceA = baseBookmark({
      bookmarkId: 'bm-a',
      spaceId: SPACE_A,
      channelId: 'chan-a',
      cachedPreview: {
        senderAddress: TARGET,
        senderName: 'Stale A',
        textSnippet: 'from space A',
        messageDate: 1_700_000_000_000,
        sourceName: '#a-general',
        contentType: 'text',
      },
    });
    const bookmarkSpaceB = baseBookmark({
      bookmarkId: 'bm-b',
      spaceId: SPACE_B,
      channelId: 'chan-b',
      cachedPreview: {
        senderAddress: NICKNAME_MEMBER,
        senderName: 'Stale B',
        textSnippet: 'from space B',
        messageDate: 1_700_000_000_000,
        sourceName: '#b-general',
        contentType: 'text',
      },
    });

    renderPanel([bookmarkSpaceA, bookmarkSpaceB], {
      [SPACE_B]: { [NICKNAME_MEMBER]: { display_name: 'Bob Nickname', global_display_name: 'Global Bob' } },
    });

    // Space A's bookmark resolves TARGET's verified .q (global tier, no
    // nickname in space A).
    await waitFor(() => expect(screen.getByText('alice.q')).toBeTruthy());
    // Space B's bookmark resolves the PER-SPACE nickname instead — proving
    // this came from bookmarkSpaceB's OWN spaceId, not space A's.
    expect(screen.getByText('Bob Nickname')).toBeTruthy();
    expect(screen.queryByText('Stale A')).toBeNull();
    expect(screen.queryByText('Stale B')).toBeNull();
    expect(screen.queryByText('Global Bob')).toBeNull();
  });

  it('resolves a DM bookmark\'s source label from the CURRENT partner name, not the name frozen at bookmark time', async () => {
    mockGetConversationSync.mockImplementation((conversationId: string) =>
      conversationId === 'conv-1'
        ? {
            conversationId: 'conv-1',
            type: 'direct',
            timestamp: 0,
            address: TARGET,
            icon: '',
            displayName: 'Whatever the conversation title says',
          }
        : undefined,
    );

    const bookmark = baseBookmark({
      bookmarkId: 'bm-dm',
      sourceType: 'dm',
      conversationId: 'conv-1',
      cachedPreview: {
        senderAddress: TARGET,
        senderName: 'Stale Sender',
        textSnippet: 'hey',
        messageDate: 1_700_000_000_000,
        // Frozen at bookmark time — DMChatArea.tsx:498's
        // `conversationData?.displayName || 'DM'` defect.
        sourceName: 'Old DM Partner Name',
        contentType: 'text',
      },
    });

    renderPanel([bookmark]);

    // Both the sender line AND the source line resolve TARGET's current
    // identity — two separate renders of the same verified `.q`.
    await waitFor(() => expect(screen.getAllByText('alice.q')).toHaveLength(2));
    expect(screen.queryByText('Old DM Partner Name')).toBeNull();
    expect(screen.queryByText('Stale Sender')).toBeNull();
  });

  it('falls back to the frozen source string when the DM conversation no longer exists locally', async () => {
    mockGetConversationSync.mockReturnValue(undefined);

    const bookmark = baseBookmark({
      bookmarkId: 'bm-dm-gone',
      sourceType: 'dm',
      conversationId: 'conv-deleted',
      cachedPreview: {
        senderAddress: TARGET,
        senderName: 'Stale Sender',
        textSnippet: 'hey',
        messageDate: 1_700_000_000_000,
        sourceName: 'Frozen Fallback Name',
        contentType: 'text',
      },
    });

    renderPanel([bookmark]);

    await waitFor(() => expect(screen.getByText('alice.q')).toBeTruthy());
    // No address recoverable for the source (conversation gone) — the
    // stored string is still load-bearing here, exactly as the brief says.
    expect(screen.getByText('Frozen Fallback Name')).toBeTruthy();
  });
});

/**
 * The `enrich` section of this row's brief: MEASURE the request count.
 * `QmPeerA<n>...` addresses, the repo's placeholder family — synthetic
 * distinct bookmark senders, not derivable/real ones, since this test only
 * cares about how many `getPublicProfile` calls a long bookmark list
 * produces.
 */
function fakeAddress(i: number): string {
  return `QmPeerA${i.toString().padStart(3, '0')}${'x'.repeat(38)}`;
}

describe('BookmarksPanel — enrichment fan-out is bounded, not per-row', () => {
  it(`caps the fan-out at MAX_QNS_LOOKUPS (${MAX_QNS_LOOKUPS}) for a long bookmark list`, async () => {
    // 80 bookmarks, each a distinct sender — over the cap. Bookmarks are
    // capped at 200 (BOOKMARKS_CONFIG.MAX_BOOKMARKS), well above MAX_QNS_LOOKUPS.
    const bookmarks = Array.from({ length: 80 }, (_, i) =>
      baseBookmark({
        bookmarkId: `bm-${i}`,
        spaceId: SPACE_A,
        cachedPreview: {
          senderAddress: fakeAddress(i),
          senderName: `Stale ${i}`,
          textSnippet: 'x',
          messageDate: 1_700_000_000_000 + i,
          sourceName: '#general',
          contentType: 'text',
        },
      }),
    );

    renderPanel(bookmarks);

    await waitFor(() => expect(mockGetPublicProfile).toHaveBeenCalledTimes(MAX_QNS_LOOKUPS));
    await new Promise((r) => setTimeout(r, 10));
    expect(mockGetPublicProfile).toHaveBeenCalledTimes(MAX_QNS_LOOKUPS);
  });
});
