---
type: task
title: "A primary .q name should show to everyone, not only to people who can see your public profile"
status: in-progress
priority: high
created: 2026-08-06
updated: 2026-08-16
area: identity resolution / QNS / wire protocol
repos: quorum-mobile (first), quorum-desktop (same change), quorum-shared (type promotion only, not required)
source: found 2026-08-06 while device-testing the QNS dev overlay — the operator set a primary .q, turned their public profile OFF, and asked whether the .q should still show to other people
related:
  - "issues/.open/2026-08-04-qns-names-and-the-identity-coverage-instrument.md (the plumbing this sits on top of)"
  - "quorum-desktop .agents/docs/features/qns-username-display.md (§Privacy model states the current tie)"
  - "issues/.open/2026-06-10-primary-username-not-synced-or-published.md"
---

# The `.q` is stuck behind the public-profile toggle, and there is no reason for it

## Status

**2026-08-16 — mobile's half SHIPPED and works in production. Desktop's half was
never started.** Recorded here because this document reads as if both are
pending, and a reader who assumes that will re-derive work that already exists.

Verified end to end on mobile:

| Step | Where |
|---|---|
| Broadcast carries `primaryUsername` | `context/WebSocketContext.tsx` ~`:6647`, fingerprinted at ~`:6563` so an in-session election rebroadcasts |
| Space sender accepts it | `services/space/spaceMessageService.ts:915` |
| DM control message accepts it | `services/dm/dmProfileService.ts:91` |
| Receiver stores it | `context/WebSocketContext.tsx:769, 2791, 4709` → `claimed_primary_username` |
| Receiver verifies + promotes it | `hooks/useVerifiedQnsNames.ts` `settleClaim` |

Desktop does **none** of it: it sends only `displayName`/`userIcon`/`bio`
(`quorum-desktop/src/hooks/business/spaces/useSpaceProfile.ts:313-323`) and its
`applyProfileUpdate` (`.../services/MessageService.ts:269`) writes six fields,
none a QNS name — so a `primaryUsername` from mobile is silently dropped.

