---
type: task
title: "Retire mobile's local QNS claim verification in favour of quorum-shared's"
status: done
priority: medium
complexity: small
created: 2026-08-16
updated: 2026-08-17
area: identity resolution / QNS / shared package adoption
repos: quorum-mobile (this), quorum-shared (source, already landed)
source: filed while implementing the desktop half; shared now owns the predicate both clients need
related:
  - "issues/.open/2026-08-06-verify-claimed-qns-name-before-rendering.md (mobile's original implementation)"
  - "quorum-desktop .agents/issues/2026-08-16-desktop-has-no-q-broadcast-and-renders-claims-unverified.md (§4.1 — the decision to put this in shared)"
---

# Adopt shared's QNS claim verification

## Status

**2026-08-17 — shipped in PR #256** (`refactor(qns): take the claim-verification
predicate from shared, and bound its failure modes`)

What landed: mobile's own claim-verification predicate was deleted and replaced
with `claimedNameBelongsTo` from `@quilibrium/quorum-shared`, fixing a live
latent crash on a non-string resolver key. `QNS_BATCH_LIMIT` now has one
definition shared with desktop, the query cache key is sorted, a misaligned batch
response is refused rather than padded, and the transport's two failure modes
were closed — it no longer caches a resolver outage as "nobody owns anything",
and a failed refetch no longer keeps serving the last verifying records.

Still open, tracked separately: adopting shared's `resolveNamesBatch` as the
transport, which needs shared to carry a base URL and a timeout first —
`issues/.open/2026-08-17-shared-qns-transport-hardcodes-url-and-has-no-timeout.md`.

**The predicate is adopted; the transport deliberately is not.** The work split
in two once the transport turned out to carry properties shared cannot yet
express.

Done (2026-08-17):

- `utils/verifyQnsClaim.ts` deleted; `claimedNameBelongsTo` now comes from
  `@quilibrium/quorum-shared` in all four call sites (`hooks/useVerifiedQnsNames.ts`,
  `identity/identityProvider.tsx`, `components/dev/QnsExplainPanel.tsx`,
  `dev/harness/qns-claim-two-bot.scenario.ts`)
- `QNS_BATCH_LIMIT` now comes from shared and is re-exported, so the constant has
  one definition across both clients
- The transport **throws** instead of swallowing, closing the one-hour
  "nobody owns anything" caching bug described in difference 3 below
- Added an alignment guard mobile did not have: a response whose record count
  does not match the names sent is refused whole rather than padded with nulls
- Cache key is now sorted, matching desktop, so two surfaces holding the same
  claimants in different row order share one request instead of issuing two

Deliberately NOT done, split into
`issues/.open/2026-08-17-shared-qns-transport-hardcodes-url-and-has-no-timeout.md`:

- Replacing `resolveClaimedNames` with shared's `resolveNamesBatch`. Shared's
  version hardcodes `https://names.quilibrium.com` and applies no timeout, while
  mobile's `qnsClient` honours `EXPO_PUBLIC_QNS_API_URL` (`app.config.js:21`) and
  a 30s timeout. Adopting it would have split mobile across two QNS endpoints —
  registering a name against one resolver and verifying it against another.
- The same investigation found that **desktop's claim lookup has no timeout at
  all** and no base URL of its own. That is a live desktop gap, not something
  this migration introduced, and it is the main reason the follow-up is worth
  doing rather than shelving.

### Independent review found a regression this change introduced (fixed)

Five reviewers ran against the diff. Two disagreed about the most important
finding, so it was settled with a probe rather than by picking a side.

**The regression: rejecting instead of swallowing made a refetch failure fail
OPEN.** React Query does not clear `data` when a query errors — its reducer
spreads the previous state and only flips `status`. So once a name set resolved
once, a failed refetch left the last successful `Map` in place and
`data instanceof Map` stayed true. `useClaimRecords` kept serving the stale,
still-verifying records for as long as refetches failed, which removes the
`staleTime` security bound entirely: a name transferred away keeps rendering for
its previous owner with no upper limit.

The previous implementation avoided this ONLY by accident — its empty `Map` was a
resolved value, so React Query replaced the cache with it. Rejecting is still
correct (that is what stops one blip pinning "nobody owns anything" for an hour),
but the two halves had to land together.

MEASURED 2026-08-17, one probe against both implementations, 3 runs each:

| after a failed refetch | records map | outcome |
|---|---|---|
| previous implementation | `size = 0` | fail closed |
| this change, before the fix | `size = 1` (stale, verifying) | **fail OPEN** |

Fixed by gating on query status: `status === 'success' && data instanceof Map`.
Pinned by `__tests__/claimRecordsFailClosedOnRefetchError.test.tsx`, which is
mutation-proven (2 of its 3 cases go red with the gate removed, while its CONTROL
arm stays green, so it is not merely hard-wired to fail).

