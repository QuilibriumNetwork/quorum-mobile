---
type: bug
title: "A widening sender set resurrects stale QNS verifications past the one-hour bound"
status: done
priority: high
complexity: small
created: 2026-08-17
updated: 2026-08-17
area: identity resolution / QNS claim verification
repos: quorum-mobile (fixed, #257), quorum-desktop (fixed, #352)
source: found by an independent review of the equivalent desktop fix, then confirmed here
related:
  - "issues/.done/2026-08-16-adopt-shared-qns-claim-verification.md (#256, which closed only the first half)"
  - "quorum-desktop .agents/issues/.done/2026-08-17-a-failed-refetch-keeps-serving-stale-qns-verifications.md"
---

# A widening sender set resurrects stale QNS verifications

## Summary

PR #256 gated the claim-records read on the query having actually succeeded,
which closed the direct path: a failed refetch no longer serves the last good
map. **A second path stayed open**, and #257 closes it.

React Query picks a new query's `placeholderData` source by "last query that had
defined data", and an ERRORED query still qualifies, because the error reducer
never clears `data`. It then reports the carried value as `status: 'success'` —
so it passes the gate #256 added, untouched.

After a failed refetch, one new sender was enough to bring back the stale map
through a brand-new query that had verified nothing. With `retry: false` the
errored query never re-attempts, so the resurrected answer never expires.

Scrolling a channel grows the sender set, which is exactly what changes the query
key. This was the ordinary path, not an edge case.

## Status

**Fixed and shipped 2026-08-17 as PR #257** (`1e457de`). Desktop's equivalent is
PR #352.

## Why it matters

The one-hour `staleTime` is a security bound: how long a `.q` transferred to
somebody else can still verify for its previous owner. Both halves of this bug
removed that bound with no upper limit and nothing logged.

The asymmetry is what makes it worth the care: withholding a `.q` from its real
owner is invisible and self-correcting, but granting one to somebody who does not
own it is an impersonation the viewer cannot detect, and a screenshot of it never
expires.

## The fix

```ts
placeholderData: (previous, previousQuery) =>
  previousQuery?.state.status === 'success' ? previous : undefined,
```

`placeholderData` stays — it is what stops every name on screen flickering
whenever a new sender appears. It is narrowed to successful sources, not removed.

Read it together with the `status === 'success' && data instanceof Map` gate from
#256. Either alone reopens the hole.

## How it was found, and the lesson

Not by looking at mobile. An independent review of the **desktop** fix found it
there, and the standing "check both clients" rule brought it back here — where it
revealed that #256, already merged and believed complete, had only ever closed
half the bug.

Worth recording plainly: #256 shipped with a passing mutation-proved test suite.
The tests were real and could fail; they simply did not model a claim set that
WIDENS after a failure. A green suite bounds what you thought to test, not what
is true.

## Verification (MEASURED 2026-08-17)

Before the fix, on both clients: the name correctly dropped to unverified after
the failure, then came back on the widen.

- 1053 tests pass across 112 suites
- Typecheck unchanged (12 pre-existing errors, none in touched files); lint
  warnings identical to `master`
- 4 of 4 deliberate mutations caught, including reverting either half of the fix
  and over-correcting either way

A CONTROL test pins that a HEALTHY widening set still carries the previous
answer, so the fix cannot silently degrade into "placeholder data disabled".

## Definition of done

- [x] A widening sender set after a failure does not resurrect the stale map
- [x] A healthy widening set still carries the previous answer (no flicker)
- [x] Test goes RED with either half of the fix reverted
- [x] quorum-desktop fixed too (#352)

---

*Last updated: 2026-08-17*
