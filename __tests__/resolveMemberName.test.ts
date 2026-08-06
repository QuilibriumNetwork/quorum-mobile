import {
  resolveMemberName,
  resolveMemberAvatar,
  formatResolvedName,
  type ResolvableMember,
  type SelfIdentity,
} from '@/utils/resolveMemberName';

/**
 * The symptom this file pins: one space, one moment, one member rendering two
 * different ways. Their messages showed a name and avatar; the member list
 * showed a bare address. Both surfaces held the same row and disagreed because
 * each had grown its own copy of the precedence rule.
 *
 * These cases are the rule. The two that matter most in practice are the
 * follow-global default (empty override must fall to the global slot, not to
 * the address) and the ordering between an override and the QNS name — a
 * per-space name a user deliberately set has to keep winning, or every space
 * with custom names silently reverts to `.q` handles.
 */

const ADDRESS = 'QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco';

const member = (over: Partial<ResolvableMember> = {}): ResolvableMember => ({
  address: ADDRESS,
  ...over,
});

const self: SelfIdentity = {
  address: ADDRESS,
  displayName: 'Live Profile Name',
  username: 'live-username',
  profileImage: 'live-avatar',
};

describe('resolveMemberName — the ladder', () => {
  it('prefers a deliberate per-space override above everything else', () => {
    const resolved = resolveMemberName(
      member({
        display_name: 'Per Space Name',
        primary_username: 'qnsname',
        global_display_name: 'Global Name',
      }),
    );
    expect(resolved).toEqual({
      name: 'Per Space Name',
      isQnsVerified: false,
      isAddressFallback: false,
    });
  });

  it('prefers the QNS name over the global slot', () => {
    const resolved = resolveMemberName(
      member({ primary_username: 'qnsname', global_display_name: 'Global Name' }),
    );
    expect(resolved).toEqual({
      name: 'qnsname',
      isQnsVerified: true,
      isAddressFallback: false,
    });
  });

  it('falls to the global slot when there is no override and no QNS name', () => {
    // The follow-global default. An empty override is the COMMON case, not an
    // edge case: this is the rung that stops most members rendering as addresses.
    const resolved = resolveMemberName(member({ global_display_name: 'Global Name' }));
    expect(resolved).toEqual({
      name: 'Global Name',
      isQnsVerified: false,
      isAddressFallback: false,
    });
  });

  it('treats the SDK `name` alias as sitting in the override tier', () => {
    const resolved = resolveMemberName(
      member({ name: 'Wire Name', global_display_name: 'Global Name' }),
    );
    expect(resolved.name).toBe('Wire Name');
  });

  it('prefers display_name over the `name` alias within the override tier', () => {
    const resolved = resolveMemberName(
      member({ display_name: 'Override', name: 'Wire Name' }),
    );
    expect(resolved.name).toBe('Override');
  });

  it('falls back to the truncated address when nothing resolves', () => {
    const resolved = resolveMemberName(member());
    expect(resolved.isQnsVerified).toBe(false);
    expect(resolved.isAddressFallback).toBe(true);
    expect(resolved.name).not.toBe(ADDRESS);
    expect(resolved.name.length).toBeLessThan(ADDRESS.length);
  });

  it('flags a resolved name as NOT an address fallback', () => {
    // Screens use this to tell "we know who this is" from "we don't". Getting it
    // backwards would put address initials on every avatar.
    expect(resolveMemberName(member({ global_display_name: 'X' })).isAddressFallback).toBe(
      false,
    );
    expect(resolveMemberName(member(), { self }).isAddressFallback).toBe(false);
  });

  it('keeps the Qm-aware address format instead of shared\'s naive slice', () => {
    // Shared truncates `slice(0,6)…slice(-4)`, which would render the constant
    // "QmXoyp" prefix and no entropy. Mobile counts AFTER the Qm prefix, and is
    // parity-matched with desktop. Regressing this would change every address
    // label in the app, silently.
    const resolved = resolveMemberName(member());
    expect(resolved.name).not.toBe('QmXoyp…6uco');
    expect(resolved.name.startsWith('Qm')).toBe(true);
  });
});

