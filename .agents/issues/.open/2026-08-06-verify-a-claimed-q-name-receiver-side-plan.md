---
type: task
title: "Verify a claimed .q name on the receiving client before rendering it as verified"
status: open
priority: high
created: 2026-08-06
updated: 2026-08-09
area: identity resolution / QNS / trust surface
repos: quorum-mobile (first), quorum-desktop (must land together, see §7)
source: §10a of the decoupling design, made concrete after the operator asked what actually happens to a message from a client claiming a name it does not own
related:
  - "issues/2026-08-06-decouple-qns-primary-name-from-public-profile-design.md (§10a — this is the binding requirement)"
  - "issues/2026-08-06-qns-primary-name-work-and-desktop-parity.md (the index for all of it)"
  - "issues/.secret/ — the threat this closes, with the mechanism. Not restated here."
---

# Verifying a `.q` claim, without paying for it on every render

## Status

**2026-08-09 — shipped on mobile in PR #245** (`feat: a primary .q name reaches
other people, and is verified before it renders`). **Left open for desktop and
two measurements** — see the Definition of done.

What landed: the pure check, the strip/promote pass upstream of the resolver,
all four mobile surfaces, and the broadcast transport this plan was a
precondition for. A wire claim lands under `claimed_primary_username` and is
promoted into the rendered field only after it resolves back to the claimant.

Proven rather than argued, in `dev/harness/qns-claim-two-bot.scenario.ts`
(`yarn harness:qns`): two processes, real crypto, production relay, mobile's own
provider on both ends. A claim survives encrypt → wire → decrypt → merge →
persist; it does NOT reach `primary_username`; and a claim to a name the sender
does not own is refused against the live resolver. The test was confirmed able
to fail — disabling the receive-side storage turns the receiving role red.

**Not proven, and worth stating plainly:** that a genuinely owned `.q` renders
AS verified. That needs a real registered name pointed at a throwaway account
and none exists. So forged claims are demonstrably refused; honest ones are not
yet demonstrably accepted. The failure direction is a missing `.q`, never a
wrong one.

**Still open:** desktop (§7 — it must not render the wire field without this
check, and today it ignores the field entirely, so it is degraded rather than
exposed), plus the two on-device cost measurements in §9.


**2026-08-09 — measurement pass against production. Nothing here blocks the
work; four open questions are now answered and §4 is no longer an estimate.**

Every claim below is labelled MEASURED (a recorded observation), READ (read in
source, cited) or INFERRED. The original draft mixed these, and two of its
assumptions turned out to be wrong.

1. **Batching works and is nearly free.** MEASURED — see the table in §4. A
   100-name request costs the same wall clock as a 1-name request, which is what
   makes the whole cost argument hold rather than merely sound plausible.
2. **`resolveKey` is genuinely required — `address` cannot substitute.**
   MEASURED. A resolved record also carries an `address` field, and the obvious
   hope is that it is the owner's Quorum address in another encoding, which
   would let any resolvable name be verified. It is not: it does not equal
   `sha256(resolveKey)`, so it is not the pre-image of a `Qm…`. Do not spend an
   afternoon rediscovering this. §3 stands as written.
3. **Electing a primary name is NOT blocked by the server bug**, which was the
   main doubt about whether this work is premature. READ — `changePrimaryName`
   (`services/profile/primaryNameChange.ts:46-50`) writes locally FIRST and its
   own docstring calls the local write the source of truth; `republishSelfProfile`
   is a separate second step and is the only part upstream #240 breaks. The
   election is stored in user config and already syncs across the user's own
   devices via `mergeSyncedPrimaryName`. **So the choice works today; only the
   telling is broken, and the broadcast transport is a second way to tell.**
4. **The elect flow already refuses a name with no `resolveKey`** — see §3a. A
   check at election time was considered and is NOT needed. Do not build one.

## 1. Why this exists

A `primary_username` is a **self-reported field** in someone else's profile.
Nothing today confirms the name actually resolves to the address it arrived
with. The server intends to check it on publish and that check is broken
(`issues/.open/2026-08-06-server-rejects-every-primary-username-publish.md` (upstream: [quorum-mobile#240](https://github.com/QuilibriumNetwork/quorum-mobile/issues/240))), so
today nothing verifies it anywhere.

Two independent reasons this must be solved on the client:

1. **The broadcast transport removes the server from the loop entirely.**
   Delivering the `.q` over `update-profile` / `dm-update-profile` — currently
   the only route that can work at all — means no server ever sees the claim.
   §10a makes this check binding for that work, not optional.
2. **A `.q` outranks the global name everywhere**, which is exactly why it is
   worth forging. Threat detail is in `.secret/`; not repeated here.

A separate, cheaper guard already shipped: a display name that ENDS in `.q` is
dropped at the resolver, so a claim cannot be forged through the display-name
field. This plan covers the other half — a claim in the *right* field that is
simply not true.

## 2. The rules, before any code

These are load-bearing. Get them wrong and the fix is worse than the bug.

**R1 — Degrade the NAME, never the message.** A failed check changes which name
renders. It never drops, hides, delays or flags a message. Anything else builds
a censorship weapon: forge a profile update as somebody, fail its verification,
and their messages disappear from every client. Delivery and display stay
separate concerns; a message has already passed signature and decryption by the
time any of this runs.

**R2 — Never render optimistically as verified.** While a lookup is in flight,
show the global name and *upgrade* to `.q` on success. Never show `.q` first and
retract it: a screenshot of the moment it said `alice.q` is all an attacker
needs, so the flicker is itself the exploit.

**R3 — Fail closed, on the name only.** Resolver unreachable, 404, ambiguous
answer, offline: show the global name. Under-showing a real `.q` is invisible and
self-correcting. Showing a fake one is not.

**R4 — The resolver stays synchronous and pure.** `utils/resolveMemberName.ts`
must not learn about the network. Verification happens UPSTREAM, at the data
layer, by removing an unverified `primary_username` from the row before it ever
reaches the resolver. Every existing display surface then benefits with zero
changes to any of them — the whole point of having one resolver.

## 3. What the check is

```
claimed name  ──resolve──▶  resolveKey (ed448 pubkey hex)
                                 │
                            deriveAddress()
                                 │
                                 ▼
                        derived Qm address  ===  the address the claim arrived with ?
