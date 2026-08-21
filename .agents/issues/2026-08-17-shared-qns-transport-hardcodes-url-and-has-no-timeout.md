---
type: task
title: "Let shared's QNS transport carry a base URL and a timeout — desktop has neither"
status: in-progress
priority: medium
complexity: small
created: 2026-08-17
updated: 2026-08-21
area: identity resolution / QNS / shared package
repos: quorum-shared (the change), quorum-desktop (gains a timeout), quorum-mobile (can then retire its chunk loop)
source: found while adopting shared's claim verification in mobile (#256) — the transport gap was not in that issue's scope
related:
  - "issues/2026-08-16-adopt-shared-qns-claim-verification.md (the adoption that surfaced this)"
  - "quorum-shared src/qns/resolveBatch.ts, src/qns/resolver.ts"
---

# Shared's QNS transport hardcodes its URL and has no timeout

## Status

Both halves are implemented. The issue stays open only until the mobile branch
is merged.

**The shared half shipped 2026-08-17 as quorum-shared PR #83** (`5bd3461`).

What landed: `QnsRequestOptions` (`signal`, `baseUrl`, `timeoutMs`) on both
entry points, a per-request deadline composed with the caller's signal, and
base-URL normalisation. Desktop consumes shared via `link:`, so **it already has
the timeout** — the live gap named below is closed. No desktop or mobile code
change was needed; both call sites compile untouched.

Two things came out differently from the proposal above, both deliberate:

- **`resolveName` does NOT accept a bare `AbortSignal`.** The proposal had both
  entry points take the union. MEASURED with `tsc --strict`: passing a signal to
  an options-only parameter is a compile error (TS2559), because TypeScript's
  weak-type detection rejects an argument sharing zero fields with an
  all-optional interface. So the silent-drop hazard the union was meant to
  prevent does not exist, and the narrower signature is safer. Only
  `resolveNamesBatch` carries the union, purely to keep desktop's existing call
  site compiling.
- **`timeoutMs` opts out via the literal `'none'`, not via `0`.** Any unusable
  number falls back to the default and warns. `Number(unsetEnvVar)` is `NaN` and
  `Math.max(0, budget - elapsed)` is `0`; treating either as "no deadline" would
  have silently reintroduced the exact hang this issue is about.

Verified: 683 tests in shared, 15/15 deliberate mutations caught, built artifact
smoke-tested on real timers, desktop at 0 typecheck errors with 288 identity
tests passing.

**The mobile migration landed 2026-08-21** on `qns/adopt-shared-transport`
(`9ebde48`, `f620750`). Both halves are now done and every box below is ticked.

What landed on mobile:

- `resolveClaimedNames` moved to `services/api/qnsClient.ts` as a thin call into
  `resolveNamesBatch`, passing the `EXPO_PUBLIC_QNS_API_URL`-aware base URL. The
  deadline is left to shared's default, which is the same 30s this client always
  used — passing it explicitly would pin the number in a second place.
- Mobile's chunk-and-re-zip loop is deleted. Its tests went with it, replaced by
  a note saying where that coverage now lives; keying by name leaves no position
  left to misalign.
- The container swap (`Map` → plain object) went through
  `stripUnverifiedNames`, `stripUnverifiedNamesInMap`, `settleClaim`,
  `NO_RECORDS` and `identityProvider`.
- React Query's `signal` is now passed too, in a SEPARATE commit behind its own
  cancellation test — see "The signal was held back on purpose" below.

Verified: 127 suites / 1189 tests green, no new `tsc` or `eslint` problems
against `master` (both baselines measured, not assumed — `master` already fails
`tsc` in 4 unrelated files and carries 302 eslint errors).

### The finding worth remembering: an accidental guard was removed

The `Map` → plain-object swap quietly deleted a second line of defence, and this
was the real risk in the change rather than anything about the transport.

`useClaimRecords`' `staleTime` is a security bound — the window in which a name
transferred away keeps verifying under its previous owner. One hour. The
persister's `maxAge` is 24 hours, so these answers must never reach disk.
`app/_layout.tsx` excluded them, and its comment gave TWO reasons: the security
one, and "it cannot survive the trip anyway" because `JSON.stringify(new Map())`
is `{}`.

The second reason is now false. A plain object round-trips perfectly. So the
exclusion went from belt-and-braces to load-bearing, and **nothing tested it** —
deleting that line would have produced a working, symptomless, 24-hour
impersonation window.

Fixed in the same change: the rule is extracted to
`services/offline/shouldPersistQuery.ts` with the obsolete reason removed, and
pinned by `__tests__/claimRecordsAreNeverPersisted.test.ts`. MEASURED: removing
the exclusion turns 2 of its 5 cases red.

### The signal was held back on purpose

The proposal's `signal` is small value with an outsized failure mode: this
hook's fail-closed rule carries a previous answer forward only from a query that
SUCCEEDED, and a cancellation is a third state nobody had measured. Shipping it
on reasoning would have risked a stale `.q` rendering invisibly for an hour.

So it went in second, behind
`__tests__/claimRecordsAbortSupersededLookup.test.tsx`. MEASURED: React Query
treats cancellation as a REVERT, not a failure — a lookup that never succeeded
stays `pending` with no data and has nothing to carry. Dropping the signal turns
3 of that file's 5 cases red, which also pins the wiring, since React Query only
cancels a fetch whose `queryFn` consumed the signal.