describe('resolveMemberName — empty strings mean "unset"', () => {
  it('falls through an empty override to the global slot', () => {
    const resolved = resolveMemberName(
      member({ display_name: '', global_display_name: 'Global Name' }),
    );
    expect(resolved.name).toBe('Global Name');
  });

  it('falls through a whitespace-only override to the global slot', () => {
    const resolved = resolveMemberName(
      member({ display_name: '   ', global_display_name: 'Global Name' }),
    );
    expect(resolved.name).toBe('Global Name');
  });

  it('falls through an empty global slot to the address', () => {
    const resolved = resolveMemberName(member({ global_display_name: '' }));
    expect(resolved.name.length).toBeLessThan(ADDRESS.length);
  });

  it('falls through a whitespace-only display_name to the `name` alias', () => {
    const resolved = resolveMemberName(member({ display_name: '  ', name: 'Wire Name' }));
    expect(resolved.name).toBe('Wire Name');
  });

  it('treats explicit null the same as absent', () => {
    // Rows arrive from several queries; some write null where others omit.
    const resolved = resolveMemberName(
      member({ display_name: null, name: null, global_display_name: 'Global Name' }),
    );
    expect(resolved.name).toBe('Global Name');
  });
});

describe('resolveMemberName — the self tier', () => {
  it('uses the live profile for your own row when the space has no identity yet', () => {
    // A space created AFTER your last profile save has nothing stored for you.
    // Without this arm the space owner reads as an address in their own space.
    const resolved = resolveMemberName(member(), { self });
    expect(resolved.name).toBe('Live Profile Name');
  });

  it('falls to the live username when the live display name is unset', () => {
    const resolved = resolveMemberName(member(), {
      self: { ...self, displayName: undefined },
    });
    expect(resolved.name).toBe('live-username');
  });

  it('does not let the live profile outrank stored identity', () => {
    const resolved = resolveMemberName(member({ global_display_name: 'Stored' }), {
      self,
    });
    expect(resolved.name).toBe('Stored');
  });

  it('never applies the self tier to somebody else', () => {
    const resolved = resolveMemberName(member({ address: 'QmSomeoneElseEntirely' }), {
      self,
    });
    expect(resolved.name).not.toBe('Live Profile Name');
  });

  it('falls to the address when self is not passed at all', () => {
    const resolved = resolveMemberName(member());
    expect(resolved.name).not.toBe('Live Profile Name');
  });
});

describe('resolveMemberAvatar — a separate ladder with no QNS step', () => {
  it('prefers the per-space override avatar', () => {
    expect(
      resolveMemberAvatar(
        member({ profile_image: 'override-avatar', global_profile_image: 'global-avatar' }),
      ),
    ).toBe('override-avatar');
  });

  it('falls to the global slot avatar', () => {
    expect(resolveMemberAvatar(member({ global_profile_image: 'global-avatar' }))).toBe(
      'global-avatar',
    );
  });

  it('uses the live profile avatar for your own row', () => {
    expect(resolveMemberAvatar(member(), { self })).toBe('live-avatar');
  });

  it('returns undefined when nothing resolves, so callers keep their placeholder', () => {
    expect(resolveMemberAvatar(member())).toBeUndefined();
  });

  it('ignores the QNS name entirely — a .q handle carries no picture', () => {
    expect(resolveMemberAvatar(member({ primary_username: 'qnsname' }))).toBeUndefined();
  });

  it('treats an empty override avatar as unset', () => {
    expect(
      resolveMemberAvatar(member({ profile_image: '', global_profile_image: 'global-avatar' })),
    ).toBe('global-avatar');
  });

  it('does not let your live avatar outrank a stored one on your own row', () => {
    expect(resolveMemberAvatar(member({ profile_image: 'stored' }), { self })).toBe('stored');
    expect(
      resolveMemberAvatar(member({ global_profile_image: 'stored-global' }), { self }),
    ).toBe('stored-global');
  });
});

