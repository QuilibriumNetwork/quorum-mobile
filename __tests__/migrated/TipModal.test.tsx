/**
 * TipModal must resolve the tip recipient's Quorum identity through
 * `@/identity` before using it to label the post-tip DM, instead of trusting
 * `recipientQuorumIdentity.displayName` — an unverified claim straight off
 * a public profile fetch — verbatim.
 *
 * ## Why this is the worst place in the app for this defect
 *
 * A tip is a value transfer. `recipientQuorumIdentity` comes from
 * `useQuorumIdentityForFid` (`hooks/useQuorumIdentityForFid.ts`), which
 * surfaces `result.public_profile.display_name` AND `primary_username`
 * completely raw — it does not verify the claim, and `TipModal` used to
 * read only `.displayName`, discarding `.primaryUsername` entirely (so a
 * verified `.q` could never appear even by accident). `@/identity`
 * re-verifies independently rather than trusting either field, the same
 * discipline `ShareInviteSheet`/`DMSettingsSheet` already apply.
 *
 * ## What this pins, and why via the stored conversation
 *
 * The resolved name is never rendered as on-screen text — the visible
 * "Recipient" card intentionally shows the Farcaster author's OWN identity
 * (`authorDisplayName`/`authorUsername`; that card stays exactly as it is,
 * see the report's Farcaster/Quorum classification). The defect lives one
 * layer down: `sendTipNotification` stores a NEW `Conversation` row (when
 * none exists yet) so the recipient's device shows a sane title for the
 * "you got tipped" DM, and that row's `displayName` is what this test
 * observes via the mocked `storage.saveConversation`.
 *
 * `authorDisplayName` is intentionally OMITTED from every render below —
 * the migrated line keeps `authorDisplayName || <resolved>`, matching the
 * pre-migration priority order exactly (an explicit product choice this row
 * does not touch), so a truthy `authorDisplayName` would make the resolved
 * value unobservable through `displayName` and prove nothing.
 */
import React from 'react';
import { screen, waitFor, fireEvent, cleanup } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithProviders } from '@/jest/renderWithProviders';
import { IdentityScopeProvider } from '@/identity/identityProvider';

// Same genuine ed448 key/address pair as the other migrated render tests.
const RECIPIENT = 'QmRxwsciKWz7fvph4PobmabjChKPZtvkBcE4oALnogXDYW';
const KEY =
  '030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b';
const FID = 4242;

