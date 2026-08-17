---
type: bug
title: "Every `await import(...)` silently took its error branch under jest, so tests walking those paths were green for the wrong reason"
status: done
complexity: low
priority: high
ai_generated: true
created: 2026-08-17
updated: 2026-08-17
area: test infrastructure / false-confidence
related:
  - "quorum-desktop .agents/issues/.open/2026-08-08-record-and-show-what-the-last-config-publish-actually-did.md"
---

# Dynamic imports silently took their error branch under jest

> **⚠️ AI-Generated**: May contain errors. Verify before use.
> Everything below labelled MEASURED has a recorded observation behind it.
> Nothing here is inferred and stated as fact — that distinction is the whole
> subject of this issue.

## Status

**2026-08-17 — done.** The mechanism was fixed in PR #252; the audit that kept
this open was completed the same day and found the blast radius to be far
smaller than feared, but only after building an instrument to measure it rather
than reading call sites by eye.

Two things landed:

| Where | What |
|---|---|
| PR #252 | `jest/babel-plugin-dynamic-import-to-require.js`, wired into `babel.config.js` for the test environment only, reused by `dev/harness/babel.harness.js` behind an identity guard |
| this branch | the coverage instrument (`yarn test:dyn-trace`), the audit result below, and `__tests__/dynamicImportTransform.test.ts` guarding the wiring in both directions |

## What happened

The React Native babel preset deliberately leaves `import()` untransformed,
because Metro turns it into async bundle loading at build time. A jest VM has no
Metro, so the call reached Node's ESM loader and threw:

```
A dynamic import callback was invoked without --experimental-vm-modules
```

That throw is **invisible rather than loud** wherever the call site is wrapped in
a `try`/`catch`, which is the common shape here. The code under test still
"runs"; it just always takes the failure path, and the suite still reports green.

**MEASURED 2026-08-17 (corrected count):** **93 dynamic-import call sites across
40 files** in `app/ components/ context/ hooks/ services/ modules/ utils/` — 63
of them awaited, and **41 sitting inside a `try`/`catch`**.

> The figure originally recorded here was "64 across 29 files". That counted only
> the literal string `await import(`, missing every `void import(...).then(...)`,
> every `React.lazy(() => import(...))` and every non-awaited chain — which are
> affected identically. The corrected count comes from
> `scripts/dynamic-import-coverage.js`, which blanks comments and string bodies
> before matching, so it also drops the three matches inside prose that a plain
> grep counted.

## How it was found, which is the part worth keeping

