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
 * are listed by name. Confirmed by grep to appear nowhere else under the scan
 * roots except the three Call screens already tracked below.
 */
const RAW_FIELD =
  /\b(displayName|primaryUsername|globalDisplayName|display_name|primary_username|global_display_name|recipientDisplayName|callerDisplayName)\b/;

const RESOLVER_IMPORT =
  /from\s+['"](@\/utils\/|\.{1,2}\/[\w/]*)(resolveMemberName|resolveSelfName|conversationTitle)['"]/;

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
  'components/Chat/DirectMessagesList.tsx':
    'MIGRATED: a Quorum row resolves via `@/identity`’s `useResolvedName` (global, enrich — see the file’s own comment). The two remaining raw reads are legitimate: a Farcaster row’s own already-resolved `displayName` (a synthetic `fid:<n>` address, no roster, no `.q`), and the "unknown" filter’s `!c.displayName`, which classifies rows by whether anything was ever stored rather than rendering a name.',
  'components/Chat/FarcasterCastCard.tsx':
    'Renders `cast.author`; the other hit is a StyleSheet key literally named `displayName`.',
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
 */
const TO_MIGRATE: Record<string, string> = {
  // ── Calls: a whole surface family no migration table listed ─────────────
  'components/Call/InCallScreen.tsx':
    'DEFECT: renders `activeCall.recipientDisplayName` raw off the call payload; never resolved, so no `.q` and no per-space name.',
  'components/Call/IncomingCallScreen.tsx':
    'DEFECT: renders `incomingCall.callerDisplayName` raw off the call payload.',
  'components/Call/OutgoingCallScreen.tsx':
    'DEFECT: renders `activeCall.recipientDisplayName` raw off the call payload.',

  // ── DM surfaces, including the PLACEHOLDER class ────────────────────────
  'components/Chat/DMChatArea.tsx':
    'PARTIALLY MIGRATED: the composer channel-name hand-truncation (`address.slice(0, 8)`) now resolves via `@/identity`’s `useResolvedName`. Two things remain raw and are NOT this file’s row: the `dmMemberMap` build block (`global_display_name`/`claimed_primary_username` keys, lines ~160-187) is a separate, already-verified mechanism (`useVerifiedQnsNamesInMap`) feeding per-message sender names, out of this migration’s scope; and `cachedPreview.sourceName` (line ~498) is a genuine, newly-found DEFECT — a hand-rolled `conversationData?.displayName || \'DM\'` baked into a bookmark’s stored preview with no `.q` support — left unfixed here because it has no covering test in this pass. Flagged for a follow-up row.',
  'components/Chat/FarcasterDirectMessageView.tsx':
    'MIXED: Farcaster authors are fine, but `conversation.displayName` is read raw for the conversation title.',
  'components/SocialFeedModal.tsx':
    'MIXED: cast authors are Farcaster, but `conv.displayName` is a Quorum conversation name read raw.',

  // ── Hand-composed identity, including a hand-rolled `.q` ────────────────
  'components/UserProfileModal.tsx':
    'DEFECT: renders `user.userName` and `user.primaryUsername` as separate hand-composed pieces instead of one resolved name.',
  'components/wallet/TipModal.tsx':
    'DEFECT: `recipientQuorumIdentity.displayName` is read raw when labelling a tip recipient.',
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
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
          "import { resolveMemberName } from '@/utils/resolveMemberName';",
          'const label = member.displayName;',
        ].join('\n'),
      ),
    ).toEqual([]);
    // React's devtools idiom must not count.
    expect(offendingLines("Foo.displayName = 'Foo';")).toEqual([]);
  });
});