```

- `getQNSClient().resolveName(name)` → `NameRecord` (`services/api/qnsClient.ts:493`)
- `NameRecord.resolveKey` is the ed448 public key, present only when the name is
  publicly resolvable (`qnsClient.ts:32`)
- `deriveAddress(resolveKey)` → `Qm…` (`services/onboarding/keyService.ts:108`)
- A name with **no `resolveKey`** is not publicly resolvable and therefore
  cannot be verified — treat as unverified, per R3.

Desktop already has this exact derivation in `useResolveQnsName`, wired only to
"type a name to start a DM". Same primitive, new caller.

### The record shape, as production actually returns it

MEASURED 2026-08-09 against `names.quilibrium.com`. A resolved record is:

```jsonc
{
  "header": { "authorityKey": "0x…", "name": "<name>", "parent": null,
              "createdAt": 0, "updatedAt": 0 },
  "address": "0x…",        // 32-byte hex. NOT the owner's Qm address.
  "resolveKey": "…",       // 57-byte ed448 pubkey, hex. OPTIONAL.
  "metadata": null
}
```

Two things to take from it:

- **`resolveKey` is 57 bytes**, matching the ed448 pubkey the type comment
  promises, and matching what the app sends at registration. The derivation in
  §3 is correct as written.
- **`address` is a decoy for our purposes.** It is present on every resolvable
  record, including ones with no `resolveKey`, so it looks like a free way to
  verify any name. It is not `sha256(resolveKey)` — checked directly against
  records that carry both — so it cannot be compared with a `Qm…`. Verification
  requires `resolveKey` and there is no cheaper substitute.

### 3a. The elect flow already gates on `resolveKey` — do not add a second check

READ 2026-08-09, all three elect paths. This was investigated because a name
with no `resolveKey` fails closed forever and shows nobody a `.q`, which would
be a miserable silent failure if a user could walk into it. They cannot:

- **Owned names** (`components/ProfileModal.tsx:1992`) — "Set as Primary"
  renders only when `isResolvable`, which is built from actual `resolve_key`
  presence on the bucket record (`ProfileModal.tsx:1481-1484`) after stealth
  ownership verification. Without it the row offers **"Make Resolvable"**.
- **Delegated names** (`ProfileModal.tsx:2074-2112`) — deliberately not gated,
  and correct. They come from `useReverseLookup(user.publicKey)`, so they are by
  construction names whose `resolveKey` IS this user's key. That is the exact
  condition this plan verifies.
- **Name detail sheet** (`components/qns/NameDetailModal.tsx:516`) —
  `isResolvable && !isPrimary`, same fallback.

Plus `shouldReleasePrimary` un-elects the moment a name stops pointing at you.

A second, independent reason the bad case cannot arise: owned names come from
the bucket lookup keyed on **Quilibrium stealth ownership**, so a name held on
the Ethereum side never appears in "Your Names" and cannot be elected at all.

The gate is UI-level, so it does not constrain a modified client — nor should
it. Stopping a modified client is this plan's job; the gate's job is only to
stop an honest user from ending up with an invisible name.

**Sampling note, so the number below is not misread by a future reader.** A
sweep of 100 registered names taken from the resale marketplace found only 3
carrying a `resolveKey`. That number is real but nearly meaningless here: resale
inventory is names bought to flip, which are exactly the names never pointed at
a Quorum identity. The population this feature touches is names someone elected
primary, and per the gate above those all carry one. Do not use 3% to argue this
feature will rarely fire.

## 4. Cost, which is the whole design constraint

The concern to answer: a space with thousands of members and a long message
list must not pay per render or per message.

It does not, for four reasons:

1. **Keyed by NAME, not by member.** Cache key `['qns-resolve', name]`. Two
   accounts claiming `alice` share ONE lookup, and both are compared against its
   single answer — so a collision is resolved by the same request that verifies
   the real holder.
2. **Only members who claim something.** A member with no `primary_username`
   costs zero. Today that is everyone; realistically it stays a small minority,
   because names cost money.
3. **Only members actually rendered.** Message lists show a bounded set of
   distinct senders; member lists are virtualised.
4. **`resolveBatch(names)` exists** (`qnsClient.ts:500`, max 100 per call). A
   screen's worth of distinct claimed names is ONE request, not N.

Reference point for whether this is affordable: the app **already** fetches a
full public profile per visible member (`useMembersWithPublicProfileFallback`),
and that is accepted. This is strictly smaller and needed for a subset of them.

### Measured, so point 4 is a fact rather than a hope

MEASURED 2026-08-09 against `POST names.quilibrium.com/resolve/batch`:

| Batch size | Result |
|---|---|
| 1 name | 200, 167ms |
| 25 names | 200, 211ms |
| 100 names | 200, **190ms** |
| 150 names | 400 `BATCH_SIZE_EXCEEDED` — "batch size exceeds maximum of 100" |
| 0 names | 400 `MISSING_NAMES` — "names array is required" |

**A hundred names cost the same wall clock as one.** That is the number the cost
argument rests on: a screenful is one request no matter how many claims are on
it, so the per-member cost is not "small", it is nil once any request is being
made at all.

Two hard edges the implementation must handle, both returning 400 rather than
degrading: chunk at **100**, and **never send an empty array**. A naive
`resolveBatch(claims)` on a screen where nobody claims anything is an error
response on every render, not a no-op.

Worked example, the case worth being able to answer out loud — a 5,000-member
space with a long history:

- Opening a busy channel: distinct senders in the loaded window, of whom a
  minority claim a `.q`. **One request.**
- Scrolling the entire member list, if 200 members hold a `.q`: **two requests**,
  spread across the scroll, then cached for an hour and shared with every other
  surface in the app.

### The one surface where this makes something free start costing

`useMembersWithCachedQns` currently issues **zero** network requests. It reads
what chat already cached, with `enabled: false`, and its docstring is explicit
that this is deliberate fetch-storm protection matching a decision desktop made
first. The member list is the one place where adding verification turns a free
screen into a paying one, so it is where a careless implementation will show up.

It is also where fail-closed does the work for us: an unverified row renders the
global name, so a fast scroll needs to fetch nothing at all. Only rows that
settle should be batched. Do not verify on every virtualisation tick.

Note also that the broadcast transport IMPROVES this surface rather than
degrading it: once the claim rides the roster broadcast, learning who claims a
`.q` is free for everyone including members who never posted — the case
`useMembersWithCachedQns` currently cannot cover at all.

### Cache lifetime is a security parameter, not a performance one

A name transferred away keeps verifying until the entry expires. That is the
window in which the previous owner can still render as it.

- `staleTime`: **1 hour**, matching the public-profile cache, so the two age
  together and a member's identity does not half-refresh.
- Invalidate on the same triggers that invalidate public profiles.
- Do NOT extend it for performance without saying so here. The batch call is
  what buys headroom; the TTL is not.

## 5. Where it goes

```
public profile / broadcast
        │  carries primary_username (a CLAIM)
        ▼
