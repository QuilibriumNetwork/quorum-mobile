/**
 * A like re-renders the card it was made on, and nothing else.
 *
 * ## The regression this pins
 *
 * The feed passed the whole optimistic like/recast/follow maps to every row,
 * and the like map was the list's `extraData`. A like replaced the map, so every
 * visible row's memo failed and the feed root (subscribed to every store
 * change) re-rendered with all its pushed screens. Each card now reads its own
 * cast's entry from the store, and the feed root takes only the actions.
 *
 * ## What is asserted
 *
 * - Liking one of two cards commits the liked card and not its neighbour, and
 *   the liked card shows the new count.
 * - The per-key store hooks hand back the same value for untouched keys, and
 *   the pending list keeps its identity across a like.
 * - The actions hook does not re-render on store changes, and still sends a
 *   cast queued through it.
 */
import React, { Profiler } from 'react';
import { Image } from 'react-native';
import { act, cleanup, renderHook } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithProviders } from '@/jest/renderWithProviders';
import { FeedPostCard, createStyles } from '@/components/SocialFeedModal';
import { useFeedOptimisticActions } from '@/context/FeedOptimisticContext';
import * as store from '@/services/feed/optimisticFeedStore';
import type { FeedPost } from '@/components/SocialFeed/types';
import { DarkTheme } from '@/theme';

const mockSubmitCast = jest.fn(async (_input: { text: string }) => ({ hash: '0x' + 'c'.repeat(40) }));
jest.mock('@/hooks/useFarcasterSubmitCast', () => ({
  useFarcasterSubmitCast: () => ({ submitCast: mockSubmitCast }),
}));
jest.mock('@/services/farcaster/hypersnapWrites', () => ({
  removeOwnCast: jest.fn(),
  setCastReaction: jest.fn(),
  setFollowing: jest.fn(),
}));
jest.mock('@/context/ToastContext', () => ({ useToast: () => ({ showToast: jest.fn() }) }));
jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { farcaster: { fid: 42, username: 'me' }, displayName: 'Me' } }),
}));

// Module-load mocks: `SocialFeedModal.tsx` has no barrel, so importing any one
// piece pulls in its whole graph. Same set, for the same reasons, as
// `__tests__/feedThreadMediaWidth.test.tsx`.
jest.mock('@/components/SocialFeed/media/AutoHeightImage', () => ({ AutoHeightImage: () => null }));
jest.mock('@/hooks/chat/useConversations', () => ({ useConversations: () => ({ data: undefined }) }));
jest.mock('@/hooks/chat/useFarcasterDirectCasts', () => ({
  useFarcasterConversations: () => ({ data: undefined }),
  useSendFarcasterDirectCast: () => ({ mutateAsync: jest.fn() }),
}));
jest.mock('@/hooks/chat/useSendDirectMessage', () => ({ useSendDirectMessage: () => ({ mutateAsync: jest.fn() }) }));
jest.mock('@/hooks/chat/useSendSpaceMessage', () => ({ useSendSpaceMessage: () => ({ mutateAsync: jest.fn() }) }));
jest.mock('@/hooks/chat/useSpaces', () => ({ useSpaces: () => ({ data: [] }) }));
jest.mock('@/context/MiniappOverlayContext', () => ({ useMiniappOverlay: () => ({ openMiniapp: jest.fn() }) }));
jest.mock('@/modules/quorum-crypto/src', () => ({
  __esModule: true,
  default: {},
  generateX448: jest.fn(),
  generateEd448: jest.fn(),
  getPublicKeyX448: jest.fn(),
  getPublicKeyEd448: jest.fn(),
  signEd448: jest.fn(),
  verifyEd448: jest.fn(),
}));
jest.mock('@/components/Chat/InviteLinkCard', () => ({ InviteLinkCard: () => null, containsInviteLink: () => false }));
jest.mock('@/components/SocialFeed/content/AudioSpaceEmbed', () => ({ AudioSpaceEmbed: () => null }));
jest.mock('@/components/SocialFeed/content/LiveSpacesStrip', () => ({ LiveSpacesStrip: () => null }));
jest.mock('@/components/wallet/TipModal', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/SocialFeed/content/FarcasterTokenEmbed', () => ({ FarcasterTokenEmbed: () => null }));
jest.mock('@/components/SocialFeed/content/SnapEmbed', () => ({
  SnapEmbed: () => null,
  useSnapDetection: () => ({ isSnap: false }),
}));
jest.mock('@/components/SocialFeed/media/YouTubeEmbed', () => ({
  YouTubeEmbed: () => null,
  extractYouTubeMatchesFromText: () => [],
  parseYouTubeUrl: () => null,
}));
jest.mock('@/components/SocialFeed/media/VideoViewer', () => ({ VideoViewer: () => null }));
jest.mock('@/components/SocialFeed/media/ImageViewer', () => ({ ImageViewer: () => null }));
jest.mock('@/components/SocialFeed/views', () => ({ GovernanceView: () => null, ProposalDetailView: () => null }));
jest.mock('@/components/SocialFeed/views/ProposalVoteBlock', () => ({ ProposalVoteBlock: () => null }));
jest.mock('@/components/ComposeChannelPickerModal', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/SocialFeed/CastOverflowButton', () => ({ CastOverflowButton: () => null }));
jest.mock('expo-video', () => ({
  useVideoPlayer: () => ({ addListener: () => ({ remove: () => {} }), play: () => {}, pause: () => {} }),
  VideoView: () => null,
}));
jest.mock('expo-audio', () => ({ setAudioModeAsync: jest.fn(), AudioModule: {} }));
jest.mock('@/components/ReportModal', () => ({ __esModule: true, default: () => null }));
jest.mock('quorum-translation', () => ({
  __esModule: true,
  UNDETERMINED: 'und',
  isTranslationAvailable: jest.fn().mockResolvedValue(false),
  detectLanguage: jest.fn(),
  ensureModel: jest.fn(),
  translate: jest.fn(),
  default: {},
}));
jest.mock('react-native-webrtc', () => ({
  RTCView: () => null,
  RTCPeerConnection: jest.fn(),
  RTCSessionDescription: jest.fn(),
  RTCIceCandidate: jest.fn(),
  MediaStream: jest.fn(),
  MediaStreamTrack: jest.fn(),
  RTCRtpReceiver: jest.fn(),
  RTCRtpSender: jest.fn(),
  mediaDevices: { getUserMedia: jest.fn() },
  registerGlobals: jest.fn(),
}));

const HASH_A = '0x' + 'a'.repeat(40);
const HASH_B = '0x' + 'b'.repeat(40);

function makePost(hash: string, authorFid: number): FeedPost {
  return {
    id: hash,
    hash,
    username: `user${authorFid}`,
    authorFid,
    authorName: `User ${authorFid}`,
    authorHandle: `@user${authorFid}`,
    time: '1h',
    content: `cast ${hash.slice(2, 6)}`,
    stats: { likes: '1', replies: '0', shares: '0' },
    tags: [],
    mediaUrls: [],
    videos: [],
    urlPreviews: [],
    quoteCasts: [],
    frameEmbeds: [],
    filter: 'home' as FeedPost['filter'],
  };
}

let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  jest.spyOn(Image, 'getSize').mockImplementation(() => {});
  store.__resetOptimisticFeed();
  mockSubmitCast.mockClear();
});

