---
type: task
title: "Let shared's QNS transport carry a base URL and a timeout — desktop has neither"
status: open
priority: medium
complexity: small
created: 2026-08-17
updated: 2026-08-17
area: identity resolution / QNS / shared package
repos: quorum-shared (the change), quorum-desktop (gains a timeout), quorum-mobile (can then retire its chunk loop)
source: found while adopting shared's claim verification in mobile (#256) — the transport gap was not in that issue's scope
related:
  - "issues/2026-08-16-adopt-shared-qns-claim-verification.md (the adoption that surfaced this)"
  - "quorum-shared src/qns/resolveBatch.ts, src/qns/resolver.ts"
---

# Shared's QNS transport hardcodes its URL and has no timeout

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

- [ ] Add `QnsRequestOptions` and thread `baseUrl` + `timeoutMs` through
      `resolveNamesBatch` and `resolveName`
- [ ] Keep accepting a bare `AbortSignal` as the second argument, so desktop's
      existing `resolveNamesBatch(names, signal)` call site is untouched
- [ ] Give `timeoutMs` a bounded default and test that a hung fetch rejects
- [ ] Test that a caller-supplied signal and the internal deadline both abort
- [ ] Publish, then bump desktop and confirm it inherits the timeout
- [ ] Bump mobile, swap `resolveClaimedNames` for `resolveNamesBatch` passing
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

- [ ] Desktop's claim lookup cannot hang indefinitely
- [ ] Both clients resolve QNS through one transport, with mobile's base URL
      honoured on mobile
- [ ] Mobile has no chunk-and-zip loop of its own
- [ ] No behaviour change on the happy path in either client

## Out of scope

- Mobile's wider `qnsClient` (registration, marketplace, bucket lookups) — only
  the claim-verification path is in question here
- The `.q` verification predicate itself, which both clients already share

---

*Last updated: 2026-08-17*
