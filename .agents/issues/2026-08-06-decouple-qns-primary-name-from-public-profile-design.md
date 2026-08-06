---
type: task
title: "A primary .q name should show to everyone, not only to people who can see your public profile"
status: in-progress
priority: high
created: 2026-08-06
updated: 2026-08-06
area: identity resolution / QNS / wire protocol
repos: quorum-mobile (first), quorum-desktop (same change), quorum-shared (type promotion only, not required)
source: found 2026-08-06 while device-testing the QNS dev overlay — the operator set a primary .q, turned their public profile OFF, and asked whether the .q should still show to other people
related:
  - "issues/.open/2026-08-04-qns-names-and-the-identity-coverage-instrument.md (the plumbing this sits on top of)"
  - "quorum-desktop .agents/docs/features/qns-username-display.md (§Privacy model states the current tie)"
  - "issues/.open/2026-06-10-primary-username-not-synced-or-published.md"
---

# The `.q` is stuck behind the public-profile toggle, and there is no reason for it

## Decision

**Decouple them.** A primary `.q` name should reach everyone who can see you at
all, regardless of whether your profile is public. Deliver it on the
`update-profile` space broadcast and the `dm-update-profile` DM control message,
alongside the global name that already travels that way.

This is a **client-only change**. No `quorum-shared` release, no server change,
no protocol break. Evidence in §3.

## 1. The symptom

Set a QNS name primary, turn your public profile OFF, and nobody else ever sees
your `.q`. Not in a space, not in a DM, nowhere. Your own profile screen shows
it, so it looks like it is working.

### The UI copy is not silent — it is worse than silent

An earlier draft of this section claimed "nothing in the UI says this." **That
was wrong**, corrected 2026-08-06 from a device screenshot. The Public Profile
toggle reads (`components/ProfileModal.tsx:4284`):

> "Let anyone see your display name, picture, bio, and QNS username — **even
> outside shared spaces**. Off by default."

So the tie is disclosed. But read it as a user: "even outside shared spaces"
states that the toggle *extends* visibility beyond your spaces, which strongly
implies your QNS username is already visible **inside** them. It is not. The
copy is actively misleading in exactly the direction that misled both people on
this thread, one of whom wrote the resolver.

That makes the copy a defect in its own right, independent of whether §6 ships.
If the transport change lands, the sentence becomes true and needs no edit. If
it does not, the sentence has to change.

## 2. Why they are tied today

READ, and it is a single mechanism rather than a policy:

- `primary_username` exists in exactly two places in `quorum-shared`: on
  `PublicProfile` (`types/user.ts:164`) and on `UserConfig` (`types/user.ts:93`).
  The `UserConfig` copy is the encrypted cross-device blob, and its own comment
  says it is "Synced cross-device so a user's primary username reaches **their
  other devices**." Your devices. Never anybody else's.
- `UpdateProfileMessage` (`types/message.ts:30-46`) — the space profile
  broadcast — carries `displayName`, `userIcon`, `bio`, `globalDisplayName`,
  `globalUserIcon`, `globalBio`, `spaceTag`. **There is no field for the QNS
  name.** `DMUpdateProfileMessage` (`types/message.ts:49-56`) has even fewer.
- Mobile's sender (`services/space/spaceMessageService.ts:880-890`) therefore
  cannot send one.
- Publishing the public profile is gated on the toggle
  (`components/UnifiedProfileEditModal.tsx:139`).

So the public profile is the `.q`'s only transport, and the toggle closes it.

**This reads as an accident, not a decision.** The public profile was the only
existing structure carrying arbitrary profile fields, so the `.q` was put there.
No document anywhere argues that a `.q` *ought* to be private.

## 3. Why it is client-only (the load-bearing fact)

READ, `quorum-shared/src/utils/canonicalize.ts:54-59`. The signed payload for an
update-profile message is:

```ts
if (pendingMessage.type === 'update-profile') {
  return pendingMessage.type + pendingMessage.displayName + pendingMessage.userIcon;
}
```