afterEach(() => {
  cleanup();
  store.__resetOptimisticFeed();
  queryClient.clear();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('a like on a feed card', () => {
  it('re-renders that card and not its neighbour', () => {
    const noop = () => {};
    const styles = createStyles(DarkTheme, true, { top: 0, bottom: 0, left: 0, right: 0 });
    const shared = {
      theme: DarkTheme,
      styles,
      onNavigateToThread: noop,
      onNavigateToProfile: noop,
      onOpenChannel: noop,
      onMentionPress: noop,
      onLinkPress: noop,
      onImagePress: noop,
      onLikeToggle: noop,
      onOpenShareSheet: noop,
      onFollow: noop,
      onReport: noop,
      onDelete: noop,
    };
    const postA = makePost(HASH_A, 7);
    const postB = makePost(HASH_B, 8);
    const commits = { a: 0, b: 0 };

    const root = renderWithProviders(
      <QueryClientProvider client={queryClient}>
        <Profiler id="a" onRender={() => void commits.a++}>
          <FeedPostCard post={postA} {...shared} />
        </Profiler>
        <Profiler id="b" onRender={() => void commits.b++}>
          <FeedPostCard post={postB} {...shared} />
        </Profiler>
      </QueryClientProvider>,
    );
    const before = { ...commits };

    act(() => store.setLike(HASH_A, true, 5));

    expect(commits.a).toBeGreaterThan(before.a);
    expect(commits.b).toBe(before.b);
    expect(root.getByText('5')).toBeTruthy();
  });
});

describe('the store hooks', () => {
  it('leave an untouched cast, account and pending list alone', () => {
    store.setLike(HASH_B, true, 2);
    const { result } = renderHook(() => ({
      likeB: store.useLikeOverride(HASH_B),
      recastB: store.useRecastOverride(HASH_B),
      follow: store.useFollowOverride(8),
      pending: store.usePendingTopLevel(),
    }));
    const before = result.current;

    act(() => store.setLike(HASH_A, true, 5));

    expect(result.current.likeB).toBe(before.likeB);
    expect(result.current.recastB).toBe(before.recastB);
    expect(result.current.follow).toBe(before.follow);
    expect(result.current.pending).toBe(before.pending);
  });

  it('report a deleted cast', () => {
    const { result } = renderHook(() => store.useIsCastDeleted(HASH_A));
    expect(result.current).toBe(false);
    act(() => store.setDeleted(HASH_A.toUpperCase(), true));
    expect(result.current).toBe(true);
  });
});

describe('the actions hook', () => {
  it('does not re-render on store changes, and still sends a queued cast', async () => {
    jest.useFakeTimers();
    let renders = 0;
    const { result } = renderHook(
      () => {
        renders++;
        return useFeedOptimisticActions();
      },
      {
        wrapper: ({ children }: { children: React.ReactNode }) => (
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        ),
      },
    );
    const actions = result.current;
    const rendersBefore = renders;

    act(() => store.setLike(HASH_A, true, 5));
    expect(renders).toBe(rendersBefore);

    act(() => {
      result.current.postTop({ text: 'hello' });
    });
    expect(renders).toBe(rendersBefore);

    await act(async () => {
      jest.advanceTimersByTime(0);
    });
    expect(mockSubmitCast).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello' }));
    expect(store.pendingTopLevel()[0]?.status).toBe('confirming');
    expect(result.current).toBe(actions);
  });

  it('records a like in the viewer reaction set once it lands', async () => {
    const { result } = renderHook(() => useFeedOptimisticActions(), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });

    await act(async () => {
      await result.current.toggleLike(HASH_A, false, 1, 7);
    });

    expect(store.isViewerLiked(HASH_A)).toBe(true);
    expect(store.getLikes().get(HASH_A)).toEqual({ liked: true, count: 2 });
  });
});
