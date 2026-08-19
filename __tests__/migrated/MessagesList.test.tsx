/**
 * MessagesList's message headers must render a member's verified name,
 * including the `.q` suffix.
 *
 * ## Why this is a real row
 *
 * `MessagesList` already imports `@/utils/resolveMemberName` (for the avatar
 * and bio ladders), so the audit ratchet has always passed it. But the
 * message HEADER text renders `item.userName` — a field precomputed upstream
 * by `toDisplayMessage` (`components/Chat/types.ts`, out of this row's scope)
 * through the OLD, non-React resolver. That seam cannot reach the verified
 * QNS tier. This test constructs `DisplayMessage` fixtures directly (bypassing
 * `toDisplayMessage`) with `userName` set to exactly what the old seam would
 * have produced — the member's stale global name, no `.q` — so a pre-migration
 * render is a genuine, observable defect rather than a fixture that happens to
 * already carry the right answer.
 *
 * ## What is mocked, and why
 *
 * `@/hooks/useApex` — `useApexStatusForAddresses` transitively reaches
 * `@/context/AuthContext`, which reaches `requireNativeModule('QuorumCrypto')`
 * at import time (the STANDING LIMITATION every Phase D render test works
 * around). Mocked wholesale to a no-op empty set, same reasoning as mocking
 * AuthContext/StorageContext directly elsewhere in this migration.
 * `@/context/SpaceCallContext` / `@/context/ToastContext` — reached by
 * `SpaceCallBubble`, which `MessagesList` imports unconditionally even though
 * no fixture message is a space call. `react-native-safe-area-context` —
 * reached by the always-mounted `MessageActionSheet`/`EditHistoryModal`/
 * `InviteLinkCard` siblings. `IdentityScopeProvider` is real — the whole
 * point is proving the real `useNameResolver` wiring, not a stand-in for it.
 */
