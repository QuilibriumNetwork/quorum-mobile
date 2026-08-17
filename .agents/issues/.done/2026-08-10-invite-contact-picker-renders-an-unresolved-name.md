---
type: bug
title: "The invite contact picker renders an unresolved name, and hand-rolls its own fallback"
status: done
priority: medium
created: 2026-08-10
updated: 2026-08-16
area: identity resolution / QNS / invites
repos: quorum-mobile (this) , quorum-desktop (fixed 2026-08-10)
source: found while auditing the DESKTOP equivalent for parity item (6); mobile turned out to have the same defect from the same cause
related:
  - "issues/2026-08-06-qns-primary-name-work-and-desktop-parity.md (the parity index)"
  - "quorum-desktop branch fix/name-surfaces-bypassing-the-resolver (the equivalent fix)"
---

# The invite contact picker renders an unresolved name

## What is wrong

`components/ShareInviteSheet.tsx:173` renders a DM contact's name straight off
the conversation row:

```tsx
label={conv.displayName || truncateAddress(conv.address)}
```

Two separate problems in one line.

**1. It never resolves.** `conv` comes from `useConversations({ type: 'direct' })`
(line 47), which returns raw rows. A raw conversation row cannot carry a
`primary_username` — that field lives only in the published public profile — so a
contact who has elected a `.q` name is listed here under their old global display
name. Every other DM surface on mobile resolves; this one does not.

**2. It supplies its own fallback.** `|| truncateAddress(conv.address)` is the
caller re-deriving a rung the resolver already owns, which is how surfaces drift
apart: the resolver picks `long` truncation for DM surfaces and `medium`
elsewhere, and a hand-rolled call cannot know that. The same expression appears
in the toast at line 87 (`displayName || 'recipient'`) and is passed into
`handleSendToDM` at line 183.

There is a third consequence which is security-relevant rather than cosmetic. It
is not described here; see the note at the end.

## Why this was missed

It does not look like a roster read. It looks like reading a field off a
conversation you already have in hand, which is exactly the case the parity
document predicted would be hardest to spot:

> Grep for direct `displayName` reads on roster rows AND on conversation rows;
> the conversation ones were the easiest to miss because they look like they
> belong there.

## The fix

Mobile already has the tool and this surface does not use it:
`hooks/chat/useConversationsWithQnsNames.ts`, the hook the DM list uses to attach
`primaryUsername` to conversation rows. Feed the picker's conversations through
it, then render via the resolver rather than the raw field, and delete the
hand-rolled truncation.

**The cost objection does not apply here, and it is worth stating because it is
the reason this looked expensive on desktop first.** The backfill is N
public-profile lookups, but they are keyed per address with a 1h cache and the
addresses are the DM partners the conversation list has already fetched under the
same key. So it is a cache read, not a second round of requests. Desktop's fix
initially stopped short on exactly this misjudgement and was corrected.

## What desktop did, for reference

Fixed 2026-08-10 on branch `fix/name-surfaces-bypassing-the-resolver`:
`src/hooks/business/spaces/useInviteManagement.ts` now runs its conversations
through `useConversationsWithProfileBackfill` and renders
`formatResolvedName(resolveMemberName({...}))`.

Desktop's sweep found six such surfaces in total. Mobile's earlier sweep found
seven and did not include this one, so it is worth re-checking mobile's share and
invite paths generally rather than only this file — that sweep covered message
and roster surfaces, and share sheets were not in scope.

## The standing lesson this is an instance of

From the parity document, written about the join-stamping fix:

> a fix that lands on one client and leaves the other as a TODO is not a shipped
> fix. The clients share a network, so the unfixed one keeps producing the state
> the fixed one is cleaning up.

This one is the display half of the same rule: a name rendered honestly on
desktop and raw on mobile is a name the mobile user reads wrong.

## Status

**2026-08-16 — fixed and shipped in PR #249** (`feat: names resolve through one
verified ladder, so a .q shows wherever a name does`), as Task 7 of the mobile
identity migration.

What landed: `ShareInviteSheet` resolves through `useResolvedName` /
`useNameResolver` from `@/identity` (`components/ShareInviteSheet.tsx:33,90,121`)
instead of reading a row field. The `it.failing` test that recorded the defect is
now a plain passing `it`.

The fix went further than this file asked in two ways. The picker now **verifies**
a claimed `.q` rather than only resolving one, and its fetch fan-out is bounded
(60 → 50), because an invite list's cardinality is the contact book.

The fourth item — sweeping the rest of the share/invite paths — was satisfied
structurally rather than by hand: `__tests__/rawNameFieldAudit.test.ts` now fails
on *any* file under `components/` or `app/` that reads a raw name field without
importing the resolver, so the same shape cannot reappear anywhere in the tree
unnoticed.

## Definition of done

- [x] Picker resolves through the resolver (via `@/identity`, which supersedes
      `useConversationsWithQnsNames` — the migration replaced that seam)
- [x] Hand-rolled `truncateAddress` fallbacks removed. The one remaining call is
      a deliberate `sublabel` showing the address as a secondary line beneath the
      resolved name, not a fallback standing in for one.
- [x] A test that fails without the fix — `__tests__/shareInviteSheetName.test.tsx`,
      plus `__tests__/shareInviteSheetFetchBound.test.tsx` for the cap
- [x] The rest of mobile's share/invite paths swept for the same shape — done by
      the ratchet rather than by inspection, which is stronger

## Note

The security-relevant consequence of rendering an unresolved name at this
particular surface is recorded in `quorum-desktop`'s private issue folder rather
than here. Ask for the path; do not restate it in a tracked file.

---

*Last updated: 2026-08-16*
