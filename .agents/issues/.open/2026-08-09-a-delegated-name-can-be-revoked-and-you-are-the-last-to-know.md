---
type: bug
title: "A delegated .q can be revoked by its owner, and you are the last person to know"
status: open
priority: medium
created: 2026-08-09
updated: 2026-08-09
area: identity resolution / QNS / primary name
repos: quorum-mobile, quorum-desktop (once desktop has an elect flow at all)
source: found 2026-08-09 while checking whether the elect flow gates on resolveKey, during the design pass on receiver-side verification
related:
  - "issues/.open/2026-08-06-verify-a-claimed-q-name-receiver-side-plan.md (§6, fifth row — this is the follow-up it defers)"
  - "issues/2026-08-06-qns-primary-name-work-and-desktop-parity.md (the index for all .q work)"
---

# Somebody else can take your name away, and nothing tells you

## Status

**2026-08-09 — decided by the operator. This gets fixed; "accept it" is off the
table.** Two rules were stated, and both are requirements rather than
preferences:

**R1 — The user MUST explicitly choose which `.q` to show.** Electing is a
button press on one specific name. Nothing may elect a name on the user's
behalf, however obvious the candidate looks — not on registration, not when
they hold exactly one name, not when a delegated name arrives.

READ 2026-08-09, this holds today. Every write to the user's own
`primaryUsername` is one of:

- the explicit elect / un-elect flow (`services/profile/primaryNameChange.ts:60`)
- an automatic *removal* when the user makes a name private or transfers it
  (`components/qns/NameDetailModal.tsx:151`) — a removal, and still triggered by
  the user's own action
- config sync carrying the user's own earlier choice to their other devices
  (`context/AuthContext.tsx:363,380`)
- the dev panel (`components/dev/QnsFakePanel.tsx`)

Nothing auto-elects. `hooks/useQuorumIdentityForFid.ts:36` reads a
`primary_username` but it belongs to somebody else, looked up by Farcaster fid,
and never touches self state. **This is a property to protect, not just a fact:
any future "helpfully pick their only name" convenience violates R1.**

**R2 — A revoked delegated name must disappear from the owner's OWN UI too.**
Not only from everybody else's. The asymmetry described below is the bug, and
fixing it only on the receiving side would leave the user as the single person
who cannot see the truth.

**Do not assume delegated names are rare.** We have no measurement either way,
and the original draft of this file offered "accept it if they turn out to be
rare" as an option. That option is withdrawn: the fix does not depend on the
frequency, because a user who hits it has no way to find out what happened.

## The setup

There are two kinds of name you can elect as primary:

- **Owned** — you registered it, you hold it through Quilibrium stealth
  ownership, and only you can make it stop pointing at you.
- **Delegated** — somebody else registered it and pointed its `resolveKey` at
  your address. `components/ProfileModal.tsx:2074-2112` lists these under
  "Delegated to You" and lets you elect one exactly like an owned name.

A delegated name is a gift, and the giver can take it back at any time by
repointing the `resolveKey` at some other address. Nothing about that action
involves you or your device.

## Why nothing catches it

`shouldReleasePrimary` (`services/profile/primaryNameChange.ts`) is the rule
that un-elects a name the moment it stops pointing at you. It is correct and it
is tested, but it fires only on **actions you take** — making a name private,
transferring it away. It is called from the handlers for those actions.

There is no path that notices a name being revoked from underneath you. Nothing
polls, nothing re-resolves an elected name, and the election lives in local
config where it survives restart and syncs to your other devices.

## What it looks like now, and what it looks like after verification lands

**Today**, nothing verifies a claimed name on receive, so a revoked delegated
name keeps rendering as your `.q` for *everyone*. Wrong, but at least uniformly
wrong.

**After receiver-side verification ships**, every other client resolves the name,
finds it no longer maps to your address, fails closed and shows your global name.
That is exactly right. But your own device does not resolve anything — it reads
`primaryUsername` straight from local config — so **you keep seeing your `.q`
while nobody else does.**

That asymmetry is the bug worth fixing. The system behaves correctly and the
user is the only person who cannot tell.

## Why this is a message, not an architecture change

The app already handles a structurally identical case honestly. When electing
succeeds locally but the publish fails, it says:

> **Primary set, but not published** — @name is saved as your primary username
> on this device. Publishing it failed, so other people will keep seeing your
> old name until it goes through.

That is the right register: state what is true locally, then state plainly what
other people actually see. The same treatment applies here.

## How to fix it

Both remaining options satisfy R2. Pick on sequencing, not on merit.

1. **Re-resolve an elected delegated name when the profile screen opens.** One
   request, only for users who have elected a delegated name, no background
   work. If it no longer maps to you, un-elect and say so.
2. **Fold it into the verification work.** The receiving side already resolves
   claimed names; the self case is the same check pointed at your own address.
   Cheaper if built alongside rather than bolted on after, and it keeps one
   resolve-and-compare implementation instead of two.

**Preferred: (2), if the verification work is being done anyway.** It reuses the
same primitive and avoids a second code path that could disagree with the first
about what "this name is yours" means. Fall back to (1) if that work slips.

~~3. Do nothing and accept it.~~ **Withdrawn 2026-08-09 — see R2 in Status.**

Whichever is chosen, R1 constrains the remedy: un-electing a revoked name is a
removal and is allowed, but the app must NOT then elect a different name the
user happens to hold. It drops to their global display name and waits for them
to choose again.

## Definition of done

- [ ] An elected delegated name that no longer resolves to you stops rendering
      as your `.q` on your OWN device, not only on everyone else's (R2)
- [ ] The user is told, in the register the publish-failure message already uses
- [ ] After the removal the app shows the global display name and elects NOTHING
      in its place, even when the user holds exactly one other eligible name (R1)
- [ ] Owned names are unaffected — they cannot be revoked by anyone else, and
      must not pay for a check they do not need
- [ ] Test: a delegated name repointed away un-elects; an owned name with the
      same shape of record does not
- [ ] Test guarding R1: a user holding exactly one eligible name still has no
      primary until they press the button. This is the test that stops a future
      convenience feature from quietly electing on their behalf

---
*Last updated: 2026-08-09*
