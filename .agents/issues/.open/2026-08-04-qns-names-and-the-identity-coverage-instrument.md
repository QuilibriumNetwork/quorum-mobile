---
type: task
title: "Finish the identity work: QNS .q names for other members, the hook's inlined precedence, and the identity-coverage instrument"
status: open
priority: medium
created: 2026-08-04
updated: 2026-08-04
area: identity resolution / QNS / instrumentation
source: split out of the resolver adoption shipped as PR #225 on 2026-08-04, so the shipped part could close without pretending these were done
related:
  - "issues/.done/2026-08-04-one-identity-resolver-so-names-and-avatars-match-everywhere.md (the parent — read its §3a, §4a and §5.4 before starting)"
  - "issues/.open/2026-06-10-primary-username-not-synced-or-published.md"
  - "quorum-desktop .agents/docs/features/qns-username-display.md"
---

# Three pieces the resolver adoption deliberately left

PR #225 gave every mobile surface one name-resolution rule. These are the parts
that were scoped out to keep that change safe, not parts that were forgotten.

## 1. QNS `.q` names never reach another member's row

The adapter already handles the QNS tier — `resolveMemberName` passes
`primary_username` to shared, and shared ranks it directly below the per-space
override. Nothing populates that field for anyone but yourself, so the tier is
currently dead.

**The gap is small and precisely located** (MEASURED during the parent issue's
review, §5.4):

- `services/api/quorumClient.ts:829` already declares
  `getPublicProfile(): Promise<{ …; primary_username?: string; … }>`, so the
  `.q` name **is already arriving on the wire** with every public-profile fetch
  mobile makes.
- `hooks/useUserPublicProfile.ts:13` re-declares a narrower `PublicProfile`
  interface with no `primary_username`, discarding it at the type boundary.
- `hooks/useMembersWithPublicProfileFallback.ts:158-160` merges only name, icon
  and bio.

So this is a field widening plus a merge line, not a new fetch or a new
transport. Note the hook's own comment at line 61 claims the fetch happens "for
the QNS `.q` name it uniquely carries" — **that comment is currently false**,
and making it true is part of this.

Still to check: whether `primary_username` is actually populated server-side for
the accounts under test, and whether it can reach an in-space member row at all
or only ever via the public profile. Desktop's identity-coverage module states
the latter.

## 2. The hook still holds its own inlined precedence

`useMembersWithPublicProfileFallback` was deliberately not touched by #225 —
that is exactly why the shipped change was safe, because chat's render path did
not move. But it still implements override → newer-of(global slot, public
profile) inline, so mobile has two places that know the ladder.

Two constraints from the parent issue that must not be lost:

- Shared's resolver does NOT do the newer-timestamp-wins merge between the
  global slot and the public profile. It takes one already-resolved
  `display_name`. So this hook keeps that merge; only the tier *ordering* can
  delegate.
- The hook currently flattens override / global / public into a single
  `display_name` on the merged row (line 158). Anything downstream that wants to
  tell a deliberate per-space name from a global one cannot, because the
  distinction is gone by then. If the hook is reworked, surface the slots
  separately rather than flattening.

## 3. No instrument, so nobody can tell if any of this helps

Desktop has `src/dev/identity-coverage/` — a pure core plus a storage reader and
a page — that counts the members landing on the **last rung** of the ladder
(the truncated address) rather than inspecting one slot, and keeps the local
pessimistic count separate from "a render-time fetch could still save this".

Its pure core has no DOM, no storage, no network and no clock by design, so it
ports. Porting it gives a single number to read before and after any identity
change, on both clients, which is the only way the parity question gets a real
answer rather than an anecdotal one.