Only `type`, `displayName` and `userIcon`. Every other field on the message —
`bio`, `globalDisplayName`, `globalUserIcon`, `globalBio`, `spaceTag` — is
already outside the signature.

Two consequences:

1. **Adding a field cannot break signature verification**, on any client, of any
   version.
2. **Old clients ignore unknown fields**, so a mixed-version network degrades to
   current behaviour rather than erroring.

And this is not a theory — it is the pattern already in production. Mobile ships
`globalDisplayName` / `globalUserIcon` / `globalBio` on the wire via an untyped
cast, with the reasoning written at `spaceMessageService.ts:891-894`: *"additive
and not yet in shared's UpdateProfileMessage (additive shared PR pending,
non-blocking). Wire-compatible: receivers read them untyped."* Those fields
shipped and worked before `quorum-shared` had ever heard of them.

Promoting `primaryUsername` into the shared type afterwards is good hygiene and
should happen, but it is **not a prerequisite** and must not be treated as one.

## 4. Why they should be decoupled

### 4a. Electing a name primary IS the consent

You register a name. You separately make it resolvable. You then separately
elect it primary. Three deliberate acts. Requiring a *fourth*, much broader
consent — exposing your display name, avatar and bio to any stranger holding
your address — before the third is honoured does not follow from anything.

The bundle forces a trade nobody asked for: to be known as `alice.q` you must
also hand over your photo and bio to people you have never met.

### 4b. The privacy counter-argument does not survive contact with the code

The obvious objection is that showing a `.q` links an in-app address to a
globally-resolvable name that may carry payment or ownership history. That
objection was raised during design and **refuted on two independent grounds**:

**You cannot elect a name primary unless it is already resolvable.** READ,
`components/qns/NameDetailModal.tsx:414` — "Set as Primary" renders only when
`isResolvable && !isPrimary`. ProfileModal's two entry points gate the same way
(`ProfileModal.tsx:1914-1935`, `2006-2029`). So `name → address` is *already
published by the user's own hand* before "primary" is even offered. Electing
primary adds no new public information; it changes which of your names the app
displays.

**The reverse direction is already a public one-call lookup.** READ,
`services/api/qnsClient.ts:511` — `GET /reverse/{keyOrAddress}` returns the names
registered to an authority key or address, unauthenticated. For a resolvable
name the authority key is the user's own ed448 public key
(`NameDetailModal.tsx:148`), which is the same key a spacemate needs to verify
their message signatures.

So the "practical obscurity" the objection depends on does not exist. There is
no privacy cost to showing the `.q` to people who can already see you.

### 4c. The three concepts, once separated

| Setting | Means | Audience |
|---|---|---|
| Resolvable | "people can find my address by this name" | the whole internet |
| **Primary** | **"this is the name I go by"** | **anyone who can see me** |
| Public profile | "strangers can see my name, avatar and bio" | anyone with my address |

The third has no business gating the second. They are answers to different
questions.

## 5. The honest costs

Stated because the trade is real, not to argue against the change.

**The field travels unsigned.** Because `canonicalize` covers only `displayName`
and `userIcon`, a relay could strip or alter `primaryUsername` in transit. The
public-profile route is stronger here: its v2 signature explicitly covers
`primary_username` (`services/profile/publicProfile.ts:92-100`).

Two things keep this from blocking:

- `bio` and `globalDisplayName` already travel unsigned by exactly this
  mechanism. This is not a new class of weakness, and treating it as one would
  imply those fields are also unacceptable.
- **The `.q` is not verified today anyway.** MEASURED by grep: `useResolveName`
  is called in exactly two places — `NewConversationModal.tsx:93` (you typing a
  name to start a DM) and `ProfileModal.tsx:1374` (you shopping for a name to
  buy). **No call site anywhere takes a `primary_username` off someone's profile
  and checks that it resolves back to their address.** The v2 signature proves
  the claimant signed the claim, not that they own the name. So desktop's doc
  sentence — "a trust marker: it only appears on verified QNS names" — is not
  currently true on either client.

Whether the *server* validates ownership on POST is unknown from the client
repos and is a question for the lead (§7).

## 6. What changes