describe('formatResolvedName', () => {
  it('appends .q only to a verified QNS name', () => {
    expect(
      formatResolvedName({ name: 'qnsname', isQnsVerified: true, isAddressFallback: false }),
    ).toBe('qnsname.q');
    expect(
      formatResolvedName({
        name: 'Global Name',
        isQnsVerified: false,
        isAddressFallback: false,
      }),
    ).toBe('Global Name');
  });
});

describe('the surfaces agree', () => {
  // The actual regression. Chat resolved via one path and the member list via
  // another; the member list skipped the global slot, so a follow-global member
  // rendered as an address there and as a name three inches away.
  //
  // Calling the same pure function four times would prove nothing, so these
  // reproduce how each SCREEN builds the row it passes in. The reaction list,
  // the markdown mention renderer and the blocked-user list all substitute a
  // bare `{ address }` when the member is absent from their map; the member
  // list passes the roster row plus the viewer's own profile. Those different
  // constructions are where the four ladders used to diverge.
  const asReactionRow = (m?: ResolvableMember) => m ?? { address: ADDRESS };
  const asMentionRow = (m?: ResolvableMember) => m ?? { address: ADDRESS };
  const asBlockedRow = (m?: ResolvableMember) => m ?? { address: ADDRESS };

  it('gives one answer for a follow-global member on every screen', () => {
    const row = member({ global_display_name: 'Global Name' });

    const memberList = resolveMemberName(row, { self });
    const reactions = resolveMemberName(asReactionRow(row));
    const mentions = resolveMemberName(asMentionRow(row));
    const blocked = resolveMemberName(asBlockedRow(row));

    expect(memberList.name).toBe('Global Name');
    expect(reactions.name).toBe('Global Name');
    expect(mentions.name).toBe('Global Name');
    expect(blocked.name).toBe('Global Name');
  });

  it('gives one answer when the member is missing from a screen\'s map entirely', () => {
    // Each screen substitutes a bare `{ address }` row. They must all land on
    // the same truncated address rather than one showing a full address, one
    // "Unknown", and one a differently-truncated string.
    const reactions = resolveMemberName(asReactionRow());
    const mentions = resolveMemberName(asMentionRow());
    const blocked = resolveMemberName(asBlockedRow());

    expect(reactions.isAddressFallback).toBe(true);
    expect(mentions).toEqual(reactions);
    expect(blocked).toEqual(reactions);
    expect(reactions.name).not.toContain(ADDRESS);
  });

  it('resolves a bare {address} row identically to a roster row with empty slots', () => {
    // The screens' `m ?? { address }` shortcut must not be a different code
    // path from a real row whose slots are all blank.
    const bare = resolveMemberName({ address: ADDRESS });
    const empty = resolveMemberName(
      member({ display_name: '', name: '', global_display_name: '' }),
    );
    expect(bare).toEqual(empty);
  });

  it('only the member list applies the self tier, and that is deliberate', () => {
    // The member list passes `self`; the chat surfaces do not, because there
    // your identity reached the roster the moment you posted. If this ever
    // flips, the two surfaces disagree about YOUR name specifically.
    const own = member();
    expect(resolveMemberName(own, { self }).name).toBe('Live Profile Name');
    expect(resolveMemberName(asReactionRow(own)).isAddressFallback).toBe(true);
  });
});

