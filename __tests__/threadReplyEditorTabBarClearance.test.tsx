/**
 * The thread reply editor must clear the tab bar whenever no keyboard covers it.
 *
 * ## The regression this pins
 *
 * The feed's `ThreadDetailView` (in `SocialFeedModal.tsx`) pads the end of its
 * scroll content by `bottomInset` so the inline reply editor can scroll clear
 * of the floating tab bar. While the keyboard is up it covers the tab bar, so
 * that clearance is dropped to a small gap. It used to be dropped whenever the
 * editor was merely *focused*. A focused editor with no keyboard showing — a
 * hardware keyboard, or Android's back button, which hides the keyboard but
 * leaves the input focused — then left the editor's bottom under the tab bar
 * with no way to scroll it into view.
 *
 * ## What is asserted
 *
 * With the editor focused, the clearance is kept while the keyboard is hidden
 * and dropped only while it is visible.
 */
import React from 'react';
import { ScrollView, StyleSheet, TextInput } from 'react-native';
import { act, cleanup, fireEvent } from '@testing-library/react-native';
import * as optimisticStore from '@/services/feed/optimisticFeedStore';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as KeyboardController from 'react-native-keyboard-controller';
import { renderWithProviders } from '@/jest/renderWithProviders';
import { ThreadDetailView } from '@/components/SocialFeedModal';
import { DarkTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';
import type { FlattenedCast } from '@/hooks/useFarcasterThread';

const MAIN_HASH = '0x' + 'c'.repeat(40);
const BOTTOM_INSET = 100;

const mockMainCast: FlattenedCast = {
  hash: MAIN_HASH,
  threadHash: MAIN_HASH,
  author: { fid: 7, displayName: 'Alice', username: 'alice' },
  text: 'hi',
  timestamp: 1_700_000_000_000,
  depth: 0,
};

// The screen under test: a loaded thread, viewed by a signed-in account.
// The thread view calls this on every render, so its call count is the
// thread's render count.
const mockThreadRenders = { count: 0 };
jest.mock('@/hooks/useFarcasterThread', () => ({
  useFarcasterThread: () => (mockThreadRenders.count++, {
    parentCasts: [],
    mainCast: mockMainCast,
    replies: [],
    allCasts: [mockMainCast],
    isLoading: false,
    error: null,
    channelContext: undefined,
    refetch: jest.fn(),
  }),
  parseFarcasterUrl: jest.fn(),
}));
jest.mock('@/context/FeedOptimisticContext', () => ({
  useFeedOptimisticActions: () => ({
    pendingRepliesAsThreadCasts: () => [],
    reconcilePending: jest.fn(),
    reconcilePendingByHash: jest.fn(),
    reconcileReactions: jest.fn(),
    postReply: jest.fn(),
    deleteCast: jest.fn(),
    discardPending: jest.fn(),
    retryPending: jest.fn(),
  }),
}));
jest.mock('@/hooks/useApex', () => ({ useApexStatusForFids: () => new Set<number>() }));
jest.mock('@/hooks/useFarcasterUserPersistent', () => ({ useFarcasterUserPersistent: () => ({ data: undefined }) }));
jest.mock('@/hooks/useBlockedFids', () => ({ useBlockedFids: () => ({ fids: new Set<number>(), isLoaded: true }) }));
jest.mock('@/hooks/useMutedFids', () => ({ useMutedFids: () => ({ fids: new Set<number>(), isLoaded: true }) }));
jest.mock('@/hooks/useQuorumIdentityForFid', () => ({ useQuorumIdentityForFid: () => ({ data: null }) }));
// The screen's modals read safe-area insets; there is no provider in a test.
jest.mock(
  'react-native-safe-area-context',
  () => jest.requireActual('react-native-safe-area-context/jest/mock').default,
);

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
jest.mock('expo-video', () => ({ useVideoPlayer: () => ({}), VideoView: () => null }));
jest.mock('expo-audio', () => ({ setAudioModeAsync: jest.fn(), AudioModule: {} }));
// Named, not default: the thread screen renders it (`{ ReportModal }`).
jest.mock('@/components/ReportModal', () => ({ __esModule: true, ReportModal: () => null, default: () => null }));
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

let queryClient: QueryClient;

function setKeyboardVisible(isVisible: boolean) {
  (KeyboardController.useKeyboardState as jest.Mock).mockImplementation(
    (selector?: (s: { isVisible: boolean }) => unknown) =>
      selector ? selector({ isVisible }) : { isVisible },
  );
}

function renderThread() {
  const noop = () => {};
  return renderWithProviders(
    <QueryClientProvider client={queryClient}>
      <ThreadDetailView
        username="alice"
        castHashPrefix={MAIN_HASH}
        theme={DarkTheme}
        onClose={noop}
        onOpenMiniApp={noop}
        onOpenProfile={noop}
        onOpenChannel={noop}
        onOpenThread={noop}
        onLikeToggle={noop}
        onRecastToggle={noop}
        onQuoteCast={noop}
        onShareToChat={noop}
        onFollow={noop}
        bottomInset={BOTTOM_INSET}
        currentUserFid={42}
      />
    </QueryClientProvider>,
  );
}

/** paddingBottom of the thread's scroll content — the KeyboardAwareScrollView,
 *  which the library's jest mock renders as a plain ScrollView. */
function scrollPaddingBottom(root: ReturnType<typeof renderThread>): number | undefined {
  const scroll = root
    .UNSAFE_getAllByType(ScrollView)
    .find((s) => s.props.keyboardDismissMode === 'interactive');
  return (StyleSheet.flatten(scroll?.props.contentContainerStyle) as { paddingBottom?: number })
    ?.paddingBottom;
}

function focusEditor(root: ReturnType<typeof renderThread>) {
  const editor = root
    .UNSAFE_getAllByType(TextInput)
    .find((i) => String(i.props.placeholder ?? '').startsWith('Reply to @'));
  if (!editor) throw new Error('reply editor not rendered');
  fireEvent(editor, 'focus');
}

beforeEach(() => {
  jest.useFakeTimers();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  optimisticStore.__resetOptimisticFeed();
  cleanup();
  queryClient.clear();
  jest.useRealTimers();
});

describe('thread reply editor tab-bar clearance', () => {
  it('keeps the clearance when the editor is focused but no keyboard is showing', () => {
    setKeyboardVisible(false);
    const root = renderThread();
    focusEditor(root);

    expect(scrollPaddingBottom(root)).toBe(Skin.space(16) + BOTTOM_INSET);
  });

  it('drops the clearance while the keyboard covers the tab bar', () => {
    setKeyboardVisible(true);
    const root = renderThread();
    focusEditor(root);

    expect(scrollPaddingBottom(root)).toBe(Skin.space(16));
  });

  it('keeps the clearance at rest', () => {
    setKeyboardVisible(false);
    const root = renderThread();

    expect(scrollPaddingBottom(root)).toBe(Skin.space(16) + BOTTOM_INSET);
  });
});

describe('thread reply editor', () => {
  it('re-renders itself, not the thread, as the user types', () => {
    setKeyboardVisible(false);
    const root = renderThread();
    const editor = root
      .UNSAFE_getAllByType(TextInput)
      .find((i) => String(i.props.placeholder ?? '').startsWith('Reply to @'))!;
    const before = mockThreadRenders.count;

    for (const text of ['h', 'he', 'hel', 'hell', 'hello']) {
      fireEvent.changeText(editor, text);
    }

    expect(mockThreadRenders.count).toBe(before);
    expect(editor.props.value).toBe('hello');
  });
});

describe('thread optimistic state', () => {
  it('re-renders the liked cast’s stats row, not the thread', () => {
    setKeyboardVisible(false);
    const root = renderThread();
    const before = mockThreadRenders.count;

    act(() => optimisticStore.setLike(MAIN_HASH, true, 41));

    expect(mockThreadRenders.count).toBe(before);
    expect(root.getByText('41')).toBeTruthy();
  });

  it('re-renders the thread when a reply is pending, to merge it in', () => {
    setKeyboardVisible(false);
    renderThread();
    const before = mockThreadRenders.count;

    act(() =>
      optimisticStore.addPending({
        localId: 'pending-1',
        kind: 'reply',
        threadHash: MAIN_HASH,
        parentHash: MAIN_HASH,
        text: 'a reply',
        embedUrls: [],
        author: { fid: 42, displayName: 'Me', username: 'me' },
        timestamp: Date.now(),
        status: 'pending',
        attempts: 0,
      }),
    );

    expect(mockThreadRenders.count).toBeGreaterThan(before);
  });
});
