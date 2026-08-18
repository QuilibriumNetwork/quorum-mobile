/**
 * Who is offered the invite affordance, and who is not.
 *
 * Mobile had three entry points into the invite UI and three different rules,
 * which is what per-call-site gating always converges to. The space overview
 * banner was ungated entirely, so every member saw an invite pill whose only
 * possible outcome was a raw internal error string ("Owner key not found for
 * space…"). The other two were owner-only, which is too NARROW — sharing the
 * owner's public link is a capability the product wants members to have.
 *
 * One rule now covers all three: an owner may always invite; anyone else may
 * only when a genuinely usable public link already exists.
 *
 * The half that is easy to get wrong, and the reason this file exists, is what
 * "usable" means. `kickUser` overwrites `space.inviteUrl` with a
 * `quorum://join#…` value. It is truthy, it sits in the same field, and it is
 * completely unusable — so a truthiness gate hands every member a dead link to
 * share after any kick, and nothing about the UI would look wrong.
 */

// `isPublicInvite` is the load-bearing half, so it is exercised for real. Its
// module reaches the Rust crypto module and MMKV at import time; both are
// stubbed so the import graph resolves, neither is used by the predicate.
jest.mock('@/services/crypto/native-provider', () => ({ NativeCryptoProvider: class {} }));
jest.mock('react-native-mmkv', () => ({
  createMMKV: () => {
    const store = new Map<string, string>();
    return {
      getString: (k: string) => store.get(k),
      set: (k: string, v: string) => store.set(k, v),
      remove: (k: string) => store.delete(k),
      delete: (k: string) => store.delete(k),
      getAllKeys: () => Array.from(store.keys()),
      clearAll: () => store.clear(),
      contains: (k: string) => store.has(k),
    };
  },
}));

// Ownership and the Space record are the two inputs to the rule. Held on
// globalThis because jest hoists these factories above every declaration, so a
// module-scope const would still be in its TDZ.
jest.mock('@/services/config/spaceStorage', () => ({
  holdsSpaceOwnerKey: () => !!(globalThis as Record<string, unknown>).__isOwner,
}));
jest.mock('@/hooks/chat/useSpaces', () => ({
  useSpace: () => ({ data: (globalThis as Record<string, unknown>).__space }),
}));

import React from 'react';
import { render, renderHook, screen } from '@testing-library/react-native';
import type { Space } from '@quilibrium/quorum-shared';
import { CustomThemeProvider } from '@/theme';
import { useCanInviteToSpace } from '@/hooks/chat/useCanInviteToSpace';
import { SpaceBannerHeader } from '@/components/SpaceBannerHeader';

const SPACE_ID = 'QmPeerAbcdefghijklmnopqrstuvwxyz012345678901234';
const CONFIG_KEY = 'ab'.repeat(56);

const PUBLIC_LINK = `https://app.quorummessenger.com/invite/#spaceId=${SPACE_ID}&configKey=${CONFIG_KEY}`;
const ONE_TIME_LINK = `${PUBLIC_LINK}&template=abcdef&secret=123456&hubKey=deadbeef`;
/** What kickUser leaves behind in the very same field. */
const AFTER_KICK = `quorum://join#spaceId=${SPACE_ID}&configKey=${CONFIG_KEY}`;

function setUp({ isOwner, inviteUrl }: { isOwner: boolean; inviteUrl?: string }) {
  const g = globalThis as Record<string, unknown>;
  g.__isOwner = isOwner;
  g.__space = { spaceId: SPACE_ID, spaceName: 'Test Space', inviteUrl };
}

const canInvite = () => renderHook(() => useCanInviteToSpace(SPACE_ID)).result.current;

describe('who may invite to a space', () => {
  describe('an owner', () => {
    it('may invite even before any link exists, because they can mint one', () => {
      setUp({ isOwner: true, inviteUrl: undefined });
      expect(canInvite()).toBe(true);
    });

    it('may invite after a kick has clobbered inviteUrl', () => {
      // The owner's entry point must not disappear just because the field holds
      // a value the SHARING rule rejects — they can always republish.
      setUp({ isOwner: true, inviteUrl: AFTER_KICK });
      expect(canInvite()).toBe(true);
    });
  });

  describe('a regular member', () => {
    it('may share an existing public link', () => {
      // The capability the first version of this fix would have deleted.
      setUp({ isOwner: false, inviteUrl: PUBLIC_LINK });
      expect(canInvite()).toBe(true);
    });

    it('is not offered an invite button when the space has no link', () => {
      // Every generate path throws for them, so the button could only ever
      // produce an internal error string.
      setUp({ isOwner: false, inviteUrl: undefined });
      expect(canInvite()).toBe(false);
    });

    it('is not offered the dead quorum:// URL that kickUser writes', () => {
      // Truthy, same field. This is the case a `!!space.inviteUrl` gate gets
      // wrong, and it is silent: the member sees a normal-looking share screen.
      setUp({ isOwner: false, inviteUrl: AFTER_KICK });
      expect(canInvite()).toBe(false);
    });

    it('is not offered a one-time link left in the field', () => {
      // A one-time link is consumed by its first user, so handing it to a member
      // to share would burn the owner's invite slot on whoever clicks first.
      setUp({ isOwner: false, inviteUrl: ONE_TIME_LINK });
      expect(canInvite()).toBe(false);
    });
  });
});

describe('the space overview banner', () => {
  const space = { spaceId: SPACE_ID, spaceName: 'Test Space' } as unknown as Space;

  const renderBanner = (onInvite?: () => void) =>
    render(
      <CustomThemeProvider defaultAccentColor="blue" defaultAppearance="dark">
        <SpaceBannerHeader
          space={space}
          insetTop={0}
          onBack={() => {}}
          onInvite={onInvite}
          onSettings={() => {}}
          onDescriptionPress={() => {}}
        />
      </CustomThemeProvider>
    );

  it('hides the invite pill when the caller passes no handler', () => {
    // `onInvite` was a REQUIRED prop, so the type system actively prevented the
    // caller from gating this screen. That is why it stayed ungated while the
    // other two entry points were fixed.
    renderBanner(undefined);
    expect(screen.queryByLabelText('Invite people')).toBeNull();
  });

  it('still renders the settings pill, so the row is not left empty', () => {
    renderBanner(undefined);
    expect(screen.getByLabelText('Space settings')).toBeTruthy();
  });

  it('shows the invite pill when a handler is passed', () => {
    renderBanner(() => {});
    expect(screen.getByLabelText('Invite people')).toBeTruthy();
  });
});