### One assertion that could not be made to fail, labelled as such

`isClaimRecords` excludes a `Map`. MEASURED: deleting that clause changes
nothing observable, because a `Map` read with `records[name]` misses every key
and already degrades to "nothing verified". The clause stays for type honesty
(without it tsc would believe a `Map` is a `QnsBatchResult`), and both the code
and the test now say plainly that it is not covered — so nobody later reads the
green test as proof it does something.

## What & why

`@quilibrium/quorum-shared` owns the QNS network calls both clients need. Both
of them go through one constant:

```
src/qns/resolver.ts:1    export const QNS_BASE_URL = 'https://names.quilibrium.com'
        ├── resolver.ts:25      resolveName()        fetch(`${QNS_BASE_URL}/resolve/...`)
        └── resolveBatch.ts:84  resolveNamesBatch()  fetch(`${QNS_BASE_URL}/resolve/batch`)
```

Neither call takes a base URL, and neither applies a timeout. `resolveNamesBatch`
accepts an `AbortSignal`, but a React Query signal fires on unmount or supersede,
never on elapsed time — so nothing bounds how long a request may hang.

## Who this actually hurts

**Desktop, today.** It has no QNS base URL of its own — there is no
`names.quilibrium.com` string anywhere in `quorum-desktop/src/` — and it calls
`resolveNamesBatch(names, signal)` directly at
`src/identity/useVerifiedQnsNames.ts:213`. So desktop's claim verification has
**no timeout at all**, and no way to point at a non-production resolver. Both are
live gaps, not hypotheticals introduced by any migration.

**Mobile, as a blocked cleanup.** Mobile has its own `services/api/qnsClient.ts`
with a 30s timeout and an `EXPO_PUBLIC_QNS_API_URL` override
(`app.config.js:21`). Because shared cannot carry either, mobile kept its own
chunk-and-zip loop in `hooks/useVerifiedQnsNames.ts` rather than adopt
`resolveNamesBatch` — see the Status section of the adoption issue for why that
split was chosen deliberately.

Note the override is currently **unused**: `EXPO_PUBLIC_QNS_API_URL` is set
nowhere in the repo, and there is no `.env.example`. It is an escape hatch, not
a live configuration. That is why this is medium and not high — but it is also
exactly why adopting shared's transport blind would have been quiet: mobile would
have ended up registering names against one resolver and verifying them against
another, with nothing in either code path saying so.

## Proposed change

Widen the two entry points to take options, keeping the current behaviour as the
default so no existing caller changes:

```ts
export interface QnsRequestOptions {
  signal?: AbortSignal;
  /** Defaults to QNS_BASE_URL. */
  baseUrl?: string;
  /** Defaults to something bounded (30s matches mobile's client). */
  timeoutMs?: number;
}

export function resolveNamesBatch(
  names: string[],
  opts?: QnsRequestOptions | AbortSignal,   // accept the bare signal for compatibility
): Promise<QnsBatchResult>
```

Implement the timeout with an `AbortController` that composes with a
caller-supplied signal, so both an unmount and an elapsed deadline abort the same
request.

## Steps

- [x] Add `QnsRequestOptions` and thread `baseUrl` + `timeoutMs` through
      `resolveNamesBatch` and `resolveName`
- [x] Keep accepting a bare `AbortSignal` as the second argument, so desktop's
      existing `resolveNamesBatch(names, signal)` call site is untouched
- [x] Give `timeoutMs` a bounded default and test that a hung fetch rejects
- [x] Test that a caller-supplied signal and the internal deadline both abort
- [x] Publish, then bump desktop and confirm it inherits the timeout — shared published; mobile pins `2.1.0-45`. Desktop links shared locally, so it already had it.
- [x] Bump mobile, swap `resolveClaimedNames` for `resolveNamesBatch` passing
      mobile's configured base URL, and delete mobile's chunk loop

## Watch out for

**The return shape differs from mobile's current one.** `resolveNamesBatch`
returns a plain object keyed by name; mobile's `resolveClaimedNames` returns a
`Map`, and mobile's strip helpers take a `ReadonlyMap`. Swapping the transport
means swapping the container across `stripUnverifiedNames`,
`stripUnverifiedNamesInMap` and `settleClaim` in the same change — they are
coupled, and doing the container separately buys nothing.

That swap also **removes a crash class rather than adding one**: mobile carries a
`data instanceof Map` guard because React Query's MMKV persistence serialises a
`Map` to `{}`, which then threw `records.get is not a function` and took the
channel screen down. A plain object rehydrates as an empty object, which means
"nothing verifies" — fail-closed and correct. Update
`__tests__/claimRecordsSurviveRehydration.test.tsx` deliberately rather than
deleting it; it should still prove the rehydrated shape cannot promote a claim.

## Definition of done

- [x] Desktop's claim lookup cannot hang indefinitely
- [x] Both clients resolve QNS through one transport, with mobile's base URL
      honoured on mobile
- [x] Mobile has no chunk-and-zip loop of its own
- [x] No behaviour change on the happy path in either client

## Out of scope

- Mobile's wider `qnsClient` (registration, marketplace, bucket lookups) — only
  the claim-verification path is in question here
- The `.q` verification predicate itself, which both clients already share

---

*Last updated: 2026-08-21*
