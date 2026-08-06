/**
 * A freshly-joined member must render as a NAME on every surface, in the state
 * production is actually in.
 *
 * ## Why this exists, and why it is the most important test in this area
 *
 * Joining a space used to stamp the joiner's GLOBAL name into everyone's
 * per-space OVERRIDE slot. That was fixed — the join now writes the global slot
 * where it belongs. But the fix moves WHERE a name is stored, and it does that
 * for every user whether or not anybody has a `.q`. So any surface still
 * reading the override slot by hand stops finding a name and falls back to a
 * truncated address.
 *
 * That is the one regression this whole body of work can plausibly ship to
 * production, and it would look like "some people show as `Qm7f3a…` right after
 * they join". Three such surfaces were found and fixed by hand; "we found them
 * all" was inference, not measurement. This file is the measurement.
 *
 * ## What makes it different from the per-function tests
 *
 * It does not construct a member row by hand. It calls the REAL
 * `buildJoinedMemberRow` and feeds its actual output through every
 * name-producing path in the app. A hand-written fixture can drift from what
 * the join really stores; this cannot.
 *
 * ## The two scenarios
 *
 * **Production today** — no `primary_username` anywhere, because the server
 * rejects every publish that carries one. This is the state a release ships
 * into, so it is tested first and in the most detail.
 *
 * **After the server is fixed** — the same row plus a `.q` arriving on the
 * public profile. Tested so the tier that is currently unreachable does not rot
 * while it waits.
 */

// The member-merge module reaches the API client, which pulls in MMKV (and a
// native module) at import time. Stub the storage rather than restructure
// production code around a test constraint.
jest.mock('react-native-mmkv', () => ({
  createMMKV: () => {
    const store = new Map<string, string>();
    return {
      getString: (k: string) => store.get(k),
      set: (k: string, v: string) => store.set(k, v),
      remove: (k: string) => store.delete(k),
      getAllKeys: () => Array.from(store.keys()),
      clearAll: () => store.clear(),
      contains: (k: string) => store.has(k),
    };
  },
}));

import { buildJoinedMemberRow } from '../services/space/joinedMemberRow';
import {
  formatResolvedName,
  resolveMemberAvatar,
  resolveMemberName,
} from '../utils/resolveMemberName';
import { messageSenderName } from '../utils/messagePreview';
import { resolveConversationTitle } from '../utils/conversationTitle';
import {
  membersWithEffectiveIdentity,
  mergeMemberIdentity,
} from '../hooks/useMembersWithPublicProfileFallback';
import type { MemberMap } from '../components/Chat/types';

const JOINER = 'QmPeerAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';
const VIEWER = 'QmPeerBEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';
const NOW = 1_700_000_000_000;

/** Exactly what a `join` control message carries, routed through the real builder. */
const joinedRow = () =>
  buildJoinedMemberRow(
    undefined,
    {
      address: JOINER,
      inboxAddress: 'QmInboxAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4im',
      displayName: 'Alice',
      userIcon: 'https://example.invalid/alice.png',
    },
    NOW,
  );