This matters more than usual here: mobile has known upstream gaps where
identities never arrive at all (it never asks for the roster and never answers
another client's request), so a member showing as an address is ambiguous
between "the rule is wrong" and "the data was never delivered". Eyeballing
screens cannot separate those. A number can.

## 4. The second reason the tier was dead (found 2026-08-06)

§1 was right that the field was discarded at the type boundary. It was not the
whole story, and fixing only that would have produced no visible change.

MEASURED: the fetch was gated on a member missing a name *or* an avatar
(`!effName || !effIcon`). That gate was sound while the public profile only ever
supplied a fallback name/avatar — once the roster global slot carries those, the
fetch buys nothing. It stopped being sound the moment QNS mattered, because the
public profile is the **only** carrier of `primary_username`. Any member already
known by name would never be asked about their `.q`, so the tier could not fire
for them.

Either defect alone was sufficient to keep QNS invisible. Desktop does not have
this one: READ, `src/hooks/business/user/useMembersWithPublicProfileFallback.ts:67-78`
fetches every visible sender and says why in a comment.

## 5. How to actually see any of this: the dev overlay

Shipped 2026-08-06 on both clients. A `.q` costs real money, so the tool
synthesizes one rather than requiring a registration.

| | mobile | desktop |
|---|---|---|
| control | Profile → Developer → Fake QNS | `/dev/fake-qns` |
| seam | `QuorumMobileClient.getPublicProfile` | `QuorumApiClient.getPublicProfile` |
| core | `services/dev/fakeQns.ts` | `src/dev/fake-qns/fakeQnsCore.ts` |

Both cores are deliberately identical, including the derived names, and both
suites assert the same hard-coded derivation — a parity comparison where the two
clients were handed different inputs is not a comparison.

The seam is the API client, not the hooks, which structurally avoids the trap
the desktop doc records: every public-profile hook shares one React Query key,
so a hook-level fake that missed one caches a real `null` and never appears.

**Mobile's panel has one half that is NOT an overlay.** "My .q name" writes
`user.primaryUsername` for real, because that is the actual product path. With a
public profile, the next publish signs it into the v2 payload and POSTs it to
the configured API — production unless "Use Local API" is on. Clear it when
done. Desktop has no equivalent because it never publishes `primary_username`.

### 5a. The observation run

Set "Enable" + "Give everyone a .q". Reopen the space after every change — an
open screen holds an already-resolved member map, so a stale screen reads as a
negative result.

Expected `.q` (mobile surfaces that go through `formatResolvedName`, all of them
downstream of a chat screen and therefore fed by the fallback hook):

- [ ] message sender names — `MessagesList.tsx:691`
- [ ] reply-preview author — `Chat/types.ts:523`
- [ ] mention pills in rendered markdown — `MessageMarkdownRenderer.native.tsx:366`
- [ ] mention autocomplete rows, and matching by typing the `.q` — `MessageInput.tsx:516,1122`
- [ ] reaction details — `ReactionDetailsModal.tsx:106`
- [ ] mention/reply notification bodies — `logMentionOrReply.ts:113`

Expected `.q` from `user.primaryUsername` (self only, no overlay involved):
profile header, header avatar fallback, tab bar, Farcaster identity badge.

### The two places expected to show NO `.q` — findings, not tool faults

Both were discovered by asking the tool what it could reach, before running it.
Stated here because each would otherwise read as "the fake did not work".

**A. The Space Settings member list, for everyone including yourself.**
MEASURED 2026-08-06: only `SpaceChatArea.tsx:245` and `DMChatArea.tsx:173` call
`useMembersWithPublicProfileFallback`. `SpaceSettingsModal.tsx:838` resolves
from raw roster rows, and a roster row never carries `primary_username` — the
public profile is its only carrier. Your own row does not escape this either:
the self tier reads `displayName`/`username`, not `primaryUsername`.

Desktop's member sidebar *does* show it, by cheap-merging `primaryUsername` from
`effectiveMembers` for members who have posted (its own doc calls the
lurkers-show-nothing remainder a known limitation). So this is a parity gap with
a known, cheap shape to copy — no new fetch.

**B. Mobile's DM surfaces.** The conversation list and DM header read
`conversation.displayName` raw (`app/(tabs)/messages/dm/[id].tsx:390`,
`messages/index.tsx:216`) and never reach the adapter. Desktop resolves there
(`DirectMessage.tsx:259,372`, `useConversationsWithProfileBackfill.ts:116`).
Note the DM *message* surfaces are fine — `DMChatArea` does use the hook — so
this is specifically the list and the header.

Same person, two clients, two names, in both cases. File each once the run
confirms it.

### 5b. The two questions this answers directly

**Does a `.q` beat the global display name?** Yes, by the ladder. Control arm:
set a per-space name for yourself in one space and not another. The space with
the override must show the override; the other must show the `.q`. If both show
the same thing the precedence is inverted, and everything converging is NOT a
pass.

**Is a `.q` visible when the profile is private?** No. `primary_username` travels
only in the published public profile, so a private profile has no `.q` as far as
anyone else is concerned. Flip "All profiles private" to see exactly that. Note
this is independent of QNS resolvability: `GET names.quilibrium.com/resolve/:name`
is public regardless, so people can still find your address by name — the
profile toggle only controls whether Quorum *displays* the label.

## Definition of done

- [x] `PublicProfile` in `hooks/useUserPublicProfile.ts` carries `primary_username` — now an alias of the client's own type, so a field can no longer be lost here
- [x] The merge in `useMembersWithPublicProfileFallback` propagates it onto the member row
- [x] The stale comment at `useMembersWithPublicProfileFallback.ts:61` is made true — the gate it described is gone (§4)
- [x] Confirmed whether `primary_username` can reach an in-space member row at all, or only via the public profile — public profile only, and the fetch gate had to widen before it could arrive
- [ ] A member with a `.q` name renders as their `.q` name on the surfaces that use `formatResolvedName` — **the overlay makes this observable; the run in §5a has not been done yet**
- [ ] The hook delegates tier ordering to the adapter while keeping its own timestamp merge, and chat behaviour is unchanged (this is the risky one — chat is the reference path)
- [ ] Desktop's identity-coverage pure core is ported and a before/after number recorded
- [ ] Same number produced on desktop for the same space, so parity is a comparison and not an impression

## Status

Parts 1 and the instrument's prerequisite landed 2026-08-06 on
`feat/dev-fake-qns-and-member-qns-plumbing` (mobile) and `feat/dev-fake-qns`
(desktop). Mobile: 513 tests, four mutations confirmed capable of turning them
red. Desktop: 1050 tests, three mutations confirmed.

Still open: part 2 (the hook's inlined precedence) and part 3 (the
identity-coverage port) are untouched. The §5a observation run is the immediate
next step and needs a device.

*Last updated: 2026-08-06*
