---
type: task
title: "Verify a claimed .q name on the receiving client before rendering it as verified"
status: open
priority: high
created: 2026-08-06
updated: 2026-08-06
area: identity resolution / QNS / trust surface
repos: quorum-mobile (first), quorum-desktop (must land together, see §7)
source: §10a of the decoupling design, made concrete after the operator asked what actually happens to a message from a client claiming a name it does not own
related:
  - "issues/2026-08-06-decouple-qns-primary-name-from-public-profile-design.md (§10a — this is the binding requirement)"
  - "issues/2026-08-06-qns-primary-name-work-and-desktop-parity.md (the index for all of it)"
  - "issues/.secret/ — the threat this closes, with the mechanism. Not restated here."
---

# Verifying a `.q` claim, without paying for it on every render

## 1. Why this exists

A `primary_username` is a **self-reported field** in someone else's profile.
Nothing today confirms the name actually resolves to the address it arrived
with. The server intends to check it on publish and that check is broken
(`issues/.open/2026-08-06-server-rejects-every-primary-username-publish.md`), so
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
- One `useQuery` per distinct name (React Query dedupes), or a single batched
  query over the set — prefer the batch, and say in a comment why.
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
| Resolver unreachable / offline | no | global name |
| Lookup still in flight | not yet | global name, upgrades on success |

Note the fourth row: making a name private correctly stops it verifying, which
is the read-side counterpart to the write-side cleanup already shipped.

## 7. Both clients or neither

A client that renders the wire field without checking it exposes ITS users
regardless of what the other client does. Desktop must not take the broadcast
transport without this, and mobile must not ship the transport before desktop
has the check. Tracked in the parity doc.

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

## 9. Definition of done

- [ ] A claim that does not resolve to the claimant's address never renders as `.q`
- [ ] A message from such a member renders normally, with a degraded name
- [ ] Nothing verified is ever rendered before its lookup returns
- [ ] One request per distinct name per TTL, batched where more than one is on screen
- [ ] Members with no claim cause no requests at all
- [ ] Same on desktop, landing together with the transport
- [ ] Measured on a real space: number of requests on opening a busy channel