describe('a freshly-joined member, in the state production is in today', () => {
  it('is stored in the GLOBAL slot with the override left empty', () => {
    // Pins the shape every assertion below depends on. If this ever fails, the
    // rest of this file is testing something other than what the join stores.
    const row = joinedRow();
    expect(row.global_display_name).toBe('Alice');
    expect(row.display_name).toBeUndefined();
    expect(row.name).toBeUndefined();

    // Read through a cast on purpose. The join row's type does not declare
    // `primary_username` at all, which is the type system stating the rule
    // correctly: a `.q` travels only in a published public profile, so a join
    // can never carry one. The runtime assertion pins that the builder does not
    // invent one anyway — the type would not stop it adding a stray field.
    expect((row as Record<string, unknown>).primary_username).toBeUndefined();
  });

  it('renders a name through the resolver, not an address', () => {
    // Covers the space member list, the profile modal, reaction details and the
    // rendered mention pill — everything that calls the resolver directly.
    const resolved = resolveMemberName({ ...joinedRow(), address: JOINER });
    expect(resolved.name).toBe('Alice');
    expect(resolved.isAddressFallback).toBe(false);
    expect(formatResolvedName(resolved)).toBe('Alice');
  });

  it('renders a name on preview rows', () => {
    // Space activity, and the author prefix on a mention or reply in the
    // Notifications tab. This surface read the override slot by hand and was
    // the first casualty of the join fix.
    const row = joinedRow();
    expect(
      messageSenderName(JOINER, VIEWER, { [JOINER]: row as never }),
    ).toBe('Alice');
  });

  it('renders a name after the public-profile merge, even with no profile', () => {
    // The chat member map. A member with no published profile is the common
    // case, and the merge must not blank the global slot on the way through.
    const merged = mergeMemberIdentity(JOINER, joinedRow() as never, null);
    const resolved = resolveMemberName({
      ...(merged ?? joinedRow()),
      address: JOINER,
    } as never);
    expect(resolved.name).toBe('Alice');
    expect(resolved.isAddressFallback).toBe(false);
  });

  it('renders a name through the mention projection', () => {
    // The `@` autocomplete and the pill both read the roster array projected
    // through the effective map.
    const row = joinedRow();
    const projected = membersWithEffectiveIdentity([row as never], {
      [JOINER]: row,
    } as unknown as MemberMap)!;
    const resolved = resolveMemberName({ ...projected[0], address: JOINER } as never);
    expect(resolved.name).toBe('Alice');
    expect(resolved.isAddressFallback).toBe(false);
  });

  it('still resolves an avatar', () => {
    // The avatar ladder is separate from the name ladder and reads the same two
    // slots, so the join change could have broken it independently.
    expect(resolveMemberAvatar({ ...joinedRow(), address: JOINER })).toBe(
      'https://example.invalid/alice.png',
    );
  });

  it('names a DM partner from their broadcast global name', () => {
    // Not a join row — a DM has no roster — but the same production state: a
    // global name and no `.q`.
    expect(
      resolveConversationTitle({ address: JOINER, displayName: 'Alice' }),
    ).toBe('Alice');
  });
});

describe('the same member once the server stops rejecting a .q', () => {
  it('lets the .q win everywhere the global name won before', () => {
    // The tier that is unreachable in production today. Tested so it does not
    // rot while it waits on the server fix.
    const withQns = { ...joinedRow(), primary_username: 'alice', address: JOINER };

    expect(formatResolvedName(resolveMemberName(withQns as never))).toBe('alice.q');
    expect(messageSenderName(JOINER, VIEWER, { [JOINER]: withQns as never })).toBe(
      'alice.q',
    );
    expect(
      resolveConversationTitle({
        address: JOINER,
        displayName: 'Alice',
        primary_username: 'alice',
      }),
    ).toBe('alice.q');
  });

  it('arrives via the public profile, which is its only carrier', () => {
    // The `.q` is not on the join row and never will be. It reaches a member
    // only through this merge.
    const merged = mergeMemberIdentity(JOINER, joinedRow() as never, {
      display_name: 'Alice',
      profile_image: '',
      bio: '',
      primary_username: 'alice',
      timestamp: NOW,
      signature: '',
    } as never);
    expect(merged).not.toBeNull();
    expect(
      formatResolvedName(resolveMemberName({ ...merged!, address: JOINER } as never)),
    ).toBe('alice.q');
  });

  it('still lets a DELIBERATE per-space name outrank the .q', () => {
    // The ladder's top rung. A name chosen for this space is the one thing that
    // beats a `.q`, and the echo demotion must not have swallowed it.
    const row = {
      ...joinedRow(),
      display_name: 'Mod Alice',
      primary_username: 'alice',
      address: JOINER,
    };
    expect(formatResolvedName(resolveMemberName(row as never))).toBe('Mod Alice');
  });
});
