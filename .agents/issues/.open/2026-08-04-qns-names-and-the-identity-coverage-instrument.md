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

## Definition of done

- [ ] `PublicProfile` in `hooks/useUserPublicProfile.ts` carries `primary_username`
- [ ] The merge in `useMembersWithPublicProfileFallback` propagates it onto the member row
- [ ] The stale comment at `useMembersWithPublicProfileFallback.ts:61` is made true
- [ ] A member with a `.q` name renders as their `.q` name, with the suffix styled, on the surfaces that use `formatResolvedName`
- [ ] Confirmed whether `primary_username` can reach an in-space member row at all, or only via the public profile
- [ ] The hook delegates tier ordering to the adapter while keeping its own timestamp merge, and chat behaviour is unchanged (this is the risky one — chat is the reference path)
- [ ] Desktop's identity-coverage pure core is ported and a before/after number recorded
- [ ] Same number produced on desktop for the same space, so parity is a comparison and not an impression

*Last updated: 2026-08-04*
