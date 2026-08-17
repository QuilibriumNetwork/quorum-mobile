/**
 * `MessageInput`'s `@mention` autocomplete row must render a member's
 * verified name, including the `.q` suffix.
 *
 * ## Why this is a real row
 *
 * `MessageInput` already imports `@/utils/resolveMemberName` for both the
 * autocomplete's FILTER (matching what the user typed) and its RENDER (the
 * row's label), so the audit ratchet has always passed it. But that seam
 * resolves off the `members` prop through the OLD, non-React ladder, which
 * cannot reach the verified QNS tier.
 *
 * ## What is mocked, and why
 *
 * `quorum-translation` is not reached by this file, but `MessageInput`
 * imports `@/hooks/useEmojiFrecency`, which reads `react-native-mmkv`
 * (auto-mocked, see `__mocks__/react-native-mmkv.js`). `react-native-mmkv`'s
 * `useMMKVString` used by nothing here directly. `IdentityScopeProvider` is
 * real — the whole point is proving the real `useNameResolver` wiring.
 */
import React from 'react';
import { screen, waitFor, fireEvent, cleanup, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { renderWithProviders } from '@/jest/renderWithProviders';
import { IdentityScopeProvider } from '@/identity/identityProvider';
import { useTheme } from '@/theme';
import type { SpaceMember } from '@quilibrium/quorum-shared';

// react-query's notifyManager defers every subscriber notification through a
// real `setTimeout(0)` (`systemSetTimeoutZero`, deliberately NOT tied to
// promise/microtask timing), so `IdentityScopeProvider`'s `useQueries`-driven
// re-render lands on its own macrotask outside whatever `act()` scope wrapped
// the render call — it warns "not wrapped in act(...)" no matter how long the
// assertion below waits for it. Wrapping the notify callback in `act` is the
// fix the library itself documents for this exact case (see
// `notifyManager.setNotifyFunction`'s docstring: "wrap notifications with
// React.act while running tests"). It makes the state update land where React
// expects it to; it does not change what is asserted.
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

// `claimedNameBelongsTo` is deliberately NOT mocked — the verified case
// must prove a genuinely verified claim renders `.q`, not merely that the
// autocomplete row trusts whatever `verifiedQnsNames` already contains.

import { MessageInput } from '@/components/Chat/MessageInput';

let queryClient: QueryClient;

// `global_display_name` set so the pre-migration RED is "the stale global
// name rendered where `.q` belongs" — the canonical case this row's recipe
// describes. Deliberately contains no substring of "alice", so the
// typed-the-resolved-name test below cannot pass by accidental overlap with
// the OLD ladder's own output.
const member: SpaceMember = { address: TARGET, global_display_name: 'Zach Ross' } as SpaceMember;

function ControlledInput(props: { members: SpaceMember[]; spaceId?: string }) {
  const [value, setValue] = React.useState('');
  const { theme } = useTheme();
  return (
    <MessageInput
      value={value}
      onChangeText={setValue}
      onSend={() => {}}
      channelName="general"
      theme={theme}
      members={props.members}
      spaceId={props.spaceId}
    />
  );
}

function renderInput(
  rostersBySpace: Record<string, Record<string, { display_name?: string; global_display_name?: string }>> = {},
  spaceId: string | undefined = SPACE_ID,
) {
  return renderWithProviders(
    <QueryClientProvider client={queryClient}>
      <IdentityScopeProvider rostersBySpace={rostersBySpace} selfAddress={null}>
        <ControlledInput members={[member]} spaceId={spaceId} />
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

describe('MessageInput — the @mention autocomplete row resolves through @/identity', () => {
  it('lists the candidate under their verified .q, the follow-global default state', async () => {
    renderInput();

    fireEvent.changeText(screen.getByPlaceholderText('Message...'), '@');

    await waitFor(() => expect(screen.getByText('alice.q')).toBeTruthy());
    expect(screen.queryByText('Zach Ross')).toBeNull();
  });

  it('lists a per-space nickname instead, with no .q, when the candidate has one', async () => {
    renderInput({ [SPACE_ID]: { [TARGET]: { display_name: 'Bob Nickname' } } });

    fireEvent.changeText(screen.getByPlaceholderText('Message...'), '@');

    await waitFor(() => expect(screen.getByText('Bob Nickname')).toBeTruthy());
    expect(screen.queryByText(/alice\.q/)).toBeNull();
    expect(screen.queryByText('Zach Ross')).toBeNull();
  });

  it('finds the candidate by typing their resolved name, not just the raw fields', async () => {
    // Types the QNS name — which only exists post-verification, through
    // `@/identity` — proving the FILTER (not just the render row) resolves
    // through the same ladder rather than matching only `display_name` /
    // `name` / `address`.
    renderInput();

    fireEvent.changeText(screen.getByPlaceholderText('Message...'), '@alice');

    await waitFor(() => expect(screen.getByText('alice.q')).toBeTruthy());
  });
});
