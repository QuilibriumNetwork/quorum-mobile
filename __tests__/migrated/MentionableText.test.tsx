/**
 * `MentionableText`'s rendered `@mention` pills must show a member's verified
 * name, including the `.q` suffix.
 *
 * ## Why this is a real row
 *
 * `MentionableText` already imports `@/utils/resolveMemberName` for the pill
 * text, so the audit ratchet has always passed it. But that seam resolves off
 * the `members` prop through the OLD, non-React ladder, which cannot reach
 * the verified QNS tier — a pill can never show `.q` no matter how the
 * member's profile resolves elsewhere in the app.
 *
 * ## What is mocked, and why
 *
 * `quorum-translation` — reached through `useTranslatable` (the on-device
 * "See translation" toggle this component always calls), unrelated to name
 * resolution. Same mock `ShareToChatModal.test.tsx` (Phase D row 15)
 * established. `IdentityScopeProvider` is real.
 */
import React from 'react';
import { screen, waitFor, cleanup, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { renderWithProviders } from '@/jest/renderWithProviders';
import { IdentityScopeProvider } from '@/identity/identityProvider';
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

jest.mock('quorum-translation', () => ({
  __esModule: true,
  UNDETERMINED: 'und',
  isTranslationAvailable: jest.fn().mockResolvedValue(false),
  detectLanguage: jest.fn(),
  ensureModel: jest.fn(),
  translate: jest.fn(),
  default: {},
}));

// `@/utils/verifyQnsClaim` is deliberately NOT mocked — the verified case
// must prove a genuinely verified claim renders `.q`, not merely that the
// pill trusts whatever `verifiedQnsNames` already contains.

import { MentionableText } from '@/components/Chat/MentionableText';

let queryClient: QueryClient;

// `global_display_name` set so the pre-migration RED is "the stale global
// name rendered where `.q` belongs" (the canonical case this row's recipe
// describes), not merely "an unresolved fixture truncates to an address".
const member: SpaceMember = { address: TARGET, global_display_name: 'Alice Smith' } as SpaceMember;

function renderPill(
  rostersBySpace: Record<string, Record<string, { display_name?: string; global_display_name?: string }>> = {},
  spaceId: string | undefined = SPACE_ID,
) {
  return renderWithProviders(
    <QueryClientProvider client={queryClient}>
      <IdentityScopeProvider rostersBySpace={rostersBySpace} selfAddress={null}>
        <MentionableText
          text={`Hi @<${TARGET}> there`}
          customEmojis={[]}
          members={[member]}
          spaceId={spaceId}
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

describe('MentionableText — mention pills resolve through @/identity', () => {
  it('renders the mentioned member under their verified .q, the follow-global default state', async () => {
    renderPill();

    await waitFor(() => expect(screen.getByText(/@alice\.q/)).toBeTruthy());
    expect(screen.queryByText(/@Alice Smith/)).toBeNull();
  });

  it('renders a per-space nickname instead, with no .q, when the member has one', async () => {
    renderPill({ [SPACE_ID]: { [TARGET]: { display_name: 'Bob Nickname' } } });

    await waitFor(() => expect(screen.getByText(/@Bob Nickname/)).toBeTruthy());
    expect(screen.queryByText(/@alice\.q/)).toBeNull();
    expect(screen.queryByText(/@Alice Smith/)).toBeNull();
  });
});