import React from 'react';
import { screen, waitFor, cleanup, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { renderWithProviders } from '@/jest/renderWithProviders';
import { IdentityScopeProvider } from '@/identity/identityProvider';
import { useTheme } from '@/theme';
import type { DisplayMessage } from '@/components/Chat/types';

// react-query's notifyManager defers every subscriber notification through a
// real `setTimeout(0)` (`systemSetTimeoutZero`, deliberately NOT tied to
// promise/microtask timing), so `IdentityScopeProvider`'s `useQueries`-driven
// re-render lands on its own macrotask outside whatever `act()` scope wrapped
// the render call — it warns "not wrapped in act(...)" no matter how long the
// assertion below waits for it. Wrapping the notify callback in `act` is the
// fix the library itself documents for this exact case (see
// `notifyManager.setNotifyFunction`'s docstring: "wrap notifications with
// React.act while running tests"). It makes the state update land where React
// expects it to; it does not change what is asserted. This also happens to
// quiet the `ViewHolderCollection` warning this file could otherwise emit —
// FlashList's own layout effect re-measures as a downstream consequence of
// this SAME re-render, so once the render is properly act()-wrapped, so is
// everything it cascades into. Nothing FlashList-specific is mocked or
// suppressed here.
notifyManager.setNotifyFunction((callback) => {
  act(callback);
});

// Same genuine ed448 key/address pair reused across this migration —
// deriveAddress(KEY) === TARGET, real math, not a placeholder.
const TARGET = 'QmRxwsciKWz7fvph4PobmabjChKPZtvkBcE4oALnogXDYW';
const KEY =
  '030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b';
const SPACE_ID = 'space-1';

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

jest.mock('@/hooks/useApex', () => ({
  useApexStatusForAddresses: () => new Set<string>(),
}));

jest.mock('@/context/SpaceCallContext', () => ({
  useSpaceCall: () => ({
    state: { phase: 'idle', activeRoomId: null, participants: [] },
    joinCall: jest.fn(),
    leaveCall: jest.fn(),
    toggleMute: jest.fn(),
  }),
}));

jest.mock('@/context/ToastContext', () => ({
  useToast: () => ({ showToast: jest.fn() }),
}));

// `BrowserLink` -> `useOpenLink` -> `MiniappOverlayContext` ->
// `BrowserModal` -> ... -> `services/crypto/native-provider.ts` ->
// `requireNativeModule('QuorumCrypto')` at IMPORT time — the same STANDING
// LIMITATION, reached through the in-app-browser link card rather than
// AuthContext/StorageContext directly. None of this row's fixtures contain a
// link, so a trivial stand-in is safe.
jest.mock('@/components/BrowserLink', () => {
  // jest.mock factories cannot reference top-level imports (babel-plugin-jest-hoist).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require('react-native');
  return { __esModule: true, default: () => null, BrowserLink: (props: { children?: React.ReactNode }) => <Text>{props.children}</Text> };
});

// `InviteLinkCard` -> `@/context` (barrel) -> `StorageContext` -> the same
// native-module import chain as above, reached this time through the
// invite-link detector rather than the browser link. No fixture contains an
// invite link, so the pure detector functions can safely become no-ops.
jest.mock('@/components/Chat/InviteLinkCard', () => ({
  InviteLinkCard: () => null,
  containsInviteLink: () => false,
  extractInviteLink: () => null,
  stripInviteLink: (text: string) => text,
}));

// `FarcasterCastCard` -> `useFarcasterThread` -> same native-module import
// chain, reached through the Farcaster cast-card detector this time. No
// fixture is a Farcaster cast or contains a cast link.
jest.mock('@/components/Chat/FarcasterCastCard', () => ({
  FarcasterCastCard: () => null,
  containsFarcasterLink: () => false,
  extractFarcasterLink: () => null,
  stripFarcasterLink: (text: string) => text,
}));

// `quorum-translation` ships an ESM-only native module wrapper jest's babel
// config cannot parse from node_modules. Reached by `MessageActionSheet`
// (always mounted alongside the list) and by `MentionableText`/
// `MessageMarkdownRenderer`'s `useTranslatable` (via `MessageRenderer`), for
// the on-device translation toggle — unrelated to name resolution. Same
// mock `ShareToChatModal.test.tsx` (Phase D row 15) already established.
jest.mock('quorum-translation', () => ({
  __esModule: true,
  UNDETERMINED: 'und',
  isTranslationAvailable: jest.fn().mockResolvedValue(false),
  detectLanguage: jest.fn(),
  ensureModel: jest.fn(),
  translate: jest.fn(),
  default: {},
}));

// `claimedNameBelongsTo` is deliberately NOT mocked — the verified case
// must prove a genuinely verified claim renders `.q`, not merely that the
// header trusts whatever `verifiedQnsNames` already contains.

import { MessagesList } from '@/components/Chat/MessagesList';

let queryClient: QueryClient;

function baseMessage(overrides: Partial<DisplayMessage> = {}): DisplayMessage {
  return {
    id: 'msg-1',
    userId: TARGET,
    // The OLD seam's output — a stale global name, never a `.q` — so a
    // pre-migration render that trusts this field is an observable defect.
    userName: 'Alice Smith',
    userAvatar: '',
    timestamp: Date.now(),
    timeString: '12:00',
    content: 'hello there',
    renderType: 'post',
    ...overrides,
  };
}

// `theme` is a required PROP on MessagesList (not read via context), so this
// wrapper pulls a real theme out of the real provider `renderWithProviders`
// already mounts, rather than hand-building an `AppTheme` object that could
// drift from the real shape.
function ThemedMessagesList(props: {
  messages: DisplayMessage[];
  spaceId?: string;
  isFarcasterNamespace?: boolean;
}) {
  const { theme } = useTheme();
  return (
    <MessagesList
      messages={props.messages}
      theme={theme}
      spaceId={props.spaceId}
      isFarcasterNamespace={props.isFarcasterNamespace}
    />
  );
}

function renderList(
  messages: DisplayMessage[],
  rostersBySpace: Record<string, Record<string, { display_name?: string; global_display_name?: string }>> = {},
  spaceId: string | undefined = SPACE_ID,
  isFarcasterNamespace = false,
) {
  return renderWithProviders(
    <QueryClientProvider client={queryClient}>
      <IdentityScopeProvider rostersBySpace={rostersBySpace} selfAddress={null}>
        <ThemedMessagesList
          messages={messages}
          spaceId={spaceId}
          isFarcasterNamespace={isFarcasterNamespace}
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

describe('MessagesList — message headers resolve through @/identity', () => {
  it('renders the sender under their verified .q, the follow-global default state', async () => {
    renderList([baseMessage()]);

    await waitFor(() => expect(screen.getByText('alice.q')).toBeTruthy());
    expect(screen.queryByText('Alice Smith')).toBeNull();
  });

  it('renders a per-space nickname instead, with no .q, when the sender has one', async () => {
    renderList(
      [baseMessage()],
      { [SPACE_ID]: { [TARGET]: { display_name: 'Bob Nickname' } } },
    );

    await waitFor(() => expect(screen.getByText('Bob Nickname')).toBeTruthy());
    expect(screen.queryByText(/alice\.q/)).toBeNull();
    expect(screen.queryByText('Alice Smith')).toBeNull();
  });
});

/**
 * The `enrich` section of this row's brief: MEASURE the request count, don't
 * argue about it. `QmPeerA<n>...` addresses, the repo's placeholder family —
 * these are synthetic distinct senders, not derivable/real ones, since this
 * pair of tests only cares about how many `getPublicProfile` calls the
 * distinct-sender set produces, never about verifying a `.q`.
 */
function fakeAddress(i: number): string {
  return `QmPeerA${i.toString().padStart(3, '0')}${'x'.repeat(38)}`;
}

describe('MessagesList — enrichment fan-out is bounded, not per-message', () => {
  it('requests one profile per DISTINCT sender, not one per message', async () => {
    // 40 messages, 8 distinct senders (5 messages each) — well under the cap.
    const senders = Array.from({ length: 8 }, (_, i) => fakeAddress(i));
    const messages = Array.from({ length: 40 }, (_, i) => baseMessage({
      id: `msg-${i}`,
      userId: senders[i % senders.length],
    }));

    renderList(messages);

    await waitFor(() => expect(mockGetPublicProfile).toHaveBeenCalledTimes(8));
    // Give any stray extra scheduling a chance to land, then confirm it
    // never crept past the distinct-sender count.
    await new Promise((r) => setTimeout(r, 10));
    expect(mockGetPublicProfile).toHaveBeenCalledTimes(8);
  });

  it('caps the fan-out at MAX_QNS_LOOKUPS (50) for a channel with more distinct senders than that', async () => {
    // 60 distinct senders, one message each — over the cap.
    const messages = Array.from({ length: 60 }, (_, i) => baseMessage({
      id: `msg-${i}`,
      userId: fakeAddress(i),
    }));

    renderList(messages);

    await waitFor(() => expect(mockGetPublicProfile).toHaveBeenCalledTimes(50));
    await new Promise((r) => setTimeout(r, 10));
    expect(mockGetPublicProfile).toHaveBeenCalledTimes(50);
  });
});

/**
 * Farcaster senders must NOT reach the Quorum member resolver.
 *
 * ## The defect this pins
 *
 * A Farcaster sender's `userId` is a fid, not an address. Handing one to the
 * resolver does not fail loudly — no tier matches, so it falls through to the
 * truncating fallback, and `formatAddress` returns any string short enough to
 * need no truncation UNCHANGED. A fid is always short enough. The row
 * therefore rendered the raw fid where a name belongs, with every test green,
 * because nothing in the suite had ever rendered a Farcaster sender.
 *
 * Both shapes are covered, because they look different in the data:
 *  - a Farcaster DM, where EVERY sender is a bare unprefixed fid and only the
 *    `isFarcasterNamespace` prop distinguishes them from addresses; and
 *  - a bound space channel, where casts (`fc:`-prefixed, from
 *    `castToDisplayMessage`) are merged into a list of real Quorum senders,
 *    so the decision has to be made per message rather than per list.
 *
 * The `.q` is deliberately NOT expected here. A linked Quorum identity is
 * reached by resolving the ADDRESS behind the fid, via the fid→address link,
 * and is rendered as a separate badge beside the Farcaster name — see
 * `DMChatHeader.test.tsx`. Resolving the fid itself would, at best, name
 * nobody and, on a collision, name the WRONG PERSON.
 */
describe('MessagesList — Farcaster senders keep their Farcaster name', () => {
  it('renders the name carried on the message, not the fid, in a Farcaster DM', async () => {
    renderList(
      [baseMessage({ userId: '1043504', userName: 'Vitalik' })],
      {},
      undefined,
      true,
    );

    await waitFor(() => expect(screen.getByText('Vitalik')).toBeTruthy());
    // The exact string the truncating fallback produced before the fix.
    expect(screen.queryByText('1043504')).toBeNull();
  });

  it('never fetches a Quorum profile for a fid', async () => {
    renderList(
      [baseMessage({ userId: '1043504', userName: 'Vitalik' })],
      {},
      undefined,
      true,
    );

    await waitFor(() => expect(screen.getByText('Vitalik')).toBeTruthy());
    await new Promise((r) => setTimeout(r, 10));
    expect(mockGetPublicProfile).not.toHaveBeenCalled();
  });

  it('resolves Quorum senders and leaves cast authors alone in the same mixed channel', async () => {
    renderList([
      baseMessage({ id: 'msg-quorum', userId: TARGET, userName: 'Alice Smith' }),
      baseMessage({ id: 'msg-cast', userId: 'fc:1043504', userName: 'Vitalik' }),
    ]);

    // The Quorum sender still climbs the full ladder to their verified `.q`...
    await waitFor(() => expect(screen.getByText('alice.q')).toBeTruthy());
    // ...while the cast author keeps Farcaster's own name.
    expect(screen.getByText('Vitalik')).toBeTruthy();
    expect(screen.queryByText('fc:1043504')).toBeNull();
    // One distinct QUORUM sender in the list, so exactly one profile fetch —
    // the fid must not have consumed a lookup of its own.
    expect(mockGetPublicProfile).toHaveBeenCalledTimes(1);
    expect(mockGetPublicProfile).toHaveBeenCalledWith(TARGET);
  });
});
