/**
 * Feed pictures are requested at the size they're shown, through expo-image.
 *
 * ## The regression this pins
 *
 * Link previews, quote-cast and parent-cast previews, frame images, the media
 * grid's tiles and the share sheet's avatars were React Native `Image`s (or
 * expo-image) loading Cloudflare Images' `original` variant: the full upload,
 * memory-cached only, so it was downloaded again after a relaunch. A parent
 * cast's preview also fetched the original while the feed showed the same
 * photo at a sized URL: two downloads of one picture.
 *
 * ## What is asserted
 *
 * - Each of those asks for a copy sized to its box, not the original.
 * - A parent-cast preview asks for the same URL the feed shows that photo at.
 */
import React from 'react';
import { PixelRatio, StyleSheet } from 'react-native';
import { cleanup } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Image as ExpoImage } from 'expo-image';
import { renderWithProviders } from '@/jest/renderWithProviders';
import { FeedPostCard, MediaGridCell, createStyles } from '@/components/SocialFeedModal';
import type { FeedPost } from '@/components/SocialFeed/types';
import { SCREEN_WIDTH } from '@/components/SocialFeed/utils';
import { sizedImageUrl } from '@/utils/imageVariants';
import { DarkTheme } from '@/theme';

// The parent-cast preview looks the parent's author up; nothing here needs it.
jest.mock('@/hooks/useFarcasterUserPersistent', () => ({
  useFarcasterUserPersistent: () => ({ data: undefined }),
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


const photo = (id: string) => `https://imagedelivery.net/acct/${id}/original`;

function makePost(overrides: Partial<FeedPost>): FeedPost {
  return {
    id: '0xcast',
    hash: '0xcast00000000000000000000000000000000000000',
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
const noop = () => {};

function renderCards(posts: FeedPost[], showParent = false) {
  return renderWithProviders(
    <QueryClientProvider client={queryClient}>
      {posts.map((post) => (
        <FeedPostCard
          key={post.id}
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
          suppressParentContext={!showParent}
        />
      ))}
    </QueryClientProvider>,
  );
}

/** The URIs every expo-image in the tree asked for. */
function imageUris(root: ReturnType<typeof renderWithProviders>): string[] {
  return root.UNSAFE_queryAllByType(ExpoImage).map((i) => i.props.source?.uri);
}

beforeEach(() => {
  // A 3x phone; requests are capped at 2x.
  jest.spyOn(PixelRatio, 'get').mockReturnValue(3);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  jest.restoreAllMocks();
});

it('sizes frame images, link previews and quote-cast images to their boxes', () => {
  const root = renderCards([
    makePost({
      frameEmbeds: [{ imageUrl: photo('frame'), buttonTitle: 'Open', actionUrl: 'https://example.invalid' }],
      urlPreviews: [
        { url: 'https://example.invalid/big', title: 'Big', image: photo('big'), useLargeImage: true },
        { url: 'https://example.invalid/small', title: 'Small', image: photo('small') },
      ],
      quoteCasts: [
        {
          username: 'dana',
          hashPrefix: '0xquoted',
          cast: {
            hash: '0xquoted',
            author: { fid: 4, username: 'dana', displayName: 'Dana' },
            text: 'quoted',
            embeds: { images: [{ url: photo('quoted') }] },
          },
        },
      ],
    } as Partial<FeedPost>),
  ]);
  const uris = imageUris(root);
  expect(uris).toEqual(
    expect.arrayContaining([
      sizedImageUrl(photo('frame'), SCREEN_WIDTH),
      sizedImageUrl(photo('big'), SCREEN_WIDTH),
      sizedImageUrl(photo('small'), 100),
      sizedImageUrl(photo('quoted'), SCREEN_WIDTH),
    ]),
  );
  expect(uris.filter((u) => u?.endsWith('/original'))).toEqual([]);
});

it('asks for a parent preview at the URL the feed shows that photo at', () => {
  const parentHash = '0xparent0000000000000000000000000000000000';
  queryClient.setQueryData(['farcaster', 'cast', { hash: parentHash, fid: 7 }], {
    hash: parentHash,
    timestamp: Date.now(),
    text: 'the parent',
    author: { fid: 7, username: 'erin', displayName: 'Erin' },
    embeds: [{ image: { url: photo('shared') } }],
    mentions: [],
    mentionsPositions: [],
    reactions: { likesCount: 0, recastsCount: 0, repliesCount: 0 },
    source: 'hypersnap',
  });
  const root = renderCards(
    [
      makePost({ id: 'parent', hash: parentHash, mediaUrls: [photo('shared')] }),
      makePost({ id: 'reply', parentHash, parentAuthorFid: 7 }),
    ],
    true,
  );
  const shared = imageUris(root).filter((u) => u?.includes('/shared/'));
  // The parent's own image and the reply's preview of it: one URL, sized.
  expect(shared).toHaveLength(2);
  expect(new Set(shared)).toEqual(new Set([sizedImageUrl(photo('shared'), SCREEN_WIDTH)]));
});

it('asks for a media-grid tile at the tile’s size', () => {
  const root = renderWithProviders(
    <MediaGridCell post={makePost({ mediaUrls: [photo('tile')] })} theme={DarkTheme} onPress={noop} />,
  );
  const tile = root.UNSAFE_getByType(ExpoImage);
  const { width } = StyleSheet.flatten(tile.props.style) as { width: number };
  expect(width).toBeLessThan(SCREEN_WIDTH / 2);
  expect(tile.props.source.uri).toBe(sizedImageUrl(photo('tile'), width));
  expect(tile.props.source.uri).not.toBe(photo('tile'));
});
