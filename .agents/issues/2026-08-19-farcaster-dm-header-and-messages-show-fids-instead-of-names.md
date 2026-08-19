---
type: bug
title: "A Farcaster DM shows raw FIDs instead of names, in the header and on every message"
status: in-progress
priority: high
ai_generated: true
created: 2026-08-19
updated: 2026-08-19
area: "Farcaster DMs / identity resolution / chat UI"
---

# A Farcaster DM shows raw FIDs instead of names, in the header and on every message

## Summary

Open a DM from a Farcaster user and the conversation header reads `fid:9999001`
instead of their name, and every message row — both sides — is headed by a bare
FID rather than a name. The DM inbox list beside it shows the correct name the
whole time, which is what makes the defect look like a data problem when it is
purely a rendering one.

Regression from #249 (`ed7592c`, "names resolve through one verified ladder").
Reported by the operator on 2026-08-19.

## Status

Fixed on `fix/farcaster-dm-shows-fid-instead-of-name`, then revised after a
six-angle review (correctness, silent-failure, security, tests, comments,
mobile-platform). The review found two real defects in the first cut — one of
them a security regression the fix itself introduced — and both are now closed.

Full suite 1140/1140. `tsc` unchanged at the 12 pre-existing errors. Lint on the
touched files identical before and after (6 problems: 1 error, 5 warnings, all
pre-existing, MEASURED by stashing and re-running).

Not yet confirmed on a device. That remains the gap: the tests prove the right
string is chosen and the right guard applies, not that the two-line header lays
out correctly on a real screen. See `.agents/docs/ios-verification-checklist.md`
item 16.

## What the review changed

### 1. The first fix introduced an impersonation hole (HIGH, closed)

Trusting `item.userName` for a Farcaster sender meant trusting a string its
owner types. Both names render in the SAME `messageUser` style as a Quorum name
that climbed the verified ladder, so setting a Farcaster display name to
`alice.q` produced something visually identical to a cryptographically verified
QNS name.

This was strictly a regression of this fix: before it, the fid matched no tier
and the ladder truncated it, so the attacker's string never reached the screen.
The cosmetic bug was traded for a security one.

Closed by applying `presentName` — the same guard the member ladder already
uses, built on shared's `hasReservedQnsSuffix`, which folds confusable Unicode
dots so `alice․q` (U+2024) is caught too. Applied at BOTH seams, deliberately:

- in `types.ts`, at every Farcaster name read, so rejection falls through to
  the next tier (`username`, which Farcaster restricts to characters excluding
  dots and so cannot wear the suffix); and
- in `MessagesList.tsx` at the render seam, so a future producer that forgets
  cannot reopen it.

`presentName` was exported rather than reimplemented. A second copy of a
forgery guard is a copy that drifts.

It also fixes a second defect for free: `??` chains do not catch `''`, and
`senderContext.displayName` is a REQUIRED string in the API type, so a
present-but-blank name reached the row and rendered as the bare fid.

### 2. The badge can overflow the header bar (HIGH, closed)

`ScreenHeader` set a hard `height: 44`. Text scales with the OS font-size
setting; a declared height does not. Name lineHeight 22 plus a badge with NO
explicit lineHeight put the two-line title within a few pixels of the bar at
default scale, overflowing at roughly 1.15x — an ordinary Settings value, not an
accessibility extreme. Nothing sets `overflow: hidden`, so it bleeds over the
message list rather than clipping.

Closed by `height` → `minHeight` (identical at default scale, since the tallest
content is a 28px avatar; only differs where the old value would have
overflowed) and by giving the badge an explicit `lineHeight` from the theme's
tuned tokens, so its height stops being platform-font-metric-dependent.

### 3. The tests proved the wrong thing (closed)

MEASURED by the test reviewer: under a reverted fix the row rendered
"Alice Smith", not the fid, because `mockGetPublicProfile` answered for any
address including a fid. The tests were pinning "the routing changed" rather
than "the raw fid reached the screen", and two comments claimed otherwise.

