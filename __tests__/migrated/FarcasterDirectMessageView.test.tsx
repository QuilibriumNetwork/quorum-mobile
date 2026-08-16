/**
 * `FarcasterDirectMessageView.tsx` is one of rows 15-16 of this migration
 * pass, and its outcome is different from every other row: NO ladder code
 * changed. Instead this file covers the invariant that makes the "no change"
 * call correct.
 *
 * ## Why this file has no `.q`-pinning render test
 *
 * The row's original description read `conversation.displayName` as "a
 * Quorum conversation name read raw", the same shape as row 15's genuine
 * defect in `SocialFeedModal.tsx`. Tracing the actual data instead of the
 * one-line description shows it is not:
 *
 * - This component only ever renders when `isFarcasterConversation` is true
 *   (`app/(tabs)/messages/dm/[id].tsx:500-518`).
 * - EVERY Farcaster conversation object — real or the synthetic one built
 *   for a first-time DM — carries a synthetic `fid:<n>` address, never a
 *   Quorum one (`hooks/chat/useFarcasterDirectCasts.ts:73`; the synthetic
 *   branch at `app/(tabs)/messages/dm/[id].tsx:126`).
 * - `conversation.displayName` is populated entirely from Farcaster fields:
 *   `fc.name ?? counterParty?.displayName ?? counterParty?.username`
 *   (`hooks/chat/useFarcasterDirectCasts.ts:75`).
 *
 * So the raw read here is Farcaster's own conversation-title field, not a
 * Quorum name — routing `conversation.address` through `@/identity` would be
 * the exact mistake this migration's brief warns against: treating a
 * `fid:<n>` synthetic address as a member address.
 *
 * ## Two things pinned here, not one
 *
 * A prior version of this file only had the static import check below. Review
 * flagged that as too weak on its own: it only catches a re-import of the
 * exact barrel string, and — the bigger gap — the invariant the WHOLE
 * classification rests on (every conversation this component receives has a
 * `fid:<n>` address) had no coverage at all; it lived only in prose. Both are
 * closed here:
 *
 * 1. The import check is widened to also catch a submodule import
 *    (`@/identity/useResolvedName`) and a reintroduction of the OLD
 *    pre-`@/identity` ladder (`@/utils/resolveMemberName` and its siblings —
 *    the same names `__tests__/rawNameFieldAudit.test.ts`'s own
 *    `RESOLVER_IMPORT` tracks).
 * 2. The `fid:<n>` invariant itself is now a real, `__DEV__`-gated runtime
 *    check inside the component (see `FarcasterDirectMessageView.tsx`), and
 *    the second describe block below proves it actually fires — not just
 *    that the file happens to compile.
 *
 * A render test (mounting the real component with a Quorum-shaped address
 * and asserting the throw) rather than a lighter unit test of an extracted
 * predicate function, because the whole point is to prove the CHECK IN THE
 * COMPONENT fires, not that some helper function would return the right
 * boolean in isolation — a predicate could be correct and still not be
 * wired in.
 */
import { readFileSync } from 'fs';

describe('FarcasterDirectMessageView — deliberately NOT routed through the member resolver', () => {
  it('does not import the identity module (barrel or any submodule) or the legacy resolver ladder', () => {
    const source = readFileSync('components/Chat/FarcasterDirectMessageView.tsx', 'utf8');
    // Barrel (`@/identity`), any submodule (`@/identity/useResolvedName`),
    // and the OLD pre-`@/identity` ladder this file never used either
    // (`@/utils/resolveMemberName`/`resolveSelfName`/`conversationTitle` —
    // the same names `rawNameFieldAudit.test.ts`'s `RESOLVER_IMPORT` tracks).
    const RESOLVER_IMPORT =
      /from\s+['"]@\/identity(\/[\w-]+)?['"]|from\s+['"]@\/utils\/(resolveMemberName|resolveSelfName|conversationTitle)['"]/;
    expect(source).not.toMatch(RESOLVER_IMPORT);
  });
});

// --- The fid:<n> invariant itself ------------------------------------------

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: null, farcasterAuthToken: undefined }),
}));
// All five stubbed as no-ops: the invariant below throws before any of them
// is ever called (it runs as the first statement in the component, ahead of
// even `useAuth()`), so none needs to behave realistically — it only needs
// to exist so the module graph loads under jest.
jest.mock('@/hooks/chat', () => ({
  useFarcasterDirectCastMessages: () => ({
    data: undefined,
    isLoading: false,
    isRefetching: false,
    isFetchingNextPage: false,
    error: null,
    hasNextPage: false,
    refetch: jest.fn(),
    fetchNextPage: jest.fn(),
  }),
  useSendFarcasterDirectCast: () => ({ mutate: jest.fn(), isPending: false }),
  useMarkFarcasterConversationRead: () => ({ mutate: jest.fn() }),
  useAddFarcasterDirectCastReaction: () => ({ mutate: jest.fn() }),
  useRemoveFarcasterDirectCastReaction: () => ({ mutate: jest.fn() }),
}));
jest.mock('@/components/Chat/MessagesList', () => ({
  MessagesList: () => null,
}));
jest.mock('@/components/Chat/MessageInput', () => ({
  MessageInput: () => null,
}));
jest.mock('@/components/Chat/ChatBottomChrome', () => ({
  ChatBottomChrome: ({ children }: { children: unknown }) => children,
  useChatListBottomInset: () => 0,
}));

import React from 'react';
import { render } from '@testing-library/react-native';
import { FarcasterDirectMessageView } from '@/components/Chat/FarcasterDirectMessageView';
import { DarkTheme } from '@/theme';

const FARCASTER_CONVERSATION = {
  conversationId: 'farcaster:conv-1',
  type: 'direct' as const,
  timestamp: 0,
  address: 'fid:42',
  icon: '',
  displayName: 'Bob FC',
  source: 'farcaster' as const,
};

// A shape this component should never actually receive (the whole point of
// the classification above), used only to prove the guard fires.
const QUORUM_SHAPED_CONVERSATION = {
  ...FARCASTER_CONVERSATION,
  address: 'QmRxwsciKWz7fvph4PobmabjChKPZtvkBcE4oALnogXDYW',
};

function renderView(conversation: typeof FARCASTER_CONVERSATION) {
  return render(
    <FarcasterDirectMessageView
      conversation={conversation as any}
      onBack={() => {}}
      theme={DarkTheme}
    />,
  );
}

describe('FarcasterDirectMessageView — the fid:<n> invariant this file\'s classification rests on', () => {
  it('renders normally for a genuine Farcaster (fid:<n>) conversation', () => {
    expect(() => renderView(FARCASTER_CONVERSATION)).not.toThrow();
  });

  it('throws when handed a conversation whose address is not a synthetic fid:<n> string', () => {
    expect(() => renderView(QUORUM_SHAPED_CONVERSATION)).toThrow(
      /is not a synthetic fid:<n> string/,
    );
  });
});