Per client, symmetrical. Mobile first, desktop identical.

**Send.** Add `primaryUsername` to the update-profile content builder
(`spaceMessageService.ts:880-890`), using the same untyped-additive cast the
global slots already use. Same for the DM control message. Include it in the
broadcast-dedupe signature (`profileBroadcastSignature`) or a `.q` change will
be swallowed by the gate and never sent.

**Receive.** Store it on the member row. It belongs in the **GLOBAL slot group**,
not the override group — it is part of your global identity, so it shares
`globalProfileTimestamp` and the `applyGlobal` staleness guard.

⚠️ **Mobile has TWO space receive paths** and both must be changed or the field
arrives on one and not the other: `WebSocketContext.tsx:2705-2765` (inbox) and
`~4620-4664` (the native-batch path). The DM side is
`WebSocketContext.tsx:719-745` / `~3487`.

**Resolve.** No change. `resolveMemberName` already reads `primary_username` off
the row and ranks it correctly. Once the field arrives, the ladder works.

**Precedence.** Unchanged: per-space override → `.q` → global → address. When
both a public profile and a broadcast supply a `.q` they will agree, since both
come from the same `user.primaryUsername`.

## 6a. The `.q` is a DISPLAY NAME, not a username — and that decides the Farcaster question

Added 2026-08-06 after the merged-profile case was raised. The product copy calls
it a "QNS username" and `ProfileSplitModeModal.tsx:37` says "Fname and QNS
usernames always stay in their own system", which reads as: the `.q` is a handle
like an fname, so it should sit beside `@fname` rather than replace a name.

**That classification is wrong, and the code already disagrees with it.**

| | Farcaster | Quorum |
|---|---|---|
| Username (handle) | `@gattopardo` (fname) | — none. There is an address. |
| Display name | "GattoPardo Far" | display name, **overridden by the `.q`** |

`primary_username` sits in the DISPLAY-NAME ladder (`resolveDisplayName`:
override → `.q` → `display_name` → address) and beats `display_name`. It never
competes with a handle, because Quorum has no handle. Functionally it is a
display name that happens to be registered.

Three consequences:

1. **The `.q` belongs in the name slot in every layout**, including merged —
   not in the handles row next to `@fname`. Those are different kinds of thing.
2. **In MERGED mode the `.q` should fan out to Farcaster's display name.** Merge
   means one display name across both systems; the `.q` is the display name.
   `UnifiedProfileEditModal.tsx:253-271` already writes `displayName` to
   Farcaster on a merged save — it just currently sends the global name.
3. **The Farcaster USERNAME is never touched.** `@gattopardo` is a handle in
   another system. Confirmed unchanged by anything here.

In SPLIT mode the two identities stay separate, so the Farcaster card keeps its
own display name and only the Quorum card shows the `.q`.

### The rule this collapses to

**Electing a `.q` primary is a display-name change, so it must do everything a
display-name change does**: publish the Quorum public profile, broadcast to
spaces, and — in merged mode only — update the Farcaster display name.

Today it does none of them (§6b). That single rule explains the publish bug, the
staleness, and the Farcaster gap as one omission rather than three.

⚠️ **Consent caveat, and it is not optional.** Writing a user's Farcaster display
name is a write to an external, public system. "Set as Primary" lives in the QNS
section and mentions nothing about Farcaster. Silently renaming someone's
Farcaster profile because they elected a QNS name would be a genuinely bad
surprise. The fan-out must name what it is about to change and be confirmed.

## 6b. Electing a name primary does nothing at all today

MEASURED 2026-08-06 against production. An account with a real, resolvable `.q`
(`GET names.quilibrium.com/resolve/lamat` returns its resolve key) and a
published public profile has **no `primary_username` on the server**:

```
GET api.quorummessenger.com/users/<addr>/public-profile
→ keys: bio, display_name, profile_image, signature, timestamp
```

