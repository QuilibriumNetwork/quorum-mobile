/**
 * `ShareToChatModal` (the "Share to chat" DM/space picker inside
 * `SocialFeedModal.tsx`) mixes two identity namespaces in one list: real
 * Quorum conversations and Farcaster direct-cast conversations. The Quorum
 * row's `conv.displayName` used to be read raw; the Farcaster row's own
 * name fields are a different namespace entirely (no address, no roster, no
 * `.q`) and must stay exactly as they are.
 *
 * ## How the two rows are told apart
 *
 * `allDMs` merges `useConversations` (genuine Quorum DMs, real addresses)
 * with `useFarcasterConversations` (Farcaster DMs, `fid:<n>` synthetic
 * addresses), tagging each with `source: 'quorum' | 'farcaster'`
 * (`SocialFeedModal.tsx`'s own `ShareToChatModal`, `quorumWithSource` /
 * `farcasterWithSource`). Only the Quorum-sourced row now resolves through
 * `@/identity`; the Farcaster-sourced row is untouched.
 *
 * ## What is asserted
 *
 * The Quorum partner has a stale global `displayName` on their conversation
 * row AND a verified `.q` — the row must show the `.q`, not the stale name,
 * proving the fix actually calls the resolver rather than only removing a
 * dead field. The Farcaster row's own `displayName` must render completely
 * unchanged, proving the migration did not accidentally route a Farcaster
 * identity through the member resolver (which would treat its `fid:<n>`
 * address as a Quorum member and very likely render the wrong name).
 */
import React from 'react';
import { screen, waitFor, cleanup } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithProviders } from '@/jest/renderWithProviders';
import { IdentityScopeProvider } from '@/identity/identityProvider';

// Same genuine ed448 key/address pair as the other migrated render tests.
const PARTNER = 'QmRxwsciKWz7fvph4PobmabjChKPZtvkBcE4oALnogXDYW';
const KEY =
  '030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b';

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

// `mock`-prefixed `let`s: `jest.mock` factories are hoisted above every other
// statement in the file, so they may only close over variables jest
// recognises as test doubles by that naming convention (same convention as
// `shareInviteSheetName.test.tsx`'s `mockConversation`).
let mockQuorumConversation = {
  conversationId: 'conv-1',
  address: PARTNER,
  displayName: 'Alice Smith',
  timestamp: 1_700_000_000_000,
  icon: undefined,
  type: 'direct' as const,
};
let mockFarcasterConversation = {
  conversationId: 'farcaster:conv-2',
  address: 'fid:999',
  displayName: 'Bob FC',
  farcasterUsername: 'bobfc',
  farcasterParticipantFids: [999],
  timestamp: 1_700_000_001_000,
  icon: undefined,
  type: 'direct' as const,
};

