/**
 * AppTabBar's own avatar must rank a `.q` above the global display name for
 * its fallback initials, matching every other identity surface.
 *
 * ## The defect this pins
 *
 * `AvatarButton` computed its avatar fallback as
 * `user?.displayName || user?.primaryUsername || ''` — the global name
 * OUTRANKING the QNS name for the one identity in the app that is yours. Every
 * other surface ranks a `.q` above the global name; this was the one place
 * the app disagreed with itself about who you are.
 *
 * ## Why this is `resolveSelfName`, not `<MemberName>` / `useResolvedName`
 *
 * This is the SELF path, and self does not go through the roster+verification
 * ladder in `identity/` yet — that unification is a separate, later piece of
 * work (merging `resolveSelfName` into the one path for `HeaderAvatar` /
 * `UnifiedProfileHeader`). Reaching into `identity/` here would be doing that
 * work under a different row's name. The fix instead adopts the SAME already-
 * correct, already-tested utility `HeaderAvatar.tsx` uses for the identical
 * bug shape (`resolveSelfName`, see `utils/resolveSelfName.ts` and
 * `__tests__/resolveSelfName.test.ts`), so this surface stops being the one
 * screen (well, tab bar) that ranks the ladder backwards.
 *
 * ## Why initials, not a `.q` string
 *
 * `AppTabBar` never renders a name as text — the avatar is icon-only chrome.
 * The only observable trace of the ranking is which name the fallback
 * INITIALS are derived from, so that is what this file asserts on: a user
 * with both a QNS name and a global display name must show initials from the
 * QNS name, not the global one.
 */
import React from 'react';
import { screen, cleanup } from '@testing-library/react-native';
import { renderWithProviders } from '@/jest/renderWithProviders';

let mockUser: { displayName?: string; primaryUsername?: string; profileImage?: string } | null;

jest.mock('@/context', () => ({
  useAuth: () => ({ user: mockUser }),
}));

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  usePathname: () => '/messages',
}));

// AppTabBar's file-level import of useUnifiedNotifications (for the
// notification-bell tab, not rendered here) reaches @/context/AuthContext
// DIRECTLY — a different module path than the @/context barrel mocked above
// — which requires the real native QuorumCrypto module at import time and
// cannot run under jest at all. Stubbed wholesale; AvatarButton never calls
// this hook itself.
jest.mock('@/hooks/useUnifiedNotifications', () => ({
  useUnifiedNotifications: () => ({ unreadCount: 0 }),
}));

import { AvatarButton } from '@/components/ui/AppTabBar';

describe('AppTabBar — the avatar ranks a .q above the global name, like everywhere else', () => {
  afterEach(() => {
    cleanup();
  });

  it('derives initials from the QNS name, not the global display name, when both are set', () => {
    mockUser = { primaryUsername: 'gatto', displayName: 'GattoPardo Mobile' };

    renderWithProviders(<AvatarButton />);

    // resolveSelfName's initialsSource is the bare QNS name ('gatto' -> 'G');
    // the old inverted code would have derived from 'GattoPardo Mobile' -> 'GM'.
    expect(screen.getByText('G')).toBeTruthy();
    expect(screen.queryByText('GM')).toBeNull();
  });

  it('falls back to the global display name when no QNS name is elected', () => {
    // No per-space nickname case applies here (see the recipe's note this
    // file's header cross-references): self has no roster tier at all, only
    // QNS-name-vs-global-name, so the meaningful second case for THIS surface
    // is the fallback rung, not a nickname.
    mockUser = { displayName: 'GattoPardo Mobile' };

    renderWithProviders(<AvatarButton />);

    expect(screen.getByText('GM')).toBeTruthy();
  });
});
