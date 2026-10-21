/**
 * Media in a threaded feed reply must fit beside the avatar gutter.
 *
 * ## The regression this pins
 *
 * A standalone feed card bleeds its media edge to edge: the media container
 * cancels the card's side padding with a negative margin and the media is
 * sized to SCREEN_WIDTH, which then fits exactly. A card inside a thread unit
 * (`threadPosition` set) drops that negative margin, because its body sits
 * beside the 44px avatar gutter and edge-to-edge media would cross the
 * connector line. The media kept SCREEN_WIDTH though, so every image, carousel,
 * video and frame in a threaded reply ran off the right edge of the screen by
 * the card padding plus the gutter.
 *
 * ## What is asserted
 *
 * In a thread unit, each media kind is sized to the body column: the screen
 * minus the card's side padding, the gutter and the gap beside it. A
 * standalone card still bleeds at SCREEN_WIDTH.
 */
import React from 'react';
import { Dimensions, Image, StyleSheet } from 'react-native';
import { cleanup } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Image as ExpoImage } from 'expo-image';
import { renderWithProviders } from '@/jest/renderWithProviders';
import { FeedPostCard, createStyles } from '@/components/SocialFeedModal';
import type { FeedPost } from '@/components/SocialFeed/types';
import { DarkTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';

// The single-image and carousel paths both render AutoHeightImage; record the
// width each was asked to fit.
const mockAutoHeightWidths: number[] = [];
jest.mock('@/components/SocialFeed/media/AutoHeightImage', () => ({
  AutoHeightImage: ({ maxWidth }: { maxWidth: number }) => {
    mockAutoHeightWidths.push(maxWidth);
    return null;
  },
}));

// Module-load mocks: `SocialFeedModal.tsx` has no barrel, so importing any one
// piece pulls in its whole graph. Same set, for the same reasons, as
// `__tests__/migrated/ShareToChatModal.test.tsx`, which documents each.
jest.mock('@/hooks/chat/useConversations', () => ({ useConversations: () => ({ data: undefined }) }));
jest.mock('@/hooks/chat/useFarcasterDirectCasts', () => ({
  useFarcasterConversations: () => ({ data: undefined }),
  useSendFarcasterDirectCast: () => ({ mutateAsync: jest.fn() }),
}));
jest.mock('@/hooks/chat/useSendDirectMessage', () => ({ useSendDirectMessage: () => ({ mutateAsync: jest.fn() }) }));
jest.mock('@/hooks/chat/useSendSpaceMessage', () => ({ useSendSpaceMessage: () => ({ mutateAsync: jest.fn() }) }));
jest.mock('@/hooks/chat/useSpaces', () => ({ useSpaces: () => ({ data: [] }) }));
jest.mock('@/context/MiniappOverlayContext', () => ({ useMiniappOverlay: () => ({ openMiniapp: jest.fn() }) }));
jest.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
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
// The feed's VideoPlayer subscribes to player events on mount.
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

const SCREEN_WIDTH = Dimensions.get('window').width;
// Card padding on both sides, the avatar gutter, and the gap beside it.
const THREAD_BODY_WIDTH = SCREEN_WIDTH - 2 * Skin.contentRowPaddingH() - 44 - Skin.space(12);

const VIDEO_THUMB = 'https://example.invalid/video-thumb.jpg';
const FRAME_IMAGE = 'https://example.invalid/frame.png';

function makePost(overrides: Partial<FeedPost>): FeedPost {
  return {
    id: '0xreply',
    hash: '0xreply000000000000000000000000000000000000',
    username: 'charlie',
    authorFid: 3,
    authorName: 'Charlie',
    authorHandle: '@charlie',
    time: '1h',
    content: '',
    stats: { likes: '0', replies: '0', shares: '0' },
    tags: [],
    mediaUrls: [],
    videos: [],
    urlPreviews: [],
    quoteCasts: [],
    frameEmbeds: [],
    filter: 'home' as FeedPost['filter'],
    ...overrides,
  };
}

let queryClient: QueryClient;

function renderCard(post: FeedPost, threadPosition?: 'first' | 'middle' | 'last') {
  const noop = () => {};
  return renderWithProviders(
    <QueryClientProvider client={queryClient}>
      <FeedPostCard
        post={post}
        theme={DarkTheme}
        styles={createStyles(DarkTheme, true, { top: 0, bottom: 0, left: 0, right: 0 })}
        onNavigateToThread={noop}
        onNavigateToProfile={noop}
        onOpenChannel={noop}
        onMentionPress={noop}
        onLinkPress={noop}
        onImagePress={noop}
        onLikeToggle={noop}
        onOpenShareSheet={noop}
        onFollow={noop}
        onReport={noop}
        onDelete={noop}
        suppressParentContext
        threadPosition={threadPosition}
      />
    </QueryClientProvider>,
  );
}

function imageWidth(root: ReturnType<typeof renderCard>, uri: string): number | undefined {
  // Frame images are React Native images; video posters are expo-image.
  const images = [...root.UNSAFE_getAllByType(Image), ...root.UNSAFE_getAllByType(ExpoImage)];
  const image = images.find((i) => i.props.source?.uri === uri);
  return image ? (StyleSheet.flatten(image.props.style) as { width?: number }).width : undefined;
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockAutoHeightWidths.length = 0;
  // The video poster measures its image to refine the aspect ratio; jest-expo's
  // stub can't, and the width under test doesn't depend on it.
  jest.spyOn(Image, 'getSize').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  jest.restoreAllMocks();
});

