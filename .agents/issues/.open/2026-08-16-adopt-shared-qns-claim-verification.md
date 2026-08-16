---
type: task
title: "Retire mobile's local QNS claim verification in favour of quorum-shared's"
status: open
priority: medium
complexity: small
created: 2026-08-16
updated: 2026-08-16
area: identity resolution / QNS / shared package adoption
repos: quorum-mobile (this), quorum-shared (source, already landed)
source: filed while implementing the desktop half; shared now owns the predicate both clients need
related:
  - "issues/.open/2026-08-06-verify-claimed-qns-name-before-rendering.md (mobile's original implementation)"
  - "quorum-desktop .agents/issues/2026-08-16-desktop-has-no-q-broadcast-and-renders-claims-unverified.md (§4.1 — the decision to put this in shared)"
---

# Adopt shared's QNS claim verification

## What & why

Mobile shipped claim verification first, in its own files. Desktop then needed
the same check, and rather than a third copy it went into `quorum-shared`
(decided in the desktop issue's §4.1, since `deriveAddress` and `resolveName`
already live there).

So there are now **two implementations of the one check the whole feature rests
on**, and they have already begun to diverge. This task retires mobile's.

Nothing is broken today. Mobile's copy works. This is consolidation, and the
reason to do it soon rather than eventually is that the divergence below is the
kind that gets lost, not the kind that gets noticed.

## Blocked on

`@quilibrium/quorum-shared@2.1.0-43` being published to npm. The version is
bumped and on `master` (shared #81), but **not yet published** at the time of
writing — check before starting.

Mobile currently pins `2.1.0-42`.

## Steps

- [ ] Bump `@quilibrium/quorum-shared` to `2.1.0-43` (or later) in `package.json`
- [ ] Replace `utils/verifyQnsClaim.ts`'s `claimedNameBelongsTo` with the import
      from `@quilibrium/quorum-shared`, then delete the local file and its test
      (`__tests__/verifyQnsClaim.test.ts`) once shared's covers the same ground
- [ ] Replace the chunk-and-zip logic in `hooks/useVerifiedQnsNames.ts`
      (`resolveClaimedNames`, `QNS_BATCH_LIMIT`) with shared's
      `resolveNamesBatch`, which returns a plain object keyed by name
- [ ] Keep `claimIn`, `claimedNamesIn` and the strip/promote helpers in mobile —
      they encode mobile-specific row shapes and the two-transport precedence,
      and are NOT part of what shared owns
- [ ] Run the QNS test suite and confirm the impostor case still goes red when
      the comparison is forced to `true`

## ⚠️ Three differences to carry across, not lose

**1. Shared validates the key before deriving; mobile relies on a throw.**

Shared's `deriveAddress` coerces unparseable hex to zero bytes instead of
throwing, so shared's `readKeyAsHex` checks the key is even-length hex up front.
Mobile's `deriveAddress` is a different implementation and does throw, so
mobile's copy leans on the `catch`. Adopting shared's version keeps the guard —
do not "simplify" it away on the grounds that mobile never needed it.

**2. Shared does not throw on a non-string key field.**

A record is parsed JSON behind a cast; nothing validates it at runtime. Mobile's
`readKeyAsHex` calls `.trim()` directly, so a resolver returning
`{resolveKey: 12345}` throws a `TypeError` that escapes into the render path.
Shared treats a non-string field as absent. **This is a live latent crash in
mobile today** — if this task is deferred, consider porting just that guard.

**3. Shared's batch THROWS on a server error; mobile's swallows it.**

`resolveClaimedNames` catches, logs, and returns an empty `Map`. With
`staleTime: 1h` that means React Query caches a successful "nobody owns
anything" for an hour after a single transient blip, stripping the `.q` from
every legitimate owner for that hour.

Shared's `resolveNamesBatch` rejects instead, so nothing is cached and the next
mount refetches. Same visible behaviour during the outage (fail-closed, no
suffix), much shorter recovery.

Adopting shared therefore **changes mobile's failure behaviour for the better**,
but it is a real behaviour change — expect any test asserting "returns an empty
map on error" to need updating, and update it rather than re-wrapping the call
in a `try/catch` that restores the old caching bug.

## Definition of done

- [ ] `utils/verifyQnsClaim.ts` is gone; the predicate comes from shared
- [ ] The batch call comes from shared; no local `QNS_BATCH_LIMIT` constant
- [ ] The QNS suite passes, and the impostor case is still mutation-proven
- [ ] No behaviour change on the happy path: a verified name still renders `.q`,
      an unowned claim still does not

## Out of scope

- `claimIn` / the two-transport precedence — mobile-specific, stays here
- The dev fake-QNS exemption — each client gates its own
- Anything about the broadcast transport itself

---

*Last updated: 2026-08-16*
