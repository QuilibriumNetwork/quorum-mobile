---
type: doc
title: "Identity resolution — how a member's name is decided, and why a .q can be trusted"
created: 2026-08-16
status: current
applies-to: every surface on mobile that renders a person's name or initials
related_docs:
  - ./notification-system.md
  - ../quorum-shared-architecture.md
purpose: >
  Reference for mobile's `identity/` module: the tier ladder, where the data
  comes from, why QNS claim verification lives inside the provider rather than
  at the call sites, and the rules a new surface has to follow. Written after
  the migration shipped (PR #249) because the architecture's safety properties
  are structural and easy to break by accident.
---

# Identity resolution on mobile

## TL;DR

Every surface that renders a person's name asks `@/identity` for it. Nothing
reads a name field off a roster row, a conversation row or a message payload.

One ladder decides the answer, in this order:

1. **Per-space nickname** — a deliberate override the member set for this space
2. **Verified QNS `.q`** — a registered name proven to belong to this address
3. **Global display name** — their name everywhere else
4. **Truncated address** — `Qm…` , never blank

The rule itself lives in `@quilibrium/quorum-shared` (`resolveIdentity`), so
mobile and desktop rank tiers identically. What mobile owns is the assembly of
the tiers and, critically, the verification of tier 2.

**The safety property, stated once:** an unverified `.q` claim has nowhere to
live. `IdentitySources` carries `verifiedQnsNames` and no raw profile object, so
a surface cannot reach an unverified claim even by mistake. This is not a filter
somebody remembered to apply — it is the shape of the data.

---

## 1. Why this exists

Before the migration, roughly two dozen surfaces each assembled a name by hand
from whatever fields they happened to have. Three consequences, all observed:

- **The tiers disagreed between surfaces.** The same member showed a `.q` in a
  chat bubble and a truncated address in the invite picker, because the picker
  read `conversation.displayName` and a conversation row cannot carry a `.q`.
- **Tests stayed green through all of it.** They exercised the pure resolver,
  and the pure resolver was correct. The defect was never calling it.
- **A forged `.q` was one careless read away.** A claim arrives over the wire as
  a plain string. Any surface that rendered it without checking would have shown
  one member under another member's name.

Desktop learned the same lesson first, and its import-derived migration list
missed roughly 40% of its surfaces — which is why mobile's work-list came from a
grep-shaped audit instead (§6).

## 2. The module

```
identity/
  identityFromMaps.ts      pure: rows + profiles + local names → IdentitySources
  identityProvider.tsx     React: fetching, claim verification, scope merging
  useResolvedName.ts       useResolvedName / formatResolvedName
  MemberName.tsx           the component most surfaces use
  useNameResolver.ts       imperative resolver, for .map() bodies
  RootIdentityScope.tsx    one scope above every screen, carrying real data
  index.ts                 the barrel
```

Two guards keep it that way:

- `__tests__/identityPrimitivesGuard.test.ts` restricts `resolveIdentity` and
  `identityFromMaps` to `identity/` plus one adapter file.
- `__tests__/rawNameFieldAudit.test.ts` fails when any file under `components/`
  or `app/` references a raw name field without importing the resolver.

Both were shown to fire against a live violation, not merely to pass.

## 3. Which API to use

| Situation | Use |
|---|---|
| Rendering a name in JSX | `<MemberName address={...} />` |
| Need the string (a title, an accessibility label) | `useResolvedName(address, opts)` |
| Resolving many inside a `.map()` | `useNameResolver()` → `resolve(address)` |
| Outside React (WebSocket receive path) | `resolveMemberName` from `@/utils/resolveMemberName` — **see §5** |

`opts.global: true` asks for the global identity rather than a per-space one —
correct for DM surfaces, the tab bar and notifications, where no space is in
scope. `opts.enrich` opts into fetching a public profile for an address the
current screen has not already loaded.

**Hooks are hooks.** `useResolvedName` cannot be called inside a `.map()`
callback. Surfaces that need per-row resolution either extract a row component
or use `useNameResolver`. `ShareInviteSheet` has a worked example of the first
shape.

## 4. Where the tiers come from

| Tier | Source |
|---|---|
| Per-space nickname | the space member row's `display_name` |
| Verified `.q` | `verifiedQnsNames`, built by the provider — see below |
| Global display name | the member row's `global_display_name`, or the public profile |
| Truncated address | the address itself |

A `.q` reaches the provider by two transports, and **only the second currently
works end to end**:

- **Route A — the published public profile** (`primary_username`). Dead
  server-side: `POST /users/:addr/public-profile` rejects any payload carrying
  a primary username (upstream #240). Tracked at
  `issues/.open/2026-08-06-server-rejects-every-primary-username-publish.md`.
- **Route B — the profile broadcast** (`claimed_primary_username`). A member
  announces their elected name to every space they are in, and to DM partners.
  Receivers store it under a deliberately separate key. **Mobile-only**: desktop's
  wire payload has no QNS field and desktop stores no such key.

Both land in the same place after verification, so a surface never needs to know
which route a name arrived by.

**Presence, not truthiness, decides a broadcast claim.** An empty broadcast is an
*un-election* — the member is saying "I no longer have a primary name" — and it
must beat a stale stored value. Code that tests a claim for truthiness silently
turns an un-election into "no opinion", and the old name survives.

### Verification

`claimedNameBelongsTo` resolves the claimed name through QNS, derives an address
from the record's ed448 `resolveKey`, and compares it to the claimant. Only names
that pass land in `verifiedQnsNames`. A claim that fails, or whose lookup is
still in flight, is simply absent — the ladder falls through to the global name,
which is the correct degraded behaviour rather than an error state.

Lookups are demand-driven: the provider only resolves addresses a surface asked
about, via `enrich`. **The bound is applied by the surface, not by the
provider** — a list picks the addresses worth enriching with
`qnsLookupAddresses(rows, MAX_QNS_LOOKUPS)` (both exported from
`hooks/chat/useConversationsWithQnsNames.ts`, cap 50) and passes only those.

That split is deliberate: only the surface knows its own cardinality. It also
means **a new list has to opt into the cap**, and forgetting is silent — the
screen works and fires one profile fetch per row. `SpaceSettingsModal` is the
counter-example worth copying: its cardinality is the whole community, so it
enriches **zero** addresses and accepts showing no `.q` rather than fanning out.

## 5. The receive path is different, and must stay different

`services/notifications/logMentionOrReply.ts` and `utils/messagePreview.ts` run
on the WebSocket receive path, outside React. Hooks cannot run there, so
verification cannot run there, so **these files can never mint a `.q`** — and
that is the design, not a gap.

What keeps them safe is one level up: the receive handlers write an incoming
claim to `claimed_primary_username`, never to `primary_username`, and the pure
`resolveMemberName` these files call only reads the latter. An unverified claim
is not on the row they see.

The consequence is visible and correct: a stored notification may show `Alice`
while the same member's chat bubble shows `alice.q`. Rendering the claim on a
lock screen would be exactly the forgery the architecture prevents.

**Anything a user actually reads should resolve at render.** Notification rows
now do (`actorName`, see the notification doc §2); they used to bake the name at
write time, which froze it forever.

## 6. Adding a new surface

1. Import from `@/identity`. Do not read `display_name`, `primary_username`,
   `globalDisplayName` or their siblings.
2. Pick the API from §3. Set `global: true` if no space is in scope.
3. If the surface renders people the screen has not already loaded, pass
   `enrich` — and check the fan-out is bounded.
4. Run `npx jest rawNameFieldAudit`. If it fails, the surface is reading raw.

If a file legitimately must read a raw field — it writes a name rather than
rendering one, or the name belongs to Farcaster rather than to a Quorum member —
add it to `EXCEPTIONS` in the audit **with a reason a reviewer can check against
the file**. A rubber stamp defeats the guard.

**Farcaster is a separate identity namespace.** A cast author has a fid and a
username and no Quorum address. Routing one through the member resolver would
render somebody else's name entirely.

## 7. Known limits

- **The guards are grep-shaped.** A dynamic `require()`, a namespace import or a
  re-export chain would not be seen. They exist to make the class loud, not to
  replace review.
- **Desktop has no claim verification.** It renders `primary_username` off a
  fetched profile without checking ownership. So "desktop shows a `.q`, mobile
  does not" may be mobile correctly refusing an unverified claim. Parity gaps are
  itemised in `issues/2026-08-06-qns-primary-name-work-and-desktop-parity.md`.
- **The Space Settings member list shows no `.q` for anyone.** It reads roster
  rows and never fetches a public profile. Deliberate — its cardinality is the
  whole community — but it means that screen is the wrong place to check whether
  a `.q` renders.
- **No coverage instrument yet.** There is no number for "what fraction of
  rendered names resolved past the address tier". Tracked as Task 11 of
  `issues/2026-08-11-mobile-identity-resolution-plan.md`.

## 8. Testing a `.q` without owning one

A registered QNS name costs money, so every QNS surface is unreachable on a test
account. `components/dev/QnsFakePanel.tsx` (dev builds only) synthesizes them by
intercepting the public-profile read inside `QuorumClient.getPublicProfile` —
one seam, so there is no hook to forget.

Three things about it are worth knowing before trusting a result:

- **"Set locally" is the default action.** It writes an overlay entry and nothing
  leaves the device.
- **"Announce for real" is a one-way door.** It takes the real
  elect-and-broadcast path, so every device that hears it stores the claim
  permanently, and a stored announcement always outranks the overlay. That
  account can then never be given a synthetic `.q` again — not even after
  "Clear", which announces an *empty* name and is still an announcement.
- **"Check announced names" / "Forget announced names"** diagnose and repair
  exactly that state, per device.

`components/dev/QnsExplainPanel.tsx` answers "why does this address show no
`.q`" for a pasted address, distinguishing never-fetched from fetched-and-empty —
a distinction nothing else can see, and the difference between "our surface
forgot to enrich" and "they genuinely have nothing".

**A green sweep proves the ladder and the surfaces, not the network.** Publishing,
the signature payload and the server are not exercised.

---

*Last updated: 2026-08-16*