describe('feed card media width', () => {
  it('fits a single image to the thread body column', () => {
    renderCard(makePost({ mediaUrls: ['https://example.invalid/a.jpg'] }), 'last');
    expect(mockAutoHeightWidths).toEqual([THREAD_BODY_WIDTH]);
    expect(THREAD_BODY_WIDTH).toBeLessThan(SCREEN_WIDTH);
  });

  it('fits every carousel page to the thread body column', () => {
    renderCard(
      makePost({ mediaUrls: ['https://example.invalid/a.jpg', 'https://example.invalid/b.jpg'] }),
      'middle',
    );
    expect(mockAutoHeightWidths).toEqual([THREAD_BODY_WIDTH, THREAD_BODY_WIDTH]);
  });

  it('loads only the first two pages of a longer carousel until it is swiped', () => {
    renderCard(
      makePost({ mediaUrls: ['a', 'b', 'c', 'd'].map((n) => `https://example.invalid/${n}.jpg`) }),
      'middle',
    );
    expect(mockAutoHeightWidths).toHaveLength(2);
  });

  it('fits a video and a frame embed to the thread body column', () => {
    const root = renderCard(
      makePost({
        videos: [{ url: 'https://example.invalid/v.m3u8', thumbnailUrl: VIDEO_THUMB, width: 1280, height: 720 }],
        frameEmbeds: [{ imageUrl: FRAME_IMAGE, buttonTitle: 'Open', actionUrl: 'https://example.invalid' }],
      } as Partial<FeedPost>),
      'first',
    );
    expect(imageWidth(root, VIDEO_THUMB)).toBe(THREAD_BODY_WIDTH);
    expect(imageWidth(root, FRAME_IMAGE)).toBe(THREAD_BODY_WIDTH);
  });

  it('still bleeds edge to edge on a standalone card', () => {
    const root = renderCard(
      makePost({
        mediaUrls: ['https://example.invalid/a.jpg'],
        videos: [{ url: 'https://example.invalid/v.m3u8', thumbnailUrl: VIDEO_THUMB, width: 1280, height: 720 }],
        frameEmbeds: [{ imageUrl: FRAME_IMAGE, buttonTitle: 'Open', actionUrl: 'https://example.invalid' }],
      } as Partial<FeedPost>),
    );
    expect(mockAutoHeightWidths).toEqual([SCREEN_WIDTH]);
    expect(imageWidth(root, VIDEO_THUMB)).toBe(SCREEN_WIDTH);
    expect(imageWidth(root, FRAME_IMAGE)).toBe(SCREEN_WIDTH);
  });
});