describe('an override that only echoes the global name', () => {
  // Both join paths and config sync used to stamp the member's GLOBAL name
  // straight into the per-space override, where it outranked their `.q`
  // permanently. The write side is fixed; this is what heals the rows already
  // written that way.

  it('lets the QNS name through when the override just repeats the global name', () => {
    const resolved = resolveMemberName({
      address: ADDRESS,
      display_name: 'Alice',
      global_display_name: 'Alice',
      primary_username: 'alice',
    });

    expect(resolved.name).toBe('alice');
    expect(resolved.isQnsVerified).toBe(true);
  });

  it('still lets a genuinely different per-space name outrank the QNS name', () => {
    // The tier exists for exactly this: a name chosen for this space wins.
    const resolved = resolveMemberName({
      address: ADDRESS,
      display_name: 'Alice (mod)',
      global_display_name: 'Alice',
      primary_username: 'alice',
    });

    expect(resolved.name).toBe('Alice (mod)');
    expect(resolved.isQnsVerified).toBe(false);
  });

  it('keeps the override when there is no global name to compare against', () => {
    // Nothing to call it an echo OF. Demoting on a missing global would blank
    // the name for every member whose global slot has not arrived yet.
    const resolved = resolveMemberName({ address: ADDRESS, display_name: 'Alice' });

    expect(resolved.name).toBe('Alice');
  });

  it('falls through to the global name when the echo is demoted and no QNS exists', () => {
    // Same string either way, but via the global tier — so a later global
    // rename reaches this member instead of being masked.
    const resolved = resolveMemberName({
      address: ADDRESS,
      display_name: 'Alice',
      global_display_name: 'Alice',
    });

    expect(resolved.name).toBe('Alice');
    expect(resolved.isAddressFallback).toBe(false);
  });

  it('compares after trimming, so whitespace does not disguise an echo', () => {
    const resolved = resolveMemberName({
      address: ADDRESS,
      display_name: '  Alice  ',
      global_display_name: 'Alice',
      primary_username: 'alice',
    });

    expect(resolved.name).toBe('alice');
  });
});

describe('a name that tries to forge the verified-QNS marker', () => {
  // `.q` is appended at render only for the QNS tier, and display names are
  // forbidden from ending in it. But that validator runs on local text inputs
  // and never on receive, and `isQnsVerified` is not surfaced anywhere — so the
  // suffix is the only signal a viewer has. A modified client broadcasting
  // `display_name: "alice.q"` would otherwise render identically to the real
  // holder of `alice`.

  it('drops a per-space name ending in .q', () => {
    const resolved = resolveMemberName({
      address: ADDRESS,
      display_name: 'alice.q',
      global_display_name: 'Mallory',
    });

    expect(resolved.name).toBe('Mallory');
    expect(resolved.isQnsVerified).toBe(false);
  });

  it('drops a global name ending in .q', () => {
    const resolved = resolveMemberName({ address: ADDRESS, global_display_name: 'alice.q' });

    // Fail closed: no name at all rather than a forged one.
    expect(resolved.isAddressFallback).toBe(true);
  });

  it('folds confusable unicode dots, so a lookalike cannot slip through', () => {
    // Shared's helper normalises these; a hand-rolled endsWith('.q') would not.
    const resolved = resolveMemberName({
      address: ADDRESS,
      display_name: 'alice\u2024q',
      global_display_name: 'Mallory',
    });

    expect(resolved.name).toBe('Mallory');
  });

  it('is case and whitespace insensitive', () => {
    expect(
      resolveMemberName({ address: ADDRESS, display_name: '  Alice.Q  ', global_display_name: 'Mallory' }).name,
    ).toBe('Mallory');
  });

  it('rejects a QNS field that already carries the suffix, rather than rendering .q.q', () => {
    const resolved = resolveMemberName({
      address: ADDRESS,
      primary_username: 'alice.q',
      global_display_name: 'Mallory',
    });

    expect(resolved.name).toBe('Mallory');
    expect(resolved.isQnsVerified).toBe(false);
  });

  it('leaves an ordinary name containing a dot alone', () => {
    // Only the SUFFIX is reserved. "Q." and ".q Corp" are ordinary names.
    expect(
      resolveMemberName({ address: ADDRESS, display_name: 'alice.q Corp' }).name,
    ).toBe('alice.q Corp');
    expect(resolveMemberName({ address: ADDRESS, display_name: 'R.Q. Jones' }).name).toBe('R.Q. Jones');
  });
});
