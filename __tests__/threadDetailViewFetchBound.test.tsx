/**
 * A busy Farcaster thread must not turn every distinct linked-Quorum author
 * into an unbounded `getPublicProfile` fan-out.
 *
 * ## The bug this pins
 *
 * `ThreadDetailView` renders its parent chain, main cast and every reply
 * inside a plain `ScrollView` (no windowing), and each cast mounts a
 * `QuorumIdentityBadge`. Before the fix, that badge passed `enrich`
 * unconditionally to `<MemberName>`, so a thread with N distinct
 * linked-Quorum authors issued N `getPublicProfile` calls with no ceiling —
 * thread size is controlled by whoever posted the cast, not by the viewer,
 * so a viral thread is the worst case.
 *
 * ## Why the cap here is keyed on fid, not address
 *
 * Every other capped surface (`ShareInviteSheet`, `BookmarksPanel`,
 * `MessagesList`) already has each row's Quorum ADDRESS before it decides
 * whether to enrich, so it can intersect against `qnsLookupAddresses`
 * directly. A cast's author only maps to a Quorum address asynchronously,
 * inside the badge's own `useQuorumIdentityForFid` lookup — the container
 * never sees the address ahead of time. Capping on the AUTHOR FID instead
 * (known synchronously from the cast itself) is at least as tight: each fid
 * resolves to at most one address, so bounding to `MAX_QNS_LOOKUPS` distinct
 * fids can never let more than `MAX_QNS_LOOKUPS` distinct addresses reach an
 * enrich fetch.
 *
 * ## What is mocked, and why
 *
 * `@/hooks/useFarcasterThread` — replaced with a fixture of 61 distinct
 * authors (1 main cast + 60 replies) so the fan-out has something to
 * measure; the real hook's HTTP/hypersnap plumbing is irrelevant to this
 * property. `@/hooks/useQuorumIdentityForFid` — every fixture author is
 * "linked" to its own distinct address, so every mounted badge is eligible
 * to enrich absent a cap. `@/hooks/useBlockedFids` / `useMutedFids` — both
 * reach `@/context/AuthContext`, which reaches `requireNativeModule` at
 * import time (the STANDING LIMITATION every render test in this migration
 * works around); mocked to an empty, loaded set so no reply collapses behind
 * the blocked/muted placeholder. Reply text is kept under the translation
 * hook's 8-character length gate so `useTranslatable` never fires its
 * detection effect — irrelevant async work this test has no reason to wait
 * on. `IdentityScopeProvider` is real: the whole point is measuring what it
 * actually dispatches through `getPublicProfile`.
 */