jest.mock('@/hooks/chat/useConversations', () => ({
  useConversations: () => ({
    data: { pages: [{ conversations: [mockQuorumConversation] }] },
  }),
}));
jest.mock('@/hooks/chat/useFarcasterDirectCasts', () => ({
  useFarcasterConversations: () => ({
    data: { pages: [{ conversations: [mockFarcasterConversation] }] },
  }),
  useSendFarcasterDirectCast: () => ({ mutateAsync: jest.fn() }),
}));
jest.mock('@/hooks/chat/useSendDirectMessage', () => ({
  useSendDirectMessage: () => ({ mutateAsync: jest.fn() }),
}));
jest.mock('@/hooks/chat/useSendSpaceMessage', () => ({
  useSendSpaceMessage: () => ({ mutateAsync: jest.fn() }),
}));
jest.mock('@/hooks/chat/useSpaces', () => ({
  useSpaces: () => ({ data: [] }),
}));
// `SocialFeedModal.tsx`'s default export (not `ShareToChatModal`, which
// never calls this) reaches this context, which transitively imports
// `BrowserModal` -> `ProfileView` -> ... -> `requireNativeModule
// ('QuorumCrypto')` at import time — module-graph fallout from this file
// having no barrel to import just one piece of, not anything this row
// touches.
jest.mock('@/context/MiniappOverlayContext', () => ({
  useMiniappOverlay: () => ({ openMiniapp: jest.fn() }),
}));
// Same reasoning: real `AuthContext` reaches `requireNativeModule
// ('QuorumCrypto')` transitively (via `services/offline/storage.ts`), both
// directly (`SocialFeedModal.tsx` itself imports `useAuth`) and through
// `ComposeChannelPickerModal`. `ShareToChatModal` uses neither.
jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: null, farcasterAuthToken: undefined }),
}));
// The true root of every one of the chains above: `SocialFeedModal.tsx` has
// no barrel of its own, so importing ANY one piece of it (here,
// `ShareToChatModal`) pulls in the whole file's import graph — dozens of
// sibling feed/miniapp/browser components, several of which eventually reach
// `services/crypto/native-provider.ts` -> this module's own
// `requireNativeModule('QuorumCrypto')` at import time. Mocked once, here,
// rather than chasing each individual consumer (AuthContext, StorageContext,
// farcasterFeedCache, ...) as it turns up.
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
// `InviteLinkCard` (rendered elsewhere in `SocialFeedModal.tsx`'s cast body,
// never by `ShareToChatModal`) imports the WHOLE `@/context` barrel, which
// in turn pulls in `OnboardingContext` -> `@scure/bip39`, an ESM package
// jest's babel config cannot parse from node_modules. Unrelated to this row.
jest.mock('@/components/Chat/InviteLinkCard', () => ({
  InviteLinkCard: () => null,
  containsInviteLink: () => false,
}));
// `AudioSpaceEmbed` (cast body rendering, unrelated to the DM/space picker)
// reaches `react-native-webrtc` -> `NativeEventEmitter` at import time,
// which throws under jest with no native module backing it.
jest.mock('@/components/SocialFeed/content/AudioSpaceEmbed', () => ({
  AudioSpaceEmbed: () => null,
}));
// `LiveSpacesStrip` (cast-feed UI, unrelated to the picker) reaches the same
// `AudioSpaceOverlay` cluster via `CreateSpaceSheet` -> `AudioSpaceContext`,
// this time bottoming out in `expo-audio`'s own native module rather than
// webrtc directly. Same reasoning as the `AudioSpaceEmbed` mock above.
jest.mock('@/components/SocialFeed/content/LiveSpacesStrip', () => ({
  LiveSpacesStrip: () => null,
}));
// The rest of `SocialFeedModal.tsx`'s cast-rendering sibling components,
// mocked for the same reason as the three above: each is unrelated to
// `ShareToChatModal` but sits in the same giant file's single shared import
// graph (no barrel to import just one piece of), and several reach the same
// wallet (`@scure/bip32`, an ESM package jest's babel config cannot parse)
// or native-module chains already documented above.
jest.mock('@/components/wallet/TipModal', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/components/SocialFeed/content/FarcasterTokenEmbed', () => ({
  FarcasterTokenEmbed: () => null,
}));
jest.mock('@/components/SocialFeed/content/SnapEmbed', () => ({
  SnapEmbed: () => null,
  useSnapDetection: () => ({ isSnap: false }),
}));
jest.mock('@/components/SocialFeed/media/YouTubeEmbed', () => ({
  YouTubeEmbed: () => null,
  extractYouTubeMatchesFromText: () => [],
  parseYouTubeUrl: () => null,
}));
jest.mock('@/components/SocialFeed/media/VideoViewer', () => ({
  VideoViewer: () => null,
}));
jest.mock('@/components/SocialFeed/media/ImageViewer', () => ({
  ImageViewer: () => null,
}));
jest.mock('@/components/SocialFeed/views', () => ({
  GovernanceView: () => null,
  ProposalDetailView: () => null,
}));
jest.mock('@/components/SocialFeed/views/ProposalVoteBlock', () => ({
  ProposalVoteBlock: () => null,
}));
jest.mock('@/components/ComposeChannelPickerModal', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/components/SocialFeed/CastOverflowButton', () => ({
  CastOverflowButton: () => null,
}));
// `quorum-translation` ships an ESM-only native module wrapper jest's babel
// config cannot parse from node_modules. Reached by several
// `services/translation/*` files that `SocialFeedModal.tsx` pulls in for
// cast translation, unrelated to the DM/space picker.
// `expo-video`/`expo-audio` (used directly by `SocialFeedModal.tsx` for
// cast media playback, not by `ShareToChatModal`) reach a native player
// object at import time with no native module registered under jest.
jest.mock('expo-video', () => ({
  useVideoPlayer: () => ({}),
  VideoView: () => null,
}));
jest.mock('expo-audio', () => ({
  setAudioModeAsync: jest.fn(),
  AudioModule: {},
}));
jest.mock('@/components/ReportModal', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('quorum-translation', () => ({
  __esModule: true,
  UNDETERMINED: 'und',
  isTranslationAvailable: jest.fn().mockResolvedValue(false),
  detectLanguage: jest.fn(),
  ensureModel: jest.fn(),
  translate: jest.fn(),
  default: {},
}));
// `react-native-webrtc` reaches `NativeEventEmitter` at import time (no
// native module registered under jest) and is reached from multiple points
// in `SocialFeedModal.tsx`'s graph (`AudioSpaceOverlay` via both
// `AudioSpaceEmbed` and `LiveSpacesStrip` -> `CreateSpaceSheet`). Local to
// this file rather than added to `jest/setup-native.js` — nothing this row
// touches does real calling, and that file's own docstring reserves it for
// stubs a render genuinely needs, added as they come up.
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

// `@/utils/verifyQnsClaim` is deliberately NOT mocked — the verified case
// must prove a genuinely verified claim renders `.q`, not merely that the
// picker trusts whatever `verifiedQnsNames` already contains.

import { ShareToChatModal } from '@/components/SocialFeedModal';
import { DarkTheme } from '@/theme';

let queryClient: QueryClient;

function renderModal() {
  return renderWithProviders(
    <QueryClientProvider client={queryClient}>
      <IdentityScopeProvider rostersBySpace={{}} selfAddress={null}>
        <ShareToChatModal
          visible
          castUrl="https://example.invalid/cast/1"
          theme={DarkTheme}
          bottomInset={0}
          onClose={() => {}}
          onSent={() => {}}
        />
      </IdentityScopeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

describe('ShareToChatModal — the Quorum row resolves, the Farcaster row is untouched', () => {
  it('shows the Quorum partner under their verified .q, and the Farcaster row unchanged', async () => {
    renderModal();

    await waitFor(() => expect(screen.getByText('alice.q')).toBeTruthy());
    expect(screen.queryByText('Alice Smith')).toBeNull();

    // The Farcaster row's own displayName, completely unrouted through the
    // member resolver — a `fid:999` address has no roster entry and no `.q`.
    expect(screen.getByText('Bob FC')).toBeTruthy();
  });
});