useVerifiedQnsNames(rows)          ← new hook, the only place that touches the network
        │  strips the claim unless resolve(name) === row.address
        ▼
mergeMemberIdentity()              ← existing, unchanged
        ▼
resolveMemberName()                ← existing, still pure and synchronous
        ▼
every display surface              ← unchanged
```

Sketch:

```ts
export function useVerifiedQnsNames<T extends { address: string; primary_username?: string | null }>(
  rows: T[],
): T[]
```

- Collect distinct non-empty `primary_username` values.
- **Bail before the network when that set is empty.** An empty array is a 400,
  not an empty result (§4), so the common case — a screen where nobody claims
  anything — must never reach `resolveBatch`.
- One `useQuery` per distinct name (React Query dedupes), or a single batched
  query over the set — prefer the batch, and say in a comment why. **Chunk at
  100**; 101 names is a 400 for the whole request, not a truncated answer.
- Build `Map<name, derivedAddress>`.
- Return rows with `primary_username` **removed** unless
  `map.get(name) === row.address`.

The strip is what makes R2 and R4 true for free: an unverified or in-flight
claim simply is not in the data, so the pure resolver renders the global name
without knowing anything about verification.

## 6. Failure modes, all resolving to "show the global name"

| Case | Verified? | Renders |
|---|---|---|
| Resolves to this address | yes | `alice.q` |
| Resolves to a DIFFERENT address | no | global name |
| Name not found (404) | no | global name |
| Name has no `resolveKey` (made private) | no | global name |
| A DELEGATED name was repointed away by its owner | no | global name |
| Resolver unreachable / offline | no | global name |
| Lookup still in flight | not yet | global name, upgrades on success |

Note the fourth row: making a name private correctly stops it verifying, which
is the read-side counterpart to the write-side cleanup already shipped. Per §3a
this is a narrow case, not a common one — a user cannot elect a name that has no
`resolveKey` in the first place.

**The fifth row is the one worth reading twice, because it is the only case
where a user loses their `.q` through somebody else's action.** A delegated name
is owned by another account that pointed it at you. They can repoint it whenever
they like. `shouldReleasePrimary` will not catch it: that fires only on actions
YOU take (make-private, transfer), and nothing polls for a name being revoked
from under you.

What happens after this plan lands is *correct but asymmetric*: every other
client stops verifying the name and shows your global name, while your own
device still has the election in local config and still renders your `.q` to
you. You would be the last person to know. That is the same shape as the
existing "primary set, but not published" state, which the app already words
honestly, so the fix is a message rather than an architecture change — but it
needs to be a deliberate decision and not a surprise. **Out of scope here;
file it as a follow-up rather than growing this plan.**

## 7. Both clients or neither

A client that renders the wire field without checking it exposes ITS users
regardless of what the other client does. Desktop must not take the broadcast
transport without this, and mobile must not ship the transport before desktop
has the check. Tracked in the parity doc.

## 7a. You cannot test the receive side on one device. Do not try.

MEASURED 2026-08-09. The obvious shortcut — elect a name, let your own broadcast
come back through the space hub, and watch the receive path run on the sending
device — **cannot work, structurally.**

A sender's own echoed message is dropped before decryption is even attempted:

> Check if this is our own echoed message - skip decryption
> (Triple Ratchet participants can't decrypt their own messages)
> — `context/WebSocketContext.tsx:2073-2075`

That is a property of the ratchet, not a filter someone chose and could remove.
Confirmed on device: electing a name logged `[ProfileSync] broadcast sent` for
all four spaces and `[DMProfileSync] broadcast to 4/4 partner(s)`, and produced
**zero** receive-side lines with instrumentation sitting at all three storage
points.

So the send half is verifiable solo and the receive half is not, at any effort.
The routes that remain are a second device, or the headless two-bot harness in
`dev/harness/` — which runs mobile's own client code in Node with real crypto
and real networking, and is the better instrument because it is repeatable.

Note the harness bot currently stubs `updateProfile`
(`dev/harness/bot.ts:180`), so a profile-broadcast scenario needs that wired up
first. Scenarios in that folder run 50-270 lines; this is an afternoon, not a
rewrite.

## 8. Tests

- Pure comparison function: verified / different address / missing resolveKey /
  malformed key. Cheap and the core of it.
- Hook, with the client mocked: in-flight strips the claim; success keeps it; a
  404 strips it; two members claiming one name produce ONE request and exactly
  one verified.
- **Mutation check that matters:** invert the address comparison. If tests stay
  green, they are asserting nothing.
- Explicitly assert R1: a member whose claim fails still has their message
  rendered. This is the test that stops someone "optimising" into a filter.
- **A screen where nobody claims a `.q` issues ZERO requests.** This is the
  common case today and the empty array is a 400 (§4), so getting it wrong is
  an error on every render rather than a quiet inefficiency.
- **101 distinct claimed names produce two requests, not one 400.** The chunk
  boundary is the kind of thing that is never exercised by hand and fails only
  in the largest spaces, which are the ones where it matters.

## 9. Definition of done

- [x] A claim that does not resolve to the claimant's address never renders as `.q`
      — proven end to end in `dev/harness/qns-claim-two-bot.scenario.ts` against
      the live resolver, not only in unit tests
- [x] A message from such a member renders normally, with a degraded name
- [x] Nothing verified is ever rendered before its lookup returns
- [x] One request per distinct name per TTL, batched where more than one is on screen
- [x] Members with no claim cause no requests at all
- [ ] **Same on desktop, landing together with the transport — NOT DONE.** Mobile
      shipped the transport in #245 without it. Desktop ignores the wire field
      today (verified in both receive paths), so its users are not exposed —
      they simply see no `.q`. This is the open item.
- [ ] Measured on a real space: number of requests on opening a busy channel
- [ ] Measured: scrolling a long member list fast does not fire a request per
      virtualisation tick. This surface costs zero today (§4) and is the one
      that will regress silently
