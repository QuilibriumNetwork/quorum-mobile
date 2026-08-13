/**
 * A render-layer file may not read a member's name field raw.
 *
 * ## Why this exists alongside `noRawOverrideReadsInUi`
 *
 * That test asks a narrower question — "does anything read the per-space
 * OVERRIDE slot by hand" — and is still the right test for the two-slot bug it
 * was built for. It matches `display_name` in snake_case only.
 *
 * Which is exactly how it missed the bug this repo actually shipped.
 * `ShareInviteSheet` renders `conv.displayName` — camelCase, off a conversation
 * row rather than a roster row — and never calls the resolver at all. Snake_case
 * matching could not see it. Neither could a work-list derived from "which files
 * import the resolver", because the defect IS not importing it. Desktop learned
 * the same thing the expensive way: its import-derived migration table missed
 * roughly 40% of the surfaces that turned out to need work.
 *
 * ## The rule
 *
 * A file under a scanned root is an offense when it BOTH:
 *
 *   (a) references one of the raw name fields below as an identifier, AND
 *   (b) imports nothing from the resolver module.
 *
 * Condition (b) is the load-bearing half. A file that already resolves and also
 * happens to carry a prop named `displayName` — an avatar handed an
 * already-resolved bare name — is not the defect. The defect is a raw field
 * reaching the screen with no resolver anywhere in the file.
 *
 * ## Two lists, and the difference matters
 *
 * `EXCEPTIONS` are permanent: the file reads a name that is genuinely not a
 * Quorum member's, or writes one rather than rendering it.
 *
 * `TO_MIGRATE` is a RATCHET. Every entry is a real defect with a plan row
 * waiting for it. Remove your file as part of migrating it, and never add one.
 * The list shrinking to empty is what "done" means for the identity work.
 *
 * Both keep the suite green today. What the test catches is a NEW file joining
 * either list without anybody noticing.
 *
 * ## Honesty, not coverage
 *
 * This is a grep-shaped heuristic, not a type-aware linter. It cannot tell a
 * resolved local named `displayName` from a raw prop of the same name in a file
 * that imports the resolver for an unrelated reason, and it cannot see through a
 * re-export. It exists to make the CLASS loud again, not to replace review.
 * Every entry needs a one-line reason a reviewer can check against the file — a
 * rubber stamp defeats the whole thing.
 *
 * ## When the identity module lands
 *
 * `RESOLVER_IMPORT` points at today's seam, `utils/resolveMemberName` and its
 * siblings. Repoint it at the identity module when that exists; the rule does
 * not change.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const SCAN_ROOTS = ['components', 'app'];

/**
 * Both spellings of every tier. `global_display_name` is included deliberately
 * even though it is the GLOBAL slot and safe to read inside the resolver: read
 * raw at a render site it still bypasses the QNS tier ranked above it. Same
 * defect, one rung down.
 *
 * `recipientDisplayName`/`callerDisplayName` are the call-payload spellings —
 * camelCase concatenation means the plain `displayName` alternative above
 * cannot see them (no `\b` boundary inside one unbroken word token), so they
 * are listed by name. The three Call screens that used to read these raw are
 * now migrated (see `__tests__/migrated/CallScreens.test.tsx`) and carry zero
 * matches; both spellings stay in the pattern so a regression at that exact
 * call site — reading the payload field again instead of resolving from its
 * address — is caught rather than going invisible to the plain `displayName`
 * alternative.
 */
const RAW_FIELD =
  /\b(displayName|primaryUsername|globalDisplayName|display_name|primary_username|global_display_name|recipientDisplayName|callerDisplayName)\b/;

/**
 * The identity module lands. Every scanned surface resolves through
 * `@/identity` now — the barrel, or one of its own files reached directly
 * (`@/identity/useResolvedName`, `@/identity/RootIdentityScope`). A file that
 * still imports only the old `@/utils/resolveMemberName` seam loses its pass:
 * that seam remains real (the receive-path files below still use it, by
 * design, outside React) but a render-layer file sitting on it alone is a
 * surface the migration missed, not a legitimate holdout.
 */