The mock is now address-aware, so the revert genuinely reproduces the reported
bug and the comments are true.

### 4. A comment reasoned from the wrong contract (closed)

The `farcasterFid` prop doc justified `enrich` by citing the badge's
bounded-fan-out contract. That contract governs the public-profile fetch; the
fid→address link lookup is a separate call that fires regardless and is capped
nowhere. The conclusion held, the reasoning did not — and a future author
extending this header to a badge per group participant would have been misled.
Rewritten to separate the two calls.

### 5. Screen readers could not see the badge (closed)

The badge sits inside the title's touchable, whose explicit
`accessibilityLabel` suppresses announcement of descendants — so the entire
point of the feature was sighted-only. The label now names the linked identity,
resolved through the ladder rather than read from the link response's
unverified `primaryUsername`: a `.q` spoken aloud must clear the same
verification as one drawn on screen.

## Findings dismissed, and why

- **`UserProfileModal`/`BlockUserModal` render `fc:9999001`** (raised HIGH).
  Unreachable. Cast rows render only `FarcasterCastCard` — no avatar, no
  `onUserPress` — and `FarcasterDirectMessageView` passes neither `onUserPress`
  nor `members`, so no Farcaster id can reach either modal. Two other reviewers
  concluded the same independently.
- **"The working tree has the fix reverted"** (raised as urgent). A stale read:
  that reviewer sampled the tree during the deliberate revert used to prove the
  tests go red. Verified intact.

## Mechanism

Quorum and Farcaster are two identity namespaces that look identical to a
string comparison. A Quorum sender is an address; a Farcaster sender is a FID.

Before #249 the message list rendered `item.userName`, the name carried on each
message. #249 replaced that with a live resolution through the Quorum member
ladder — correct for Quorum, and the whole point of that work. Nothing excluded
Farcaster.

The failure is silent by construction:

1. `resolveWithFallback` (`identity/useResolvedName.ts:47`) finds no tier for a
   FID and falls through to `truncateAddress`.
2. `truncateAddress` delegates to shared's `formatAddress`, which returns any
   string shorter than `start + end + 1` **unchanged**.
3. A FID is always shorter than that. So the "truncated address" IS the FID.

No throw, no log, no empty string — just a number where a name belongs.

### The three affected surfaces

| Surface | What it rendered | Why |
|---|---|---|
| DM header (`DMChatHeader.tsx:65`) | `fid:9999001` | Resolved `address`, which for a Farcaster conversation is the synthetic `fid:<n>` string built at `useFarcasterDirectCasts.ts:73` |
| Message rows (`MessagesList.tsx`, 3 sites) | `9999001` | Resolved `item.userId`, which `directCastToDisplayMessage` sets to `String(senderFid)` (`types.ts:605`) |
| Wasted lookups (`MessagesList.tsx`) | — | Every FID entered the QNS enrichment and Apex batches, which can only miss on one |

The DM screen (`app/(tabs)/messages/dm/[id].tsx:396-404`) computed the correct
title all along via the QNS-free `resolveConversationTitle`, but passed it only
to `Stack.Screen options.title`, which nothing renders. The visible header never
received it.

### Why the inbox list was unaffected

`DirectMessagesList.tsx:109` branches on `source === 'farcaster'` and uses
`item.displayName`. That branch is exactly what the header and the message list
were missing.

## Fix

Farcaster senders are excluded from the Quorum ladder, and their own name is
used instead.

- `MessagesList.tsx` gains `isFarcasterNamespace` and an `isFarcasterSender()`
  predicate. The predicate is **per sender, not per list**, because the two
  namespaces genuinely mix: a space channel bound to a Farcaster channel merges
  casts (`fc:`-prefixed, from `castToDisplayMessage`) into a stream of real
  Quorum senders. A whole-list flag would be wrong there.
- `DMChatHeader.tsx` gains `displayName`, used only when the conversation is
  Farcaster. The resolver is handed `''` on that branch so the hook still runs
  unconditionally but resolves nothing and fetches nothing.