let mockGetPublicProfile: jest.Mock;
let mockResolveBatch: jest.Mock;
let mockSaveConversation: jest.Mock;

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

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ farcasterAuthToken: 'fc-token' }),
}));
jest.mock('@/context/ToastContext', () => ({
  useToast: () => ({ showToast: jest.fn() }),
}));
jest.mock('@/context/StorageContext', () => ({
  useStorageAdapter: () => ({
    getConversations: jest.fn().mockResolvedValue({ conversations: [] }),
    saveConversation: (c: unknown) => mockSaveConversation(c),
  }),
}));
jest.mock('@/hooks/chat/useSendDirectMessage', () => ({
  useSendDirectMessage: () => ({ mutateAsync: jest.fn().mockResolvedValue({}) }),
}));
// The Quorum-identity lookup itself IS mocked (unlike the claim-verification
// predicate below) — this hook's own `.displayName`/`.primaryUsername` are
// exactly the raw, unverified fields the defect trusted, so the fix must not
// depend on their content at all. Only `.address` feeds `@/identity`.
jest.mock('@/hooks/useQuorumIdentityForFid', () => ({
  useQuorumIdentityForFid: () => ({
    data: { address: RECIPIENT, displayName: 'Stale Claim Name', primaryUsername: 'alice' },
  }),
}));
jest.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({ balances: {}, refetch: jest.fn() }),
  useWalletKeys: () => ({ refetch: jest.fn().mockResolvedValue({}) }),
  useEvmBalancesForAddress: () => ({ data: undefined, refetch: jest.fn() }),
  aggregateAssets: () => [
    { symbol: 'wQUIL', chain: 'ethereum', decimals: 18, balance: '10', isNative: true, usdValue: 5, contractAddress: undefined },
  ],
}));
jest.mock('@/hooks/useWalletSelection', () => ({
  useWalletSelection: () => ({
    activeWallet: { address: '0xSenderAddress' },
    activeType: 'builtin',
    warpcastWallet: undefined,
    availableWallets: [{ type: 'builtin', address: '0xSenderAddress' }],
    hasWarpcastWallet: false,
    switchWallet: jest.fn(),
    isSwitching: false,
  }),
}));
jest.mock('@/hooks/useWarpcastWallet', () => ({
  useWarpcastWallet: () => ({ importedWallet: undefined }),
}));
jest.mock('@/hooks/useQNSPayment', () => ({
  getWalletPrivateKey: jest.fn().mockResolvedValue('0xprivatekey'),
}));
jest.mock('@/services/farcasterClient', () => ({
  fetchPrimaryEthAddress: jest.fn().mockResolvedValue('0xRecipientEthAddress'),
}));
jest.mock('@/services/wallet/swapService', () => ({
  getChainId: (chain: string) => (chain === 'ethereum' ? 1 : undefined),
}));
// Transitively reaches `@solana/web3.js`, which ships ESM `.native.mjs` that
// jest's babel config cannot parse from node_modules — unrelated to this
// row, just a module in TipModal's own import graph.
jest.mock('@/services/wallet/balanceService', () => ({
  getChainName: (chain: string) => chain,
  formatBalance: (balance: string) => balance,
}));
jest.mock('@/services/wallet/transactionService', () => ({
  sendSwapTransaction: jest.fn().mockResolvedValue({ hash: '0xtxhash', broadcastUncertain: false }),
  getExplorerUrl: () => 'https://explorer.example/tx/0xtxhash',
  estimateTransferGasCost: jest.fn().mockResolvedValue(0n),
  waitForTransaction: jest.fn().mockResolvedValue({ success: true, blockNumber: 1 }),
}));
jest.mock('@/services/wallet/transactionHistoryService', () => ({
  recordTransaction: jest.fn(),
  updateTransactionStatus: jest.fn(),
}));

// `claimedNameBelongsTo` is deliberately NOT mocked — the verified case
// must prove a genuinely verified claim renders `.q` in the stored
// conversation, not merely that the modal trusts whatever the identity
// context already contains.

import TipModal from '@/components/wallet/TipModal';

let queryClient: QueryClient;

function renderModal() {
  return renderWithProviders(
    <QueryClientProvider client={queryClient}>
      <IdentityScopeProvider rostersBySpace={{}} selfAddress={null}>
        <TipModal
          visible
          onClose={() => {}}
          castHash="0xcasthash"
          castText="gm"
          authorFid={FID}
          authorUsername="bob"
        />
      </IdentityScopeProvider>
    </QueryClientProvider>,
  );
}

async function sendATip() {
  renderModal();

  // Open the token picker and pick the one available asset.
  fireEvent.press(await screen.findByText('Select a token'));
  fireEvent.press(await screen.findByText('wQUIL'));

  // Type an amount, then press the now-enabled "Tip ..." button.
  fireEvent.changeText(screen.getByPlaceholderText('0.00'), '1');
  fireEvent.press(await screen.findByText(/^Tip 1 wQUIL$/));
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockSaveConversation = jest.fn();
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

describe('TipModal — resolves the recipient through @/identity for the post-tip DM', () => {
  it('stores the new conversation under the verified .q, not the raw claimed displayName', async () => {
    await sendATip();

    await waitFor(() =>
      expect(mockSaveConversation).toHaveBeenCalledWith(
        expect.objectContaining({ displayName: 'alice.q' }),
      ),
    );
    expect(mockSaveConversation).not.toHaveBeenCalledWith(
      expect.objectContaining({ displayName: 'Stale Claim Name' }),
    );
  });
});
