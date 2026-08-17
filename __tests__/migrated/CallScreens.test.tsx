/**
 * InCallScreen, IncomingCallScreen and OutgoingCallScreen must resolve the
 * counterparty's name from their ADDRESS, not trust the `recipientDisplayName`
 * / `callerDisplayName` string stamped onto the call payload at dial/offer
 * time.
 *
 * ## The defect this pins
 *
 * The call payload (`ActiveCall.recipientDisplayName`, `IncomingCallInfo.
 * callerDisplayName` — `context/CallContext.tsx`) carries whatever name the
 * app knew at the moment the call was placed or the offer arrived. It is
 * never revisited: if the partner's name changes, or the payload's own value
 * was itself unresolved (an unverified claim, or a raw address), the call UI
 * shows that frozen, unverified value for the whole call. All three screens
 * DO carry the counterparty's real address on the same payload
 * (`recipientAddress` / `callerAddress`) — confirmed by reading
 * `context/CallContext.tsx`, which populates both from real params in
 * `initiateCall`/`acceptCall` and from the wire in `handleCallSignal`. So the
 * fix resolves from that address through `@/identity` instead of reading the
 * frozen name field at all.
 *
 * ## What is mocked, and why
 *
 * `@/context`'s `useCall` is mocked so the test controls call state directly
 * instead of standing up real WebRTC signaling — same shape as
 * `spaceCallParticipantAvatars.test.tsx` mocks `@/context/SpaceCallContext`.
 * `react-native-webrtc` reaches `NativeEventEmitter` at import time (only
 * `InCallScreen` imports it, but the stub is harmless for the other two).
 * `IdentityScopeProvider` is real — the point is proving the real
 * `useResolvedName` wiring, not a stand-in for it. `claimedNameBelongsTo`
 * is deliberately NOT mocked: the verified case must prove a genuinely
 * verified claim renders `.q`, not merely that the screen trusts whatever
 * `verifiedQnsNames` already contains.
 */
import React from 'react';
import { screen, waitFor, cleanup } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithProviders } from '@/jest/renderWithProviders';
import { IdentityScopeProvider } from '@/identity/identityProvider';
import type { ActiveCall, IncomingCallInfo } from '@/context/CallContext';

// Same genuine ed448 key/address pair as the other migrated-surface tests —
// deriveAddress(KEY) === PARTNER, real math, not a placeholder.
const PARTNER = 'QmRxwsciKWz7fvph4PobmabjChKPZtvkBcE4oALnogXDYW';
const KEY =
  '030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b';

let mockActiveCall: ActiveCall | null;
let mockIncomingCall: IncomingCallInfo | null;
let mockGetPublicProfile: jest.Mock;
let mockResolveBatch: jest.Mock;

jest.mock('react-native-webrtc', () => ({
  RTCView: () => null,
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@/context', () => ({
  useCall: () => ({
    activeCall: mockActiveCall,
    incomingCall: mockIncomingCall,
    initiateCall: jest.fn(),
    acceptCall: jest.fn(),
    rejectCall: jest.fn(),
    hangup: jest.fn(),
    toggleMute: jest.fn(),
    toggleSpeaker: jest.fn(),
    toggleVideo: jest.fn(),
    flipCamera: jest.fn(),
    getLocalStream: () => null,
    getRemoteStream: () => null,
  }),
}));

jest.mock('@/services/api/quorumClient', () => ({
  getQuorumClient: () => ({
    getPublicProfile: (address: string) => mockGetPublicProfile(address),
  }),
}));

jest.mock('@/services/api/qnsClient', () => ({
  resolveBatch: (names: string[]) => mockResolveBatch(names),
}));

import { InCallScreen } from '@/components/Call/InCallScreen';
import { IncomingCallScreen } from '@/components/Call/IncomingCallScreen';
import { OutgoingCallScreen } from '@/components/Call/OutgoingCallScreen';

const baseActiveCall: ActiveCall = {
  callId: 'call-1',
  conversationId: 'conv-1',
  recipientAddress: PARTNER,
  // Deliberately a WRONG/frozen value, distinct from anything the resolver
  // would produce — proves the screen no longer reads this field at all.
  recipientDisplayName: 'Stale Payload Name',
  recipientAvatar: '',
  direction: 'outgoing',
  mediaType: 'audio',
  state: 'connected',
  startTime: Date.now(),
  isMuted: false,
  isSpeakerOn: false,
  isVideoEnabled: false,
  circuitId: null,
  endReason: null,
  callQuality: null,
};

const baseIncomingCall: IncomingCallInfo = {
  callId: 'call-2',
  conversationId: 'conv-1',
  callerAddress: PARTNER,
  callerDisplayName: 'Stale Payload Name',
  callerAvatar: '',
  mediaType: 'audio',
  sdp: '',
  relayCredentials: { username: '', password: '', turnUrls: [], ttl: 0, nodeId: '' },
  circuitId: 'circuit-1',
  receivedAt: Date.now(),
};

let queryClient: QueryClient;

function renderWithIdentity(ui: React.ReactElement) {
  return renderWithProviders(
    <QueryClientProvider client={queryClient}>
      <IdentityScopeProvider rostersBySpace={{}} selfAddress={null}>
        {ui}
      </IdentityScopeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockActiveCall = null;
  mockIncomingCall = null;
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

describe('InCallScreen — resolves the counterparty from recipientAddress', () => {
  it('renders the partner under their verified .q, never the stale payload name', async () => {
    mockActiveCall = baseActiveCall;

    renderWithIdentity(<InCallScreen />);

    await waitFor(() => expect(screen.getByText('alice.q')).toBeTruthy());
    expect(screen.queryByText('Stale Payload Name')).toBeNull();
  });
});

describe('IncomingCallScreen — resolves the caller from callerAddress', () => {
  it('renders the caller under their verified .q, never the stale payload name', async () => {
    mockIncomingCall = baseIncomingCall;

    renderWithIdentity(<IncomingCallScreen />);

    await waitFor(() => expect(screen.getByText('alice.q')).toBeTruthy());
    expect(screen.queryByText('Stale Payload Name')).toBeNull();
  });
});

describe('OutgoingCallScreen — resolves the counterparty from recipientAddress', () => {
  it('renders the partner under their verified .q, never the stale payload name', async () => {
    mockActiveCall = { ...baseActiveCall, state: 'ringing', startTime: null };

    renderWithIdentity(<OutgoingCallScreen />);

    await waitFor(() => expect(screen.getByText('alice.q')).toBeTruthy());
    expect(screen.queryByText('Stale Payload Name')).toBeNull();
  });
});