const RESOLVER_IMPORT = /from\s+['"]@\/identity(\/[\w/]*)?['"]/;

/**
 * `SomeComponent.displayName = 'SomeComponent'` is React's devtools idiom and
 * has nothing to do with a member's name. Stripped rather than listed, or every
 * new `memo`/`forwardRef` component would need a fresh entry forever.
 */
const REACT_DEVTOOLS_DISPLAYNAME = /\b[\w.]+\.displayName\s*=\s*(['"])[^'"]*\1\s*;?/g;

/**
 * Permanent. The file reads a name that is not a Quorum member's, or writes one
 * rather than rendering it.
 */
const EXCEPTIONS: Record<string, string> = {
  // ── Farcaster is a SEPARATE identity namespace ──────────────────────────
  // fid / username / displayName, no address, no roster, no `.q`. It looks
  // identical to this grep and must never be routed through the member
  // resolver — doing so would resolve a Farcaster author against Quorum
  // rosters and render somebody else's name.
  'components/AudioSpaceOverlay.tsx':
    'Farcaster identities throughout (p.user, m.author, replyTarget.author), falling back to `fid:<n>`. No Quorum member is rendered here.',
  'components/BoundChannelFeedPanel.tsx':
    'Renders `cast.author` — a Farcaster cast author, not a space member.',
  'components/Chat/FarcasterCastCard.tsx':
    'Renders `cast.author`; the other hit is a StyleSheet key literally named `displayName`.',
  'components/Chat/types.ts':
    'Two unrelated things share this file. `directCastToDisplayMessage` and `castToDisplayMessage` (lines 571, 583, 590, 645, 670) read Farcaster `senderContext`/`actionTargetUserContext`/`cast.author` fields — a Farcaster identity, not a Quorum member, same class as `FarcasterCastCard.tsx` above. Separately, `toDisplayMessage` resolves a Quorum member through the PURE `resolveMemberName`/`formatResolvedName` from `@/utils/resolveMemberName`, by design: it is a plain data-transform function called from inside `.map()` in `DMChatArea.tsx`/`SpaceChatArea.tsx`, not a component, so it cannot call a hook — the same reason `utils/messagePreview.ts` and `services/notifications/logMentionOrReply.ts` stay on the pure API. Its per-space/global tiers read the identical roster row every other surface reads; the QNS tier is structurally inert here because `SpaceMember` (this file’s `MemberMap` value type) never carries `primary_username`, so nothing forgeable can reach the `.q` suffix. The one place this result could go stale in a way that matters — the per-message sender header — is already overridden: `MessagesList.tsx` resolves that live through `@/identity` instead of trusting `item.userName`.',
  'components/MiniAppsModal.tsx':
    'Renders a mini-app FRAME author from Farcaster metadata, not a Quorum member.',
  'components/SocialFeed/content/LiveSpacesStrip.tsx':
    'Farcaster space host, falling back to `fid:<n>`.',
  'components/SocialFeed/content/QuoteCast.tsx':
    'Renders a quoted Farcaster cast author; the other hit is a StyleSheet key.',
  'components/SocialFeed/MentionAutocomplete.tsx':
    'Farcaster mention autocomplete — matches Farcaster handles, never space members.',
  'components/SocialFeed/ProfileActionButtons.tsx':
    'Threads a Farcaster display name into `fcDisplayName`; no Quorum identity involved.',
  'components/SocialFeed/views/ChannelView.tsx':
    'Renders Farcaster cast authors in a channel feed.',
  'components/SocialFeed/views/ProfileView.tsx':
    'Renders a Farcaster profile and that author’s casts; the remaining hits are StyleSheet keys.',
  'components/SocialFeed/views/ThreadDetailView.tsx':
    'Renders Farcaster cast authors in a thread; the remaining hits are StyleSheet keys.',
  'components/Chat/FarcasterDirectMessageView.tsx':
    'RECLASSIFIED, not migrated: this component only ever renders when `isFarcasterConversation` is true (`app/(tabs)/messages/dm/[id].tsx:500-518`), and every Farcaster conversation — real or the synthetic one built for a first-time DM — carries a synthetic `fid:<n>` address (`hooks/chat/useFarcasterDirectCasts.ts:73`; the synthetic branch at `app/(tabs)/messages/dm/[id].tsx:126`). So `conversation.displayName` here is Farcaster’s OWN conversation-title field (`fc.name ?? counterParty?.displayName ?? counterParty?.username`, same hook, line 75), never a Quorum name — routing it through `@/identity` would treat that `fid:<n>` string as a member address and, per the identity module’s own warning, could render somebody else’s name. Per-message sender names (this file’s other Farcaster reads) go through `directCastToDisplayMessage` unchanged, out of this file.',
  // ── ROLE names are a different entity that shares the field name ────────
  'components/Chat/ChannelManagerRolePickerSheet.tsx':
    'Renders `role.displayName` — a channel ROLE’s name, which has no ladder and no QNS tier.',
  'components/Chat/ChannelSettingsSheet.tsx':
    'Maps role ids to `role.displayName`. Roles, not members.',

  // ── WRITE paths: the raw field is the thing being edited ────────────────
  'components/ProfileModal.tsx':
    'Your OWN profile editor — holds `user.displayName` in form state and writes it back. Editing a name is not rendering somebody else’s.',
  'components/UnifiedProfileEditModal.tsx':
    'Writes the display name as part of saving a profile.',
  'components/UnifiedProfileScreen.tsx':
    'Syncs names BETWEEN the Quorum and Farcaster profiles; both raw values are the subject of the comparison, not a rendered name.',
  'components/qns/NameDetailModal.tsx':
    'Writes `primaryUsername: NO_PRIMARY_NAME` to un-elect a QNS name.',
  'components/dev/QnsFakePanel.tsx':
    'Dev-only overlay that WRITES synthetic `primaryUsername` values to exercise the QNS surfaces. Gated on __DEV__.',
  'app/(onboarding)/complete.tsx':
    'Onboarding writes the display name it just collected.',
  'app/(onboarding)/farcaster-setup.tsx':
    'Onboarding writes the Farcaster display name it just collected.',
  'app/(onboarding)/profile-setup.tsx':
    'Onboarding collects and writes your own display name; there is no member to resolve yet.',

  // ── Not a member-name read at all ───────────────────────────────────────
  'components/NewConversationModal.tsx':
    'Builds a placeholder label `@<typed username>` for a conversation being created, before any member exists to resolve.',
};

/**
 * The RATCHET. Every entry is a real defect. Remove yours as part of migrating
 * it; never add one.
 *
 * Empty: Phase D's last row (`DMChatArea.tsx`) moved to `EXCEPTIONS` above —
 * its one remaining raw match is a deliberate write, not outstanding work.
 * Stays declared (rather than deleted) so `KNOWN`/`sourceFiles` below need no
 * shape change the next time this list is non-empty.
 */
const TO_MIGRATE: Record<string, string> = {};

/**
 * `identity/` itself sits outside `SCAN_ROOTS` today (it is a sibling of
 * `components`/`app`, not nested under either), so this exclusion changes no
 * behaviour right now. It is declared explicitly anyway: `identity/`'s own
 * files — `identityFromMaps.ts`, `identityProvider.tsx`, `RootIdentityScope.tsx`
 * — read the raw tiers directly because assembling the ladder IS their job, and
 * none of them import `@/identity` (they ARE `@/identity`), so they would fail
 * this audit on sight if a future SCAN_ROOTS ever swept them in. The exclusion
 * makes that impossible rather than relying on the roots list never changing.
 */
const SCAN_EXCLUDED_DIRS = ['node_modules', 'identity'];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SCAN_EXCLUDED_DIRS.includes(entry) || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/** Exported so the rule can be exercised directly, without walking the tree. */
export function offendingLines(source: string): number[] {
  const stripped = source.replace(REACT_DEVTOOLS_DISPLAYNAME, '');
  if (RESOLVER_IMPORT.test(stripped)) return [];
  return stripped
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !isCommentLine(line) && RAW_FIELD.test(line))
    .map(({ n }) => n);
}

const KNOWN = { ...EXCEPTIONS, ...TO_MIGRATE };

describe('no render-layer file reads a member name field raw', () => {
  it('finds only files that are already known, each with a stated reason', () => {
    const offenders: string[] = [];

    for (const root of SCAN_ROOTS) {
      for (const file of sourceFiles(root)) {
        const rel = file.split(/[\\/]/).join('/');
        if (KNOWN[rel]) continue;
        const lines = offendingLines(readFileSync(file, 'utf8'));
        if (lines.length) offenders.push(`${rel}:${lines.slice(0, 6).join(',')}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('has no stale entries', () => {
    // An entry left behind after its file stopped reading a raw field quietly
    // re-permits the whole file. For TO_MIGRATE it is worse than untidy: a
    // migrated file still listed means the ratchet reports work outstanding
    // that is already done, and the list stops meaning anything.
    const stale = Object.keys(KNOWN).filter((rel) => {
      let content: string;
      try {
        content = readFileSync(rel, 'utf8');
      } catch {
        return true; // moved or deleted — the entry is dead either way
      }
      return offendingLines(content).length === 0;
    });

    expect(stale).toEqual([]);
  });

  it('states a reason for every entry', () => {
    for (const [rel, reason] of Object.entries(KNOWN)) {
      expect(reason.length).toBeGreaterThan(40);
      expect(rel).toMatch(/\.tsx?$/);
    }
  });

  it('is not vacuous — the rule fires on a raw read and stays quiet on a resolved one', () => {
    // A guard never seen red is not a guard. Both directions, because the
    // import condition is half the rule and an over-eager version that flagged
    // every `displayName` would be turned off within a week.
    expect(offendingLines('const label = conv.displayName;')).toEqual([1]);
    expect(
      offendingLines(
        [
          "import { useResolvedName } from '@/identity';",
          'const label = member.displayName;',
        ].join('\n'),
      ),
    ).toEqual([]);
    // The old `@/utils/resolveMemberName` seam no longer grants a pass — a
    // file sitting on it alone is exactly what repointing the regex was for.
    expect(
      offendingLines(
        [
          "import { resolveMemberName } from '@/utils/resolveMemberName';",
          'const label = member.displayName;',
        ].join('\n'),
      ),
    ).toEqual([2]);
    // React's devtools idiom must not count.
    expect(offendingLines("Foo.displayName = 'Foo';")).toEqual([]);
  });
});