READ, the cause: all three "Set as Primary" handlers
(`ProfileModal.tsx:1928`, `ProfileModal.tsx:2022`,
`qns/NameDetailModal.tsx:96`) are two lines — `updateProfile({ primaryUsername })`
then an `Alert`. Publishing only happens on a profile save or a public-toggle
flip (`ProfileModal.tsx:735, 1152, 1266`, `UnifiedProfileEditModal.tsx:142`).

So the name sits in local storage and never reaches the wire. This is the
unresolved remainder of
`issues/.open/2026-06-10-primary-username-not-synced-or-published.md`.

**This is the first thing to fix.** It is small, client-only, needs no design
decision, and unblocks every public-profile user immediately — where §6's
transport change only helps people who keep their profile private. It is also
verifiable from outside the app by re-fetching the endpoint above.

## 7. What this does NOT change, and what is NOT decided here

- **The public profile keeps carrying `primary_username`.** This adds a
  transport, it does not remove one. Strangers with no shared space still resolve
  a `.q` the existing way.
- **The global display name is not deleted.** It is what you are shown as where
  no `.q` exists, and the fallback if a name is transferred away.
- **Signing `primaryUsername` properly** means adding it to `canonicalize`, which
  WOULD break signature compatibility across versions. Not done here. It is a
  clean, separate ask for the lead.
- **Whether the server validates QNS ownership** on public-profile POST. Unknown
  from these repos. The answer decides whether the `.q` badge means anything
  today; ask the lead.
- **Verifying a claimed `.q` client-side** (resolve it, check it maps back to the
  claimant) is not in scope and may not be wanted — it is a fetch per name. Filed
  as an observation, not a proposal.

## 8. How we verify

| Lane | What |
|---|---|
| **L1** | Table tests: the field survives send → receive on both space paths and the DM path; a stale broadcast does not clobber a newer `.q`; an absent field means "no change" and does not clear an existing one |
| **L2** | Two real clients, profile **private** on both. A sets a primary `.q`; B sees `a.q` in a space message, a mention, a reaction and a DM. This is the whole point of the change and cannot be faked by the dev overlay |
| **L2 (control)** | B sets a per-space name for themselves; it must still outrank their `.q`. If everything converges on the `.q`, precedence has been inverted and the run is a false pass |
| **L3** | The broadcast gate still dedupes: saving a profile twice with no change sends once |

**The dev overlay cannot substitute for L2.** It fakes the READ, so it proves the
render path and nothing about the wire. That distinction is the entire reason
this issue exists.

## 9. Definition of done

Ordered. §6b first — it is small, needs no decision, and helps the larger group.

- [ ] **Electing a name primary publishes.** Verified by re-fetching the live public-profile endpoint and seeing `primary_username` appear (§6b)
- [ ] The join-stamped per-space override no longer masks the `.q` — without this a published `.q` still loses in every space
- [ ] Merged mode fans the `.q` out to the Farcaster DISPLAY name, with explicit confirmation, and never touches the fname (§6a)
- [ ] `primaryUsername` on the mobile send path, included in the dedupe signature
- [ ] Stored on both mobile space receive paths and the DM path, in the global slot group under `globalProfileTimestamp`
- [ ] Same on desktop
- [ ] L2 passes with public profiles OFF on both clients — the acceptance criterion
- [ ] The control arm in L2 checked, not assumed
- [ ] UI no longer implies a `.q` is visible when it is not (or the implication becomes true, which this change makes it)
- [ ] Promoted into shared's `UpdateProfileMessage` type, or a follow-up filed
- [ ] The two lead questions in §7 asked

## Status

**2026-08-06 — design agreed, not yet implemented.** Written after the privacy
counter-argument in §4b was raised and then refuted against source.

Reordered the same day after measuring production: §6b (electing a name primary
never publishes) is the first fix, not the transport change. The `.q` is broken
today even WITH a public profile, which the original draft assumed worked.

§6a added after the merged-Farcaster case: the `.q` is a display name, not a
handle, which is why it belongs in the name slot everywhere and why merged mode
should carry it to Farcaster's display name.

§1 corrected: the UI copy does disclose the tie, and is misleading rather than
silent. The earlier claim that it said nothing was wrong.

Blocked on nothing.

*Last updated: 2026-08-06*
