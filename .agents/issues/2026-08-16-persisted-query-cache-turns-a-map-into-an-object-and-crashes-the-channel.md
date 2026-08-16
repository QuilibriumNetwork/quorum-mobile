---
type: bug
title: "A persisted query cache turns the claim-records Map into {} and crashes the channel screen"
status: in-progress
priority: high
ai_generated: true
created: 2026-08-16
updated: 2026-08-16
area: "Identity resolution / React Query persistence / security TTL"
---

# A persisted query cache turns the claim-records Map into `{}` and crashes the channel screen

## Status

**2026-08-16 — shipped in PR #249** (`feat: names resolve through one verified
ladder, so a .q shows wherever a name does`), still **awaiting device
confirmation**, which is why it stays in the root of `issues/` rather than
`.done/`.

- [ ] Device-confirmed: the channel that crashed opens cleanly on a fresh build

Close this file when that box is ticked. It is the only fix on the branch with
no device observation behind it, and it is a crash, so the asymmetry favours
leaving it visible.

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

*Last updated: 2026-08-16*
