/**
 * Feed videos create a native player only when one is needed.
 *
 * ## The regression this pins
 *
 * Every video row called `useVideoPlayer` as it mounted, and a row without a
 * poster (every video from Hypersnap) also mounted a `VideoView` to show the
 * first frame: a native player, a decoder and a stream download per video row,
 * including rows scrolled straight past.
 *
 * ## What is asserted
 *
 * - A row mounts as a poster, with no player.
 * - Once rows have stayed on screen briefly, at most two get a first-frame
 *   preview; the next takes over when one of them goes.
 * - Tapping play on any row creates its player and starts it.
 * - A preview player holds a couple of seconds of video, not the ~50 s
 *   ExoPlayer buffers by default while paused, until play is pressed.
 * - A playing video pauses when a screen is pushed over it.
 */
import React from 'react';
import { act, cleanup, fireEvent } from '@testing-library/react-native';
import { renderWithProviders } from '@/jest/renderWithProviders';
import { VideoPlayer } from '@/components/SocialFeedModal';
import { MAX_PREVIEW_PLAYERS, PREVIEW_SETTLE_MS, __resetVideoPreviewSlots } from '@/components/SocialFeed/media/videoPreviewSlots';
import { MediaOnTopContext } from '@/components/SocialFeed/media/videoPlayback';
import type { BufferOptions } from 'expo-video';
import { DarkTheme } from '@/theme';

type MockPlayer = { play: jest.Mock; pause: jest.Mock; bufferOptions?: BufferOptions };
const mockPlayersByUrl = new Map<string, MockPlayer>();
jest.mock('expo-video', () => ({
  // Like the real hook, the setup callback runs once, when the player is made.
  useVideoPlayer: (url: string, setup?: (player: unknown) => void) => {
    let player = mockPlayersByUrl.get(url);
    if (!player) {
      player = { play: jest.fn(), pause: jest.fn(), addListener: () => ({ remove: () => {} }) } as never;
      mockPlayersByUrl.set(url, player!);
      setup?.(player);
    }
    return player;
  },
  VideoView: () => null,
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
  useSnapDetection: () => false,
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

const urls = ['a', 'b', 'c'].map((id) => `https://example.invalid/${id}.mp4`);

let setShown: (urls: string[]) => void = () => {};

function Rows() {
  const [shown, setState] = React.useState(urls);
  setShown = setState;
  return (
    <>
      {shown.map((url) => (
        <VideoPlayer key={url} url={url} width={1280} height={720} theme={DarkTheme} />
      ))}
    </>
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  mockPlayersByUrl.clear();
  __resetVideoPreviewSlots();
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

it('mounts posters, then previews at most two rows, passing a slot on when a row goes', () => {
  renderWithProviders(<Rows />);
  expect(mockPlayersByUrl.size).toBe(0);

  act(() => jest.advanceTimersByTime(PREVIEW_SETTLE_MS));
  expect([...mockPlayersByUrl.keys()]).toEqual(urls.slice(0, MAX_PREVIEW_PLAYERS));

  act(() => setShown(urls.slice(1)));
  expect(mockPlayersByUrl.has(urls[2])).toBe(true);
  expect(mockPlayersByUrl.get(urls[2])!.play).not.toHaveBeenCalled();
});

it('creates and starts a player when play is tapped, slot or not', () => {
  const root = renderWithProviders(<Rows />);
  act(() => jest.advanceTimersByTime(PREVIEW_SETTLE_MS));
  expect(mockPlayersByUrl.has(urls[2])).toBe(false);

  // The third row is still a poster; the first two show previews.
  fireEvent.press(root.getAllByLabelText('Play video')[2]);
  expect(mockPlayersByUrl.get(urls[2])!.play).toHaveBeenCalled();
});

it('buffers a preview for a couple of seconds, and fully once play is pressed', () => {
  const root = renderWithProviders(<Rows />);
  act(() => jest.advanceTimersByTime(PREVIEW_SETTLE_MS));

  const preview = mockPlayersByUrl.get(urls[0])!;
  expect(preview.bufferOptions?.preferredForwardBufferDuration).toBeLessThanOrEqual(2);
  expect(preview.play).not.toHaveBeenCalled();

  fireEvent.press(root.getAllByLabelText('Play video')[0]);
  expect(preview.play).toHaveBeenCalled();
  // Back to expo-video's defaults: no forward-buffer cap.
  expect(preview.bufferOptions?.preferredForwardBufferDuration).toBeUndefined();
});

it('pauses a playing video when a screen is pushed over it', () => {
  let setOnTop: (onTop: boolean) => void = () => {};
  function Screen() {
    const [onTop, setState] = React.useState(true);
    setOnTop = setState;
    return (
      <MediaOnTopContext.Provider value={onTop}>
        <VideoPlayer url={urls[0]} thumbnailUrl="https://example.invalid/poster.jpg" theme={DarkTheme} />
      </MediaOnTopContext.Provider>
    );
  }
  const root = renderWithProviders(<Screen />);
  fireEvent.press(root.getByLabelText('Play video'));
  const player = mockPlayersByUrl.get(urls[0])!;
  expect(player.play).toHaveBeenCalled();
  expect(player.pause).not.toHaveBeenCalled();

  act(() => setOnTop(false));
  expect(player.pause).toHaveBeenCalled();
});
