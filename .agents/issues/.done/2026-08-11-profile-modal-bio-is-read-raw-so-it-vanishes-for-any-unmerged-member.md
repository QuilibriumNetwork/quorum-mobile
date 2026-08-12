---
type: bug
title: "The profile modal's bio is read raw, so it vanishes for any member the sender merge never touched"
status: done
priority: medium
created: 2026-08-11
updated: 2026-08-12
area: identity resolution / profile modal
repos: quorum-mobile (this), quorum-desktop (sibling defect fixed)
related:
  - "quorum-desktop/.agents/issues/2026-08-11-profile-card-from-a-mention-pill-shows-a-stale-bio-and-no-avatar.md (the desktop half)"
  - ".agents/issues/2026-08-06-qns-primary-name-work-and-desktop-parity.md (the parity index)"
---

## Status

Fixed as part of Phase D row 13 (mobile identity migration). `resolveMemberBio`
added beside `resolveMemberAvatar` in `utils/resolveMemberName.ts` (override →
global slot, undefined when neither resolves). All four raw reads this issue
named now route through it: `components/Chat/MessagesList.tsx` (mention-pill
tap, message-avatar tap, reaction-list tap) and
`components/SpaceSettingsModal.tsx` (member list). `__tests__/resolveMemberName.test.ts`
covers the resolver with one test per rung, each verified red against a
reverted implementation before the fix landed.

**Not done, deliberately deferred:**
- The three-step manual repro in "How to confirm" was not run against a live
  app build — the automated coverage above verifies the same mechanism
  (override/global precedence) more precisely than a one-time manual walk
  would, but nobody has confirmed the actual screen renders correctly on
  device.
- The "Not checked" scope from the original report — `ProfileModal.tsx`,
  `UnifiedProfileScreen.tsx`, `ProfileSplitModeModal.tsx` — remains unswept.
  Same disposition as originally filed: may have the same raw read, not
  investigated here.

# The profile modal's bio is read raw, so it vanishes for any member the sender merge never touched

**Evidence level: READ, not MEASURED.** Everything below is traced from source
with `file:line`; nothing was reproduced in a running app. The repro in
"How to confirm" is the first thing to do, and it is cheap.

## What desktop found, and why mobile is not the same bug

Desktop's profile card had two entry points passing different payloads, and the
address-only one (a mention pill) fell straight through to the published public
profile for the bio and avatar — opt-in, usually no photo, cached an hour. Fixed
by giving the card its own ladder ending at `space_members`' live-pushed
`global_user_icon` / `global_bio` slots.

**Mobile's modal has no such fallback chain at all**, and does not need one: it
renders `user.bio` and `user.userAvatar` straight from the caller's payload
(`components/UserProfileModal.tsx:369, 431`). Every caller is expected to hand
over an already-resolved identity. So the question is not "which fallback does
the modal use" but "did the caller resolve the fields before passing them".

For the **avatar**, yes — every caller uses `resolveMemberAvatar(member)`
(`utils/resolveMemberName.ts:260`), which reads
`profile_image → global_profile_image` directly off the roster row and therefore
works whether or not the member was ever enriched.

For the **bio**, no. All four callers read `member.bio` raw:

| Site | Path |
|---|---|
| `components/Chat/MessagesList.tsx:693` | mention-pill tap |
| `components/Chat/MessagesList.tsx:727` | message-avatar tap |
| `components/Chat/MessagesList.tsx:1709` | reaction-list tap |
| `components/SpaceSettingsModal.tsx:1958` | member list in space settings |

`member.bio` is the **per-space override only**. Under the two-slot model an
empty override is its normal state — the member's actual bio lives in
`global_bio` on the same row. So the modal shows no bio section at all, while
the avatar right above it renders correctly from the global slot.

`SpaceSettingsModal.tsx:1955-1958` states the defect in one object literal:
`userAvatar: identity.avatar` (resolved) next to `bio: member.bio` (raw).

## Why it does not always show

`useMembersWithPublicProfileFallback`'s `mergeMemberIdentity` computes the right
answer — `pick(local?.bio, local?.global_bio, pub?.bio)`
(`hooks/useMembersWithPublicProfileFallback.ts:83`) — and writes it back onto the
row's `bio`. So where the merged map is what a caller reads, the raw read is
accidentally correct.

But the merge only covers **visible senders**:
`for (const addr of new Set(visibleAddresses))`
(`hooks/useMembersWithPublicProfileFallback.ts:236`), fed from `senderAddresses`,
the unique senders of the currently loaded messages
(`components/Chat/SpaceChatArea.tsx:255`). That bound is deliberate and correct —
it is the same fetch-storm refusal desktop makes, and `SpaceChatArea.tsx:268-272`
already documents the name half of this limitation.

The consequence for the bio was not noticed:

- **Mention a member who has not posted in the loaded window** → their row is
  unmerged → `member.bio` is the empty override → no bio.
- **Space settings member list** → members come from the roster, never through
  the sender merge at all → the bio is missing for everyone without a per-space
  override, which is most people.

So the same member can show a bio when tapped from a message and no bio when
tapped from the member list, and neither surface looks broken on its own.

## The fix, in the shape mobile already uses

Add `resolveMemberBio(member)` beside `resolveMemberAvatar` in
`utils/resolveMemberName.ts`, with the same `override → global slot` precedence
and the same "return `undefined` when nothing resolves so the caller renders
nothing" contract. Replace the four raw reads with it.

That deliberately does NOT add a public-profile tier: the merge already folds
the public profile into `bio` for enriched rows, and adding a fetch to a
resolver called during render is exactly what the visible-senders bound exists
to prevent. The goal is to stop the bio depending on whether the member happened
to be enriched, not to widen the fetch.

Reason to prefer this over "merge the whole roster": the resolver mirrors what
the avatar already does, costs nothing, and is testable as a pure function. The
raw read is the defect; the merge coverage is a deliberate design choice that
should not have to change.

## How to confirm it is this and not something else

1. Find a member with a global bio and no per-space bio override — the normal
   case.
2. Open Space Settings → member list → tap them. Expect: avatar and name
   correct, **bio section absent**. That is the bug.
3. Have them post a message, then tap their avatar in the chat. Expect: bio
   now present, because that path went through the merge.

If step 2 shows a bio, check whether that member has a per-space override set —
that is the one case where the raw read happens to be right.

## Scope

- **Not checked:** `ProfileModal.tsx`, `UnifiedProfileScreen.tsx`,
  `ProfileSplitModeModal.tsx`. They may have the same raw read; this issue only
  covers the four sites feeding `UserProfileModal`.
- **DMs:** `DMChatArea.tsx:198` runs the same merge over DM members, so a DM
  partner is normally enriched. Not separately investigated.

## Definition of done

- [ ] `resolveMemberBio` added, mirroring `resolveMemberAvatar`
- [ ] All four raw `member.bio` reads routed through it
- [ ] A unit test per rung, each shown red with the fix reverted
- [ ] The three-step repro above run in the app, before and after
- [ ] The other profile surfaces swept, or explicitly deferred

---

*Last updated: 2026-08-11*