**A second finding, also fixed:** the cross-implementation `deriveAddress`
agreement test looked stronger than it was. Its 200-key loop passed a
`Uint8Array`, and both implementations short-circuit on
`typeof publicKey === 'string'` — so it never exercised hex parsing, which is the
only place they differ. Now covers the byte path, the hex path and the
`0x`-prefixed path, and separately pins the real divergence on MALFORMED hex
(mobile throws, shared coerces) together with the guard that makes it unreachable
through the predicate.

**A third finding, filed not fixed:** a pre-existing remote DoS in the same
identity path, unrelated to this change and byte-identical to `master` — see
`issues/.secret/2026-08-17-non-string-primary-username-on-the-wire-bricks-the-app.md`.

Reviewer claims NOT carried forward: one reviewer read the stale-map behaviour as
*safer* than documented rather than as a security regression. The probe above
settles it against that reading — on this query, a carried-forward verification
is fail-open, and this file's own docstring makes `staleTime` a security bound.

### Verification (MEASURED)

- Shared's `deriveAddress` and mobile's agree byte-for-byte across 200+ keys,
  despite being different implementations (`multihashes`+`bs58` vs a hand-built
  multihash header + `multiformats`). This is now pinned by a test in
  `__tests__/verifyQnsClaim.test.ts`, because it is a cross-repo invariant that
  neither repo's own suite can catch — each is self-consistent.
- Full suite: 1051 tests, 112 suites, all pass (after the review fixes).
- `npx tsc --noEmit`: 12 errors, the identical set present on `master`; none in
  any touched file.
- `yarn lint`: 458 problems, identical to `master`; none in any touched file.
- **Mutation-proven**: forcing shared's comparison to `return true` turns 11
  tests red across five suites, including
  `claimedNameBelongsTo › rejects a name that resolves to somebody else`,
  `IdentityScopeProvider › never verifies a claim that resolves to a DIFFERENT address`,
  `stripUnverifiedNames › strips a claim belonging to somebody else` and
  `stripUnverifiedNamesInMap › never promotes a broadcast claim that does not resolve to the claimant`.
  Restored and re-confirmed green afterwards.

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

~~`@quilibrium/quorum-shared@2.1.0-43` being published to npm.~~ **Cleared.**
`2.1.0-43` is published and `package.json` already pinned it before this work
started, so the bump below was a no-op.

## Steps

- [x] ~~Bump `@quilibrium/quorum-shared` to `2.1.0-43`~~ — already pinned
- [x] Replace `utils/verifyQnsClaim.ts`'s `claimedNameBelongsTo` with the import
      from `@quilibrium/quorum-shared`, then delete the local file
- [ ] ~~Replace the chunk-and-zip logic with shared's `resolveNamesBatch`~~ —
      **split out**, see Status. Shared's transport cannot carry mobile's base
      URL or timeout yet; tracked in
      `issues/.open/2026-08-17-shared-qns-transport-hardcodes-url-and-has-no-timeout.md`
- [x] Keep `claimIn`, `claimedNamesIn` and the strip/promote helpers in mobile —
      they encode mobile-specific row shapes and the two-transport precedence,
      and are NOT part of what shared owns
- [x] Run the QNS test suite and confirm the impostor case still goes red when
      the comparison is forced to `true`

### Deviation from the original step 2

The step said to delete `__tests__/verifyQnsClaim.test.ts` "once shared's covers
the same ground". **It was kept and rewritten against shared's import instead.**

Shared's own test only runs in shared's repo. Without a copy here, mobile's suite
would go green while the one predicate the whole feature rests on changed in
another repo, and mobile still has its own `deriveAddress` used everywhere else —
so shared and mobile now run two different address derivations that must agree
forever. Nothing but a test holding both at once can catch that drift, because
each repo's suite is self-consistent. The file is now mobile's contract with the
package: a bad shared release fails on the bump, here, before it can reach a
build.

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

All three differences were carried across. 1 and 2 came for free with the
predicate; 3 was ported into mobile's own transport by hand, since that transport
stays for now — `resolveClaimedNames` no longer catches, and
`__tests__/verifiedQnsNames.test.ts` asserts the rejection rather than an empty
map.

## Definition of done

- [x] `utils/verifyQnsClaim.ts` is gone; the predicate comes from shared
- [~] ~~The batch call comes from shared~~ — split out (see Status). The
      `QNS_BATCH_LIMIT` half IS done: the constant now comes from shared and is
      re-exported, so there is no independent local definition.
- [x] The QNS suite passes, and the impostor case is still mutation-proven
- [x] No behaviour change on the happy path: a verified name still renders `.q`,
      an unowned claim still does not

## Out of scope

- `claimIn` / the two-transport precedence — mobile-specific, stays here
- The dev fake-QNS exemption — each client gates its own
- Anything about the broadcast transport itself

---

*Last updated: 2026-08-17*