Writing acceptance tests for the device-local `allowSync` fix
(`services/config/configService.ts`, `getConfig`'s adopt site). The first draft
of the control arm — *a device that had sync ON still has it ON after a pull* —
**passed on the unfixed tree**, which looked like a correct control arm result.

It was passing vacuously. `verifyConfigSignature` reaches the native module via
`await import('../../modules/quorum-crypto/src')`, its `catch` returns `false`,
and `getConfig` then returns the local config unread. So the test never got
within a hundred lines of the code it claimed to exercise, and it would have gone
on passing no matter what the adopt site did.

What caught it was adding `expect(mockVerifyEd448).toHaveBeenCalled()` — an
assertion that the path was *reached*, not just that the answer was right. That
is the generalisable lesson: **a passing control arm is not evidence unless
something asserts the code under test was actually entered.**

## The sequel, same day: the fix itself broke the harness, twice, silently

Both faults are recorded because each one **impersonated a product bug** rather
than failing loudly, which is the same defect class as the original.

**1. A relative plugin path.** `babel.config.js` named the plugin by path.
`dev/harness/babel.harness.js` composes that config by requiring and *calling*
it, and Babel then resolved the path against its own internals — every harness
scenario died at config load. That one WAS loud (11 suites, 0 tests). Fixed by
passing the function instead of a path.

**2. The transform applied twice.** `babel.harness.js` already carried its own
inline copy, reaching the same conclusion independently. With both active, each
pass rewrites `import(x)` to `Promise.resolve().then(() => require(x))`, so the
second pass emits `require(function(){…})` and jest's resolver throws
`moduleName.startsWith is not a function` — **inside the try/catch that nearly
every dynamic-import call site sits in.** So the symptom was not a crash: the
brand-new config-sync scenario reported a perfectly working sync protocol as
broken, and the first conclusion drawn from it was wrong.

Consolidated to one implementation, with an identity guard in `babel.harness.js`.
Both regressions now have a test — see "The guard" below.

> **The claim this corrects, stated plainly because it was reported as evidence.**
> "The offline harness matches its baseline exactly, so the babel change is safe"
> was wrong. It proved nothing broke LOUDLY. Every dynamic import in the harness
> was broken at that moment, and the offline scenarios pass either way because
> the call sites catch their own errors. A green suite is not evidence about
> code whose failure mode is a swallowed exception — which is the entire premise
> of this issue, missed while fixing this issue.

## The fix

`jest/babel-plugin-dynamic-import-to-require.js` rewrites `import(x)` to
`Promise.resolve().then(() => require(x))`, applied in the test environment only
via `api.env('test')` in `babel.config.js`. Written locally rather than adding
`@babel/plugin-transform-dynamic-import`, which is not in the tree and is not
worth a dependency for twenty lines. `@babel/plugin-transform-modules-commonjs`
does **not** cover this — dynamic import has been a separate transform since
Babel 7.8, and trying it first was a dead end.

Side benefit: `jest.mock()` now works on modules reached through a dynamic
import, which it could not before.

## The audit — what it actually found

The open question was "the other call sites are unaudited, and turning the
transform on makes those paths reachable". Reading 93 sites by eye would have
produced an opinion, not a measurement, so the audit was done with two
independent instruments that had to agree.

### Instrument 1 — runtime coverage tracing

`TRACE_DYNAMIC_IMPORTS=1` makes the babel plugin emit a self-report at each
rewritten site, collected by `jest/dynamic-import-trace.js` and joined against a
static scan by `scripts/dynamic-import-coverage.js`. One command:

```
yarn test:dyn-trace
```

**MEASURED: 1 of 93 call sites executes under the entire suite.**

```
Dynamic import call sites: 93 (41 inside a try/catch)
Covered by the suite:      1
Never executed:            92
```

The one live site is `services/config/configService.ts:388`
(`import('../../modules/quorum-crypto/src')`) — the site that surfaced this bug
in the first place — reached by all four `allowSync` tests in
`__tests__/configPublishOutcome.test.ts`.

### Instrument 2 — the kill-switch differential

Independent check, because a tracer that silently fails to fire looks exactly
like perfect isolation. The transform was disabled and the full suite re-run.

**MEASURED: with the transform off, 4 of 1030 tests fail. All four are the
`allowSync` tests in `configPublishOutcome.test.ts`. The other 1026 pass
unchanged.**

The two instruments agree exactly: one live site, one affected test file. That
agreement is the reason to believe either of them.

### So: was any other test passing because of the old error branch?

**No — and this is now measured rather than argued.** A test can only have been
affected if it walked a dynamic import, and 92 of 93 sites are never walked at
all. The one that is has four tests on it, and all four are branch-dependent:

- **Three** go red under a mutation that makes signature verification return
  `false` (i.e. hand-simulating the pre-fix error branch).
- **The fourth** (`re-reads the local value at the adopt site`) installs its own
  mock whose side effect only runs if the import resolved, so its assertion
  cannot pass unless the path was entered. It goes red under the kill-switch
  differential above, which is the stronger probe.

The one test that *was* passing for the wrong reason — the original draft control
arm — was caught and fixed before PR #252 landed, and now carries the explicit
`expect(mockVerifyEd448).toHaveBeenCalled()` reach assertion.

### What this does NOT say

Stated plainly, because "the audit came back clean" is exactly the kind of
sentence that gets over-read:

- **92 sites are uncovered, not proven safe.** The finding is that they cannot
  have been producing false greens, because no test walks them. Their production
  behaviour was never affected by this bug at all — Metro resolves `import()`
  normally in the shipped app.
- **The harness scenarios were not traced.** `jest.harness.config.js` drives real
  bots over a live transport, so it was out of scope for an offline measurement.
  The harness uses the same plugin via `babel.harness.js`, and the double-apply
  regression that broke it is now covered by a test.
- **Coverage is a floor, not a ceiling.** `yarn test:dyn-trace` reports what the
  suite walked on the day it ran. Re-run it after adding tests around any of the
  92.

## The guard

`__tests__/dynamicImportTransform.test.ts` — 5 tests. It cannot rely on "some
other test would notice", because MEASURED above: deleting the plugin turns
**no** other test red beyond the four already named, and would silently restore
the blind spot everywhere else.

The config assertions read the **emitted code** rather than running anything,
deliberately: the fault being guarded is one that running tests swallows.

Each assertion was proven falsifiable — three mutations, each turning exactly one
test red and leaving the rest green:

| Mutation | Test that went red | Tests that correctly stayed green |
|---|---|---|
| delete the plugin line from `babel.config.js` | lowers under `test`; plus both runtime tests | dev-env control arm, harness |
| remove the identity guard from `babel.harness.js` | applies exactly once through the harness | all others |
| apply the plugin in every env (`isTest \|\| true`) | CONTROL ARM — leaves `import()` alone under `development` | all others |

That third arm matters as much as the first: without it the guard passes just as
well if someone drops the `api.env('test')` condition and ships a jest-only
workaround into production, defeating Metro's code splitting.

## Verification

- [x] A probe test doing `await import('../modules/quorum-crypto/src')` threw
      before the fix and resolves to the jest mock after it
- [x] Emitted code inspected directly under `test` (rewritten), `development`
      (untouched) and via `babel.harness.js` (rewritten exactly once)
- [x] **Audit complete** — 1 of 93 call sites executes under the suite; the other
      92 never run, so none could have been producing a false green
- [x] **No test was passing because of the old error branch** — kill-switch
      differential: 4 of 1030 tests flip, all four in the one file that walks the
      one live site, and all four are branch-dependent
- [x] Regression guard added, with all 5 assertions proven falsifiable by
      mutation
- [x] Full suite: 111 suites / 1035 tests green (baseline on master 110 / 1030;
      this branch adds exactly the one new suite)
- [x] `npx tsc --noEmit`: 18 errors on this branch, 18 on master — zero added
- [x] `yarn lint`: no findings in any new or modified file

## Follow-ups worth doing, but not blocking this

- Trace the harness config the same way once a scenario can run offline.
- Any new test that walks one of the 92 sites should assert the path was
  *reached*, not just that the answer was right. That is the lesson this whole
  issue exists to record, and it does not generalise from a passing suite.

---

*Last updated: 2026-08-17*