import React from 'react';
import { screen, waitFor, cleanup, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { renderWithProviders } from '@/jest/renderWithProviders';
import { IdentityScopeProvider } from '@/identity/identityProvider';
import { MAX_QNS_LOOKUPS } from '@/hooks/chat/useConversationsWithQnsNames';
import { DarkTheme } from '@/theme';
import type { FlattenedCast } from '@/hooks/useFarcasterThread';

// See MessagesList.test.tsx for why this is required: notifyManager defers
// subscriber notifications through a real setTimeout(0), which lands
// IdentityScopeProvider's useQueries-driven re-render outside whatever act()
// scope wrapped the render call otherwise.
notifyManager.setNotifyFunction((callback) => {
  act(callback);
});

const MAIN_HASH = '0xmaincast00000000000000000000000000000000';
const REPLY_COUNT = 60;
const MAIN_FID = 1000;

function makeAuthor(fid: number) {
  return { fid, displayName: `Farcaster User ${fid}`, username: `fcuser${fid}` };
}

// `mock`-prefixed so the jest.mock factory below (hoisted above these
// declarations) may close over them, same convention as
// shareInviteSheetFetchBound.test.tsx.
const mockMainCast: FlattenedCast = {
  hash: MAIN_HASH,
  threadHash: MAIN_HASH,
  author: makeAuthor(MAIN_FID),
  text: 'hi',
  timestamp: 1_700_000_000_000,
  depth: 0,
};

// Distinct fids 2000..2059 — one Quorum-linked author per reply, none
// repeated, so nothing dedupes the fan-out for free.
const mockReplies: FlattenedCast[] = Array.from({ length: REPLY_COUNT }, (_, i) => {
  const fid = 2000 + i;
  return {
    hash: `0xreply${String(i).padStart(3, '0')}`,
    threadHash: MAIN_HASH,
    author: makeAuthor(fid),
    text: 'hi',
    timestamp: 1_700_000_000_000 + i,
    parentHash: MAIN_HASH,
    depth: 0,
  };
});

jest.mock('@/hooks/useFarcasterThread', () => ({
  useFarcasterThread: () => ({
    parentCasts: [],
    mainCast: mockMainCast,
    replies: mockReplies,
    isLoading: false,
    error: null,
    channelContext: undefined,
  }),
  parseFarcasterUrl: jest.fn(),
}));

// Every fixture fid is "linked" to its own distinct address — no claim, so
// no `.q` verification path runs. This test is about COUNT, not content.
jest.mock('@/hooks/useQuorumIdentityForFid', () => ({
  useQuorumIdentityForFid: (fid: number | undefined) => ({
    data: fid
      ? {
          address: `QmThreadFanoutTest${String(fid).padStart(4, '0')}${'A'.repeat(20)}`,
          displayName: `Linked ${fid}`,
        }
      : null,
  }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@/hooks/useBlockedFids', () => ({
  useBlockedFids: () => ({ fids: new Set<number>(), isLoaded: true }),
}));
jest.mock('@/hooks/useMutedFids', () => ({
  useMutedFids: () => ({ fids: new Set<number>(), isLoaded: true }),
}));

// `expo-video` reaches its native module at IMPORT time
// (`NativeVideoModule.VideoPlayer.prototype`), so merely importing
// `ThreadDetailView` — which pulls in `media/VideoPlayer.tsx` unconditionally
// through the barrel, whether or not any fixture cast has a video — throws
// under jest with no binary present. No fixture cast here has a video, so
// these stubs are never actually invoked; they only need to exist so the
// import graph resolves.
jest.mock('expo-video', () => ({
  useVideoPlayer: () => ({}),
  VideoView: () => null,
}));

// Same import-time native-module problem as `expo-video` above, reached
// through the same unconditional `media/VideoPlayer.tsx` import.
jest.mock('expo-audio', () => ({
  setAudioModeAsync: jest.fn(),
}));

// `media/YouTubeEmbed.tsx` imports `react-native-youtube-iframe`, which pulls
// in `react-native-webview`'s TurboModule at IMPORT time — no fixture cast
// here has a YouTube link, but the barrel import happens regardless.
jest.mock('react-native-youtube-iframe', () => ({
  __esModule: true,
  default: () => null,
}));

// `CastText` (rendered unconditionally for every cast with text) uses
// `useTranslatable`, which imports this on-device native module. It ships raw
// TypeScript source in node_modules with no babel transform configured for
// it, so requiring it under jest fails to parse before any mock on the
// exported functions would even apply. Every fixture cast's text is kept
// under the hook's 8-character length gate, so none of these are ever
// actually called — this only needs to exist so the import resolves.
jest.mock('quorum-translation', () => ({
  detectLanguage: jest.fn(),
  ensureModel: jest.fn(),
  translate: jest.fn(),
  UNDETERMINED: 'und',
}));

let mockGetPublicProfile: jest.Mock;
let mockResolveClaimedNames: jest.Mock;

jest.mock('@/services/api/quorumClient', () => ({
  getQuorumClient: () => ({
    getPublicProfile: (address: string) => mockGetPublicProfile(address),
  }),
}));

// No fixture profile ever carries a `primary_username`, so `claimedNamesIn`
// is always empty and `resolveBatch` is never called with anything — mocked
// only so importing the real identityProvider module graph resolves, same
// convention as shareInviteSheetFetchBound.test.tsx.
jest.mock('@/services/api/qnsClient', () => ({
  resolveClaimedNames: (names: string[]) => mockResolveClaimedNames(names),
}));

import { ThreadDetailView } from '@/components/SocialFeed/views/ThreadDetailView';

let queryClient: QueryClient;

describe('ThreadDetailView — bounded fetch fan-out', () => {
  beforeEach(() => {
    mockGetPublicProfile = jest.fn().mockResolvedValue(null);
    mockResolveClaimedNames = jest.fn().mockResolvedValue({});
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
  });

  it(`issues at most ${MAX_QNS_LOOKUPS} profile requests for ${REPLY_COUNT + 1} distinct linked authors`, async () => {
    renderWithProviders(
      <QueryClientProvider client={queryClient}>
        <IdentityScopeProvider rostersBySpace={{}} selfAddress={null}>
          <ThreadDetailView
            username="somebody"
            castHashPrefix="0xmaincast"
            theme={DarkTheme}
            onClose={() => {}}
            onOpenMiniApp={() => {}}
            onOpenProfile={() => {}}
            onOpenChannel={() => {}}
            likeStates={new Map()}
            onLikeToggle={() => {}}
            followStates={new Map()}
            onFollow={() => {}}
          />
        </IdentityScopeProvider>
      </QueryClientProvider>,
    );

    // Every cast renders regardless of the cap (the ScrollView is not
    // windowed) — confirms the full 61-author thread genuinely mounted
    // rather than the screen rendering an empty/loading state and vacuously
    // issuing zero requests.
    await waitFor(() => expect(screen.getAllByText('hi')).toHaveLength(REPLY_COUNT + 1));

    await waitFor(() => expect(mockGetPublicProfile).toHaveBeenCalledTimes(MAX_QNS_LOOKUPS));
  });
});
