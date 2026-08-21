---
type: bug
title: "A persisted query cache turns the claim-records Map into {} and crashes the channel screen"
status: done
priority: high
ai_generated: true
created: 2026-08-16
updated: 2026-08-21
area: "Identity resolution / React Query persistence / security TTL"
---

# A persisted query cache turns the claim-records Map into `{}` and crashes the channel screen

## Status

**2026-08-21 — CLOSED by PR #266**, which retired the crash class instead of
guarding it. See the dated entry below for the mechanism.

The device-confirmation box further down is deliberately left **unticked** and
is no longer a gate. It was written to confirm the `instanceof Map` guard from
PR #249 caught the bad shape on a real build. That guard no longer exists, so
there is nothing left for it to confirm — the shape it rescued is now simply a
valid empty result.

What replaced it as evidence: the crash is reproducible and pinned in-session.
MEASURED — restoring `.get()`-style access makes all four cases in
`claimRecordsSurviveRehydration.test.tsx` fail with the operator's exact error,
`records.get is not a function`. That is the red-on-revert check the standing
rule on `type: bug` asks for, so this closes on tests rather than on a manual
pass that would now be checking the wrong thing.

**2026-08-16 — shipped in PR #249** (`feat: names resolve through one verified
ladder, so a .q shows wherever a name does`), at the time still awaiting device
confirmation, which is why it stayed in the root of `issues/`.

- [ ] Device-confirmed: the channel that crashed opens cleanly on a fresh build

Close this file when that box is ticked. It is the only fix on the branch with
no device observation behind it, and it is a crash, so the asymmetry favours
leaving it visible.

**2026-08-21 — the crash class is now retired structurally, and the guard this
issue shipped is gone.** Adopting shared's QNS transport
(`2026-08-17-shared-qns-transport-hardcodes-url-and-has-no-timeout.md`) changed
the records container from a `Map` to the plain object `resolveNamesBatch`
returns. The persisted value on every affected device is `{}`, which under the
new container is not a broken shape needing rescue — it is a readable, EMPTY set
of records meaning "nothing verified", which is the correct fail-closed answer.
There is no `.get` call left anywhere on the path, so `records.get is not a
function` has nowhere to come from.

The `data instanceof Map` guard was therefore replaced by a plain-object check.
MEASURED, not assumed: restoring `.get()`-style access makes all four cases in
`claimRecordsSurviveRehydration.test.tsx` fail with the original error, so that
file still pins the regression.

The device box above stays UNTICKED — nobody has opened the affected channel on
a build — but what it would confirm has changed. It is no longer "did the guard
catch it", it is "does the retired crash stay retired", and the failure mode if
it were somehow wrong is now a missing `.q` rather than a crash.

⚠️ Related, and the more important half: the same swap silently removed an
ACCIDENTAL protection elsewhere. A `Map` could not survive JSON, so these
records could never be persisted even if the dehydrate exclusion in
`app/_layout.tsx` were deleted; a plain object round-trips perfectly. That
exclusion is now load-bearing and alone. It has been extracted to
`services/offline/shouldPersistQuery.ts` and pinned by
`__tests__/claimRecordsAreNeverPersisted.test.ts` — see the transport issue for
why deleting it would produce a symptomless 24-hour impersonation window.

**Fixed in `bee33ec`. Unit-proven.**

The test reproduces the operator's exact error string
(`records.get is not a function`) with the guard reverted — 2 failed / 1 passed
— and passes with it. Full suite 931 passed. What is NOT yet observed is the
channel opening cleanly on device.

## Summary

Opening one specific channel crashed:

```
TypeError: records.get is not a function (it is undefined)
  settleClaim            (hooks/useVerifiedQnsNames.ts)
  stripUnverifiedNamesInMap
  useVerifiedQnsNamesInMap
  SpaceChatArea          (components/Chat/SpaceChatArea.tsx)
```

Other channels were fine, which made it look channel-specific. It is not.

## Mechanism

`useClaimRecords`' query data is a `Map` (`resolveClaimedNames`,
`hooks/useVerifiedQnsNames.ts:211`). `app/_layout.tsx` wraps the app in
`PersistQueryClientProvider` with **no `shouldDehydrateQuery` filter**, so every
successful query is persisted to MMKV as JSON — and `JSON.stringify(new Map([...]))`
is `{}`.

On rehydration `data` is a plain object with no `.get`, `data ?? NO_RECORDS`
happily returns it because it is not nullish, and `settleClaim` throws on the
first row carrying a claim.

**Why one channel:** the query key is `['qns-verify-claims', names.join('|')]` —
the set of claimed names on that screen. Only a screen whose particular name-set
was in the persisted cache crashes. Nothing about the channel itself.

**Why now:** the fake-QNS overlay gives every member a claim, so the query runs
and gets persisted. Before that most spaces had no claims at all, so
`enabled: names.length > 0` kept it from ever running. **This is not dev-only** —
any real `.q` in a space reaches the identical path, so it was a latent crash
waiting for the feature to start working.

## The second defect, which is the more serious one

That query's `staleTime` is a **documented security parameter**: the window in
which a name transferred away keeps verifying under its previous owner. It is
one hour, and `useVerifiedQnsNames.ts` calls out that a second copy of that
policy would drift.

Persisting the answers under the provider's `maxAge: 24h` did exactly that
drift, silently: verification verdicts survived app restarts for a full day.
Nothing in either file mentioned the other, so neither reads as wrong on its own.

## Fix

Both halves are load-bearing:

1. **Guard** (`useClaimRecords`): `data instanceof Map ? data : NO_RECORDS`.
   This is the UPGRADE PATH — excluding the query from persistence does nothing
   about entries already on disk from older builds. Fail-closed: an unreadable
   cache strips claims rather than trusting a shape it cannot read.
2. **Exclusion** (`app/_layout.tsx`): `shouldDehydrateQuery` drops
   `qns-verify-claims`. Re-verifying on launch costs one batched request.

Do not remove the guard on the grounds that the query is no longer persisted.
That reintroduces the crash for exactly the users who already hit it.

> ⚠️ SUPERSEDED 2026-08-21 — see `## Status`. Half of this section is now
> history rather than instruction. The `instanceof Map` guard in (1) no longer
> exists: the records are a plain object, so the legacy `{}` needs no rescue and
> the crash class is retired at the source. The exclusion in (2) is unchanged
> and MORE important than this section implies — it used to be backed up by the
> `Map` being unpersistable, and it no longer is. It now lives in
> `services/offline/shouldPersistQuery.ts`, not inline in `app/_layout.tsx`.

## Sweep for the same class

READ 2026-08-16. `qns-verify-claims` is the only instance in mobile:

- The three other `Promise<Map<…>>` functions (`getJupiterTokenList`,
  `fetchNativeTokenPrices`, `fetchErc20TokenPrices`, all in
  `services/wallet/balanceService.ts`) are internal helpers, never `queryFn`s,
  so their Maps never reach the cache.
- **quorum-desktop does not persist its query cache at all** — no
  `PersistQueryClientProvider`, no persister — so this class cannot occur
  there. Mobile-only, unusually.

The search was on the `Promise<Map|Set<…>>` signature form. A `queryFn` that
builds a Map inline without that return type would not have been caught.

## Wider lesson worth keeping

A blanket "persist every query" is a standing hazard, not a one-off bug: it
silently assumes every query's data is JSON round-trippable AND that every
query's TTL is safe to extend to `maxAge`. Both assumptions were false here, in
the same query, for unrelated reasons. Prefer an explicit allowlist of what
persists over a filter that removes known-bad keys one crash at a time.

---

*Last updated: 2026-08-21*
