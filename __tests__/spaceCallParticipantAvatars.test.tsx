/**
 * SpaceCallScreen's participant avatars must be able to tell participants
 * apart.
 *
 * ## Why this exists
 *
 * `DefaultAvatar` no longer falls back to an address for initials (see
 * `defaultAvatarInitials.test.tsx`), which was correct — but three call sites
 * in this screen never had a way to reach a resolved name at all, so after
 * that fix they all rendered the SAME neutral "?" placeholder. Every
 * participant in a live space call became visually identical: the exact
 * distinguishability the address-derived colour used to provide, gone with
 * nothing replacing it.
 *
 * `defaultAvatarInitials.test.tsx` asserts one name renders correctly; it
 * cannot catch this regression, because the bug is that a SECOND participant
 * renders THE SAME as the first, not that any one of them renders wrong in
 * isolation. So this file asserts the comparative property directly: two
 * different participants must render two different initials.
 *
 * ## What is mocked, and why
 *
 * `react-native-webrtc` reaches `NativeEventEmitter` at import time (MEASURED:
 * importing `SpaceCallScreen` unmocked throws
 * "`new NativeEventEmitter()` requires a non-null argument" before any test
 * code runs), so it is stubbed wholesale, same pattern as
 * `jest/setup-native.js` uses for other native-import-time packages.
 * `@/context/SpaceCallContext` and `@/context/ToastContext` are mocked so the
 * test controls the call state directly instead of standing up a real WebRTC
 * call. `IdentityScopeProvider` is real — the whole point is proving the real
 * `useNameResolver` wiring, not a stand-in for it.
 */
import React from 'react';
import { screen, cleanup } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithProviders } from '@/jest/renderWithProviders';
import { IdentityScopeProvider } from '@/identity/identityProvider';
import type { SpaceCallState } from '@/context/SpaceCallContext';

const ALICE = 'QmPeerAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';
const BOB = 'QmThemThemThemThemThemThemThemThemThemThemThem';

// `mock`-prefixed so the jest.mock factory below (hoisted above this
// declaration) may close over it — same convention as
// identityProviderVerification.test.tsx. Reassigned per test, read fresh on
// every render because `useSpaceCall` is called on every render.
let mockState: SpaceCallState;

jest.mock('react-native-webrtc', () => ({
  RTCView: () => null,
}));

jest.mock('@/context/ToastContext', () => ({
  useToast: () => ({ showToast: jest.fn() }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@/context/SpaceCallContext', () => ({
  useSpaceCall: () => ({
    state: mockState,
    leaveCall: jest.fn(),
    toggleMute: jest.fn(),
    toggleVideo: jest.fn(),
    toggleSpeaker: jest.fn(),
    flipCamera: jest.fn(),
    getLocalStream: () => null,
    getRemoteStream: () => null,
    getDiagnosticsText: () => null,
  }),
}));

import { SpaceCallScreen } from '@/components/Call/SpaceCallScreen';

const baseState: SpaceCallState = {
  phase: 'connected',
  activeRoomId: 'room-1',
  spaceId: null,
  channelId: null,
  participants: [],
  isMuted: false,
  isVideoEnabled: false,
  isSpeakerOn: false,
  callQuality: null,
  speakingAddresses: [],
};

let queryClient: QueryClient;

function renderScreen() {
  return renderWithProviders(
    <QueryClientProvider client={queryClient}>
      {/* No spaceId: resolves off the GLOBAL ladder, so `locallyKnownNames`
          alone is enough — this test is about distinguishability, not about
          which tier wins. */}
      <IdentityScopeProvider
        rostersBySpace={{}}
        selfAddress={null}
        locallyKnownNames={{ [ALICE]: 'Alice', [BOB]: 'Bob' }}
      >
        <SpaceCallScreen onMinimize={() => {}} />
      </IdentityScopeProvider>
    </QueryClientProvider>,
  );
}

describe('SpaceCallScreen — participant avatars stay distinguishable', () => {
  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
  });

  it('renders a resolved participant under their own initial', () => {
    mockState = { ...baseState, participants: [ALICE] };

    renderScreen();

    expect(screen.getByText('A')).toBeTruthy();
  });

  it('renders two different participants under two different initials', () => {
    // The property the regression destroyed: every participant fell back to
    // the SAME neutral placeholder once DefaultAvatar stopped deriving
    // initials from the address. Asserting one name renders would not have
    // caught that — it takes a SECOND participant to prove they disagree.
    mockState = { ...baseState, participants: [ALICE, BOB] };

    renderScreen();

    expect(screen.getByText('A')).toBeTruthy();
    expect(screen.getByText('B')).toBeTruthy();
  });

  it('renders the neutral placeholder for an empty room, not a fabricated identity', () => {
    // No participants — the old `address="space"` was never a real member,
    // just a string that happened to seed a colour. Nobody to resolve, so the
    // neutral glyph is the honest rendering.
    mockState = { ...baseState, participants: [] };

    renderScreen();

    expect(screen.getByText('?')).toBeTruthy();
    expect(screen.queryByText('A')).toBeNull();
    expect(screen.queryByText('B')).toBeNull();
  });

  it('resolves the single "waiting for others" video placeholder too', () => {
    // Site :162 — the video layout's placeholder while the remote stream has
    // not arrived yet. Bounded to one participant, not the grid, but it must
    // use the same resolved name rather than staying unnamed forever.
    mockState = { ...baseState, isVideoEnabled: true, participants: [ALICE] };

    renderScreen();

    expect(screen.getByText('A')).toBeTruthy();
  });
});