- QNS enrichment and Apex batching filter Farcaster senders out **before** the
  `MAX_QNS_LOOKUPS` cap, so in a mixed channel a FID cannot crowd a real Quorum
  sender out of the capped set.

`item.userName` is used as the answer **only** for a Farcaster sender. For a
Quorum member it stays ignored: that field is frozen at write time, so an old
row can carry a stale or forged name, and resolving live is the entire point of
routing through the ladder.

## Linked Quorum identity, added in the same change

The operator asked for the merged-profile `.q` to appear here too, which it did
not — the badge existed but had never been wired into DMs.

`DMChatHeader` now renders `QuorumIdentityBadge` beneath the Farcaster name for
a **one-to-one** Farcaster DM. The route is the sanctioned one:

```
fid → /users/by-fid/:fid → linked Quorum address → the ladder → "name.q"
```

The FID itself is never a ladder input. The `.q` sits *beside* the Farcaster
name, never in place of it — same rule the feed surfaces follow, and for the
same reason: the Farcaster account is who this conversation is actually with,
and replacing its name would hide that.

Withheld for groups. `farcasterFid` is populated from `viewerContext.counterParty`
even for a group, so gating on the FID alone would pin one arbitrary member's
Quorum identity to the whole conversation.

The uncapped-lookup concern in
`.open/2026-08-13-quorum-identity-badge-fires-an-uncapped-fid-link-lookup-per-cast.md`
does not apply: one badge mounts per conversation, which is the bounded fan-out
the badge's own prop doc requires of a caller. That issue is about a feed
rendering hundreds of casts at once.

## Other client

Not applicable. Desktop's Farcaster surface is a 40-line "Coming soon"
placeholder (`src/components/farcaster/FarcasterPage.tsx`); it has no Farcaster
DMs to break.

## Tests

`__tests__/migrated/MessagesList.test.tsx`
- renders the carried name, not the FID, in a Farcaster DM
- never fetches a Quorum profile for a FID
- resolves Quorum senders to their `.q` while leaving cast authors alone in the
  same mixed channel, and spends exactly one profile lookup doing it

`__tests__/migrated/DMChatHeader.test.tsx`
- renders the Farcaster name, not the synthetic FID address
- never resolves the FID against the Quorum ladder
- shows the linked `.q` as a badge beneath the name when profiles are merged
- stays a plain one-line title when the FID has no linked Quorum identity
- shows no badge for a group

Also moved that file's `beforeEach`/`afterEach` to the top level. Per-describe
setup left later blocks sharing the previous block's QueryClient, and a
react-query entry already resolved under an old mock is still fresh (30 minutes
here), so it never refetches and a reassigned mock is never consulted. That
produced a test failing for a reason unrelated to the code under test.

## Follow-up not done here

- **Message rows show no linked-identity badge.** Only the header does. Per row
  it would reintroduce exactly the uncapped fan-out the open badge issue
  describes, and in a 1:1 DM it would repeat the same two identities down the
  whole conversation. Worth revisiting only alongside that issue.
- **The synthetic first-time-DM branch can still render `fid:<n>`** — same
  symptom, different route, pre-existing. Filed separately as
  `.open/2026-08-19-opening-a-first-time-farcaster-dm-can-still-title-it-with-a-raw-fid.md`.
- **No screen-level test for `app/(tabs)/messages/dm/[id].tsx`.** Every test
  here drives `DMChatHeader`/`MessagesList` directly with hand-built props, so
  the 14 lines of prop computation this change added to the screen are
  unexercised. If the `conversation.type === 'direct'` gate or the `title`
  computation regressed, nothing would catch it.
- **`useQuorumIdentityForFid` cannot distinguish "not linked" from "lookup
  failed"** (`retry: false`, every failure renders nothing). Pre-existing, but
  a DM header is a context where a viewer is far likelier to read the badge's
  absence as a fact about one specific person than a feed row is.

---

*Last updated: 2026-08-19*