**Consequence worth stating plainly:** since the public-profile transport is
dead server-side (upstream #240), this broadcast is the ONLY functioning `.q`
transport in the product, and it exists only on mobile.

> ⚠️ The `feat/resolve-identity` branch currently regresses it — the new
> identity ladder does not read `claimed_primary_username`. Tracked as
> `issues/.open/2026-08-16-broadcast-q-claims-never-render-after-the-identity-migration.md`
> and merge-blocking for that branch.

## Decision

**Decouple them.** A primary `.q` name should reach everyone who can see you at
all, regardless of whether your profile is public. Deliver it on the
`update-profile` space broadcast and the `dm-update-profile` DM control message,
alongside the global name that already travels that way.

This is a **client-only change**. No `quorum-shared` release, no server change,
no protocol break. Evidence in §3.

> **Updated 2026-08-06 after measuring production.** This was argued as a second
> transport alongside the public profile. The public-profile transport turns out
> to be **entirely non-functional** — the server refuses every publish carrying a
> `primary_username` (§10). So this is not an addition, it is the only route a
> `.q` has, and it moves from last in the plan to first.
>
> It comes with a condition that was previously waved off: the receiving client
> MUST verify a claimed name against the resolver before rendering it (§10a).
> Removing the server from the loop removes the only party that was ever meant
> to check.

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

## 6c. `primaryUsername` is set in three places and cleared in none

MEASURED by grep, 2026-08-06. Every write to `primaryUsername` in the app:

| Site | Action |
|---|---|
| `ProfileModal.tsx:1928` | set |
| `ProfileModal.tsx:2022` | set |
| `qns/NameDetailModal.tsx:97` | set |

That is the complete list. **There is no code path anywhere that clears it.**
Three consequences, all currently live:

**1. You cannot un-elect a primary name.** When `isPrimary` all three surfaces
render a non-interactive "Primary" badge (`ProfileModal.tsx:1918-1923`,
`2013-2017`, `NameDetailModal.tsx:355-360`). The only escape is electing a
*different* name — so a user who owns exactly one name is stuck with it
permanently, with no way back to their global display name.

**2. Making your primary name private leaves it primary.** `handleMakePrivate`
→ `submitResolveKeyUpdate(false)` clears the resolve key and then does
`Alert` + `onRefresh` and nothing else (`NameDetailModal.tsx:152-165`). Your
`.q` keeps being published and rendered while `resolve/<name>` returns nothing.
The badge points at a name that no longer resolves to you.

**3. Transferring your primary name away leaves it primary.** Same shape —
`handleTransfer`'s success path is `Alert` + `onRefresh` + `onClose`
(`NameDetailModal.tsx:319-324`), no profile write. So you keep publishing a name
somebody else now owns.

⚠️ **(3) is an impersonation vector, not just untidiness.** Nothing on either
client verifies that a claimed `primary_username` resolves back to the claimant
(§5, measured). So after a transfer the new owner elects the name, the old owner
never stops publishing it, and **both accounts render as `alice.q` to everyone**.
The `.q` is presented as a trust marker, which makes this worse than an
ordinary stale field.

### The rule, extended

§6a said electing a `.q` is a display-name change. The corollary is the part
that closes all of this:

> **Anything that changes which name you resolve to is a display-name change:**
> electing, un-electing, making a name private, transferring it away. Each must
> clear or set `primaryUsername` and then run the *same* fan-out — publish the
> public profile, broadcast to spaces, and in merged mode update the Farcaster
> display name.

Stated that way the fan-out pushes **the currently resolved display name**, not
"the `.q`". Un-electing then reverts your Farcaster display name to your global
name automatically, with no special case and no risk of a one-way write leaving
an external system stuck on a name you no longer use.

## 7. What this does NOT change, and what is NOT decided here

- **The public profile keeps carrying `primary_username`.** This adds a
  transport, it does not remove one. Strangers with no shared space still resolve
  a `.q` the existing way.
- **The global display name is not deleted.** It is what you are shown as where
  no `.q` exists, and the fallback if a name is transferred away.
- **Signing `primaryUsername` properly** means adding it to `canonicalize`, which
  WOULD break signature compatibility across versions. Not done here. It is a
  clean, separate ask for the lead.
- ~~**Whether the server validates QNS ownership** on public-profile POST.
  Unknown from these repos.~~ **ANSWERED 2026-08-06 by measurement — see §10.**
  It does validate, and the validation is broken, so the transport this document
  proposes is no longer an addition. It is the only one that works.
- ~~**Verifying a claimed `.q` client-side** is not in scope and may not be
  wanted.~~ **REVERSED 2026-08-06 — it is now a hard requirement, see §10a.**
  That sentence was written while assuming the server checked. It does not, in
  practice, so nothing does.
- **Signing `primaryUsername` properly** means adding it to `canonicalize`, which
  WOULD break signature compatibility across versions. Not done here. It is a
  clean, separate ask for the lead.

## 10. The public-profile transport is DEAD, which promotes this one

Measured 2026-08-06 against production, from a mobile dev build.

`POST /users/:addr/public-profile` carrying a `primary_username` is refused:

```
HTTP 400
qns primary username failed validation: qns lookup: Get "./": stopped after 10 redirects
```

The same publish without the field succeeds. Two names were tried seconds apart
from the same account — one unregistered, one genuinely resolvable to a
different address — and both produced a **byte-identical** error, so the failure
happens before the name is considered. The server's own outbound lookup URL is
malformed. Full write-up:
`issues/.open/2026-08-06-server-rejects-every-primary-username-publish.md` (upstream: [quorum-mobile#240](https://github.com/QuilibriumNetwork/quorum-mobile/issues/240)).

Consequences for this design:

1. **The framing in §7 was wrong.** "This adds a transport, it does not remove
   one" assumed the existing transport worked. It does not, for anyone, and has
   not for as long as anyone can check. The space and DM broadcast is not a
   second road; today it is the only road.
2. **Priority moves.** This was ordered last, as the change that only helps
   private-profile users. It is now the only way a `.q` reaches another human
   without a server fix that is not ours to make.
3. **The public-profile route stays in the plan** for its real audience —
   strangers with no shared space, whom a broadcast can never reach. It just
   cannot be the first one built.

### 10a. Verification is part of the feature, not a follow-up

The server intends to check that a claimed primary name really belongs to the
claimant. That is the right check, and its absence in practice is what makes a
`.q` currently worth nothing as a trust marker.

Broadcasting the `.q` over the space and DM paths removes the server from the
loop entirely. So **shipping this transport without a client-side check would
let any client claim any name, including one belonging to somebody else.** A
`.q` is a real identity on the network; that is not an acceptable state to ship
even briefly.

Requirements, all of them binding:

- **The RECEIVER verifies, not the sender.** A check in the sending client
  protects nobody: a modified client skips it. The receiving client resolves the
  claimed name and confirms it maps back to the sender's address before
  rendering it.
- **Fail closed.** No resolution, no network, ambiguous answer: show the global
  display name. Never render an unverified `.q`. Under-showing a real name is
  recoverable; showing a fake one is not.
- **Cache with a short life.** A name transferred away keeps verifying until the
  cache expires, so the TTL is a security parameter, not a performance one.
  The resolver is healthy and cheap — measured repeatedly the same day.
- **Both clients or neither.** A client that renders the field without checking
  it exposes its own users regardless of what the other client does. Desktop
  cannot take the wire field without also taking the check.

The resolver being the one healthy part of the system is what makes this
practical: `GET names.quilibrium.com/resolve/<name>` answered correctly on every
attempt on 2026-08-06, including for the exact names the server's own lookup
choked on.

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

- [x] **Electing a name primary publishes.** Client side done. The re-fetch check
      cannot pass until the server is fixed — the publish is correctly formed and
      correctly refused (§10)
- [x] A primary name can be un-elected at all (§6c-1) — today it is permanent for anyone owning one name
- [x] Making a name private clears it as primary (§6c-2)
- [x] Transferring a name away clears it as primary (§6c-3) — the impersonation case
- [ ] The join-stamped per-space override no longer masks the `.q` — without this a published `.q` still loses in every space, on either transport
- [ ] **The receiver verifies a claimed `.q` against the resolver before rendering it, and fails closed (§10a)** — blocking for the broadcast transport, not optional
- [ ] The server's QNS lookup is fixed, so the public-profile route works for strangers (not ours; filed)
- [ ] Merged mode fans the CURRENT RESOLVED display name out to the Farcaster DISPLAY name, in both directions, with explicit confirmation, and never touches the fname (§6a, §6c)
- [ ] `primaryUsername` on the mobile send path, included in the dedupe signature
- [ ] Stored on both mobile space receive paths and the DM path, in the global slot group under `globalProfileTimestamp`
- [ ] Same on desktop
- [ ] L2 passes with public profiles OFF on both clients — the acceptance criterion
- [ ] The control arm in L2 checked, not assumed
- [ ] UI no longer implies a `.q` is visible when it is not (or the implication becomes true, which this change makes it)
- [ ] Promoted into shared's `UpdateProfileMessage` type, or a follow-up filed
- [ ] The two lead questions in §7 asked

## Status

**2026-08-09 — the transport shipped on mobile in PR #245**, together with the
§10a verification it was blocked on. `primary_username` now rides the
`update-profile` space broadcast and the `dm-update-profile` DM control message,
and a receiving client resolves the claim before rendering it.

That closes the §10 problem for mobile↔mobile: a `.q` reaches other people
without the server, which is the only route available while the publish endpoint
refuses the field.

**Still open:** desktop, which neither sends nor reads the wire field. Until it
does, a mobile user's `.q` is invisible to desktop users — degraded, not
exposed. §6a merged-Farcaster mode is also still untouched.

**2026-08-06 — the render half shipped in PR #239.** Every surface now resolves
a `.q` through the one ladder, the forged-suffix guard is in, and the join/config
-sync write paths were fixed. That is everything downstream of the network.

**Still not implemented, and the two are linked:** §10a receiver-side
verification (planned in full in
`issues/.open/2026-08-06-verify-a-claimed-q-name-receiver-side-plan.md`) and the
broadcast transport, which §10a is a binding precondition for. Do not ship the
transport first — a client that renders the wire field without checking it
exposes its own users regardless of what the other client does.

Also still open: §6a merged-Farcaster mode.

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

**2026-08-06 — §6b, §6c-1, §6c-2 and §6c-3 shipped as PR #238** (`fix: a
primary .q name is your name, can be un-elected, and actually reaches other
people`), after two independent review passes. Electing now publishes, un-electing
exists, and both make-private and transfer clear the election. Clearing had to
be spelled `''` rather than `undefined` or it silently reverted at the next
login; see `utils/primaryName.ts`.

**2026-08-06 — §10 added, and it reverses two things this document asserted.**
Measured against production: the server refuses every publish carrying a
`primary_username`, for any name, owned or not. So the public-profile transport
is dead rather than merely limited, this transport becomes the only one, and
receiver-side verification (§10a) becomes blocking rather than out of scope.

Blocked on nothing for the client work. §10's server fix is not ours, and the
public-profile route cannot be verified end to end until it lands.

*Last updated: 2026-08-06*
