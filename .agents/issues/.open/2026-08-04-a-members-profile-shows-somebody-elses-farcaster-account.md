---
type: bug
title: "A member's profile sheet shows another member's Farcaster account (@handle and FID belong to the space owner, not the person shown)"
status: open
priority: high
created: 2026-08-04
updated: 2026-08-04
area: identity storage / farcaster linkage / space member roster
source: observed on device 2026-08-04 while testing the identity-resolver work. Screenshot: profile sheet headed "Jennifer" with Jennifer's address, carrying `@gattopardo · FID 3336925` — an account owned by the member who SENT the message, who is also the space owner
related:
  - "issues/.open/2026-08-04-one-identity-resolver-so-names-and-avatars-match-everywhere.md"
  - "quorum-desktop .agents/docs/features/identity-resolution-and-profile-sync.md"
---

# One member's row is carrying another member's Farcaster identity

## 1. Why this is filed as high

This is not a name rendering inconsistency. The app is **attributing one
person's external social account to a different person**, in a UI that offers to
open that Farcaster profile. Two members' identities are mixed in storage.

Worth stating plainly because it changes the severity: a viewer has no way to
tell this is wrong, and the wrong FID is actionable (tapping it opens the other
person's Farcaster profile).

## 2. What is established, and how

MEASURED (observed on device): profile sheet shows name `Jennifer`, address
`QmV5xWMo…ZF2n`, and a Farcaster chip reading `@gattopardo · FID 3336925`.
GattoPardo is a different member — the sender of the message and the space owner.

READ (traced through source, not assumed):

1. `components/UserProfileModal.tsx:272-285` renders the chip **purely from its
   props** (`user.farcasterFid` / `user.farcasterUsername`). It performs no
   lookup of its own, so it cannot have fetched the wrong account.
2. `components/Chat/MessagesList.tsx:681-695` (`handleMentionPress`) supplies
   those props from `memberMap[userId].farcasterFid`.
3. `components/Chat/MessagesList.tsx:671-678` builds `memberMap` keyed by
   `m.address` and nothing else. So the lookup returned the row for the address
   in the mention, i.e. Jennifer's row.

**Therefore the stored `SpaceMember` row for Jennifer contains GattoPardo's
`farcasterFid` / `farcasterUsername`.** The defect is at write time, in storage,
not in rendering.

INFERRED, and explicitly NOT established: which write path put it there.

## 3. Candidate write sites — start here

None of these has been confirmed; they are where the field is written.

| Where | Why it is a candidate |
|---|---|
| `context/WebSocketContext.tsx:2685` | The `update-profile` receive handler reads `adapter.getSpaceMember(spaceId, profileContent.senderId)` — the row is keyed by a `senderId` taken from the message **content**. If that ever disagrees with the authenticated envelope sender, one member's update lands on another's row. Note the same class of trust issue was fixed for `join` in `cb069f3` |
| `context/WebSocketContext.tsx:4632` | A second handler writing the same fields with the same shape. Two copies of this logic means they can diverge |
| `context/WebSocketContext.tsx:6507` | The on-connect rebroadcast attaches `user.farcaster?.fid` to the OUTGOING message. Correct as written (it is your own identity), but confirms the field travels on `update-profile` |
| Roster/sync delta application | A `MemberDelta` that applies one member's fields at the wrong index would contaminate rows in bulk. Worth checking whether the observed case is isolated to one member or affects several |

## 3a. Narrowed 2026-08-04 — the receive path is NOT the cause

Investigated the same day and then parked, because pinpointing it was taking
longer than it was worth. What was eliminated is worth as much as what remains,
so it is recorded rather than left to be redone.

**MEASURED (operator, on device): exactly ONE member shows this. No one else.**
That is the answer to §4 below, and it rules out bulk contamination — a
`MemberDelta` misapplied across rows, or a bad row-creation path, would hit
many members, not one.

**READ, and each one eliminated:**

- **Both `update-profile` receive handlers are correct.**
  `context/WebSocketContext.tsx:2685-2762` and `:4591-4640` key the row lookup,
  the merge, AND the React Query cache update off `profileContent.senderId`
  throughout. Farcaster is taken from the same message's own fields. So a
  member's row receives that member's linkage — there is no cross-member write
  here. This was the leading candidate in §3 and it is wrong.
- **Joins do not carry Farcaster at all.** `services/space/joinedMemberRow.ts`
  has no farcaster field, so row creation at join cannot be the source.
- **Stale modal state is not it.** `app/(tabs)/spaces/[id]/[channelId].tsx:186`
  does `setSelectedUserProfile(info)` — a plain replace, not a merge — so a
  previously-viewed profile's FID cannot survive into the next one.

**Therefore the contamination happens on the SEND side**, on whichever device
broadcast an `update-profile` as that member. The receiver stored faithfully
what it was told; the message itself carried the wrong FID.

## 3b. The hypothesis to test first when this is picked up

**Is the Farcaster link stored per-Quorum-account, or per device?**

`context/WebSocketContext.tsx:6507` attaches `user.farcaster?.fid` to the
outgoing on-connect broadcast. That is correct *if* `user.farcaster` belongs to
the currently-active Quorum account. If the Farcaster link is device-global,
then a device that has linked one Farcaster account will broadcast that FID
while signed in as **any** Quorum account — and the affected member is simply
whichever account was used on the device that has the link.

This fits every observation: one member affected, the FID belonging to a
different account, and both receive paths clean.

Supporting circumstance: this app already has a known account-switch state-leak
of exactly this shape — see `.open/2026-06-20-stale-hypersnap-signer-on-account-switch.md`.

Cheapest test: sign in as the affected account and check whether the profile
screen shows a Farcaster link it should not have. If it does, the link is
device-scoped (or stale from a switch) and the fix is on the account boundary,
not in the space code at all.

## 4. First question to answer — ANSWERED, see §3a

Is Jennifer's row the only contaminated one, or do several members carry the
owner's FID? That single answer splits the candidates: one bad row points at the
`update-profile` receive path, many bad rows point at delta application or at
row creation.

Dump the stored rows for the space and compare `address` against
`farcasterFid` — no UI needed, and it is decisive.

## 5. Definition of done

- [ ] Established whether one row or many are contaminated
- [ ] The write path identified, with the specific line
- [ ] `update-profile` handling keys the row off the AUTHENTICATED sender, not a
      `senderId` carried in message content (or it is confirmed that it already
      does and this was not the cause)
- [ ] The two duplicate handlers at `WebSocketContext.tsx:2685` and `:4632` are
      reconciled, or the duplication is recorded as deliberate
- [ ] Existing contaminated rows are repaired or shown to self-correct
- [ ] Checked against desktop: same data, same surfaces — does a desktop client
      show the same wrong linkage for the same member?

*Last updated: 2026-08-04*

## Updates
- **2026-08-04 13:32**: Narrowed then parked 2026-08-04: receive path, join rows and modal state all eliminated by reading; only one member affected (measured on device). Contamination is send-side. Next test is whether the Farcaster link is device-scoped rather than per-Quorum-account.
