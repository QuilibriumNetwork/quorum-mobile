---
type: bug
title: "Every `await import(...)` silently took its error branch under jest, so tests walking those paths were green for the wrong reason"
status: open
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
> The mechanism and the counts below are **MEASURED** on 2026-08-17. The
> per-call-site impact is **not** assessed — see "What still needs doing".

## Status

**2026-08-17 — the mechanism is fixed, shipped in PR #252**
(`feat(config): report sync failures, and make turning sync off stick`).

What landed: `jest/babel-plugin-dynamic-import-to-require.js`, wired into
`babel.config.js` for the test environment only and reused by
`dev/harness/babel.harness.js` through an identity guard, so it cannot be applied
twice. Verified by inspecting the emitted code under both `test` and
`development` rather than by running tests, which would have swallowed the
fault — see the sequel below.

**Still open, and the reason this is not in `.done/`: the other 63 call sites are
unaudited.** Turning the transform on makes those paths reachable; it does not
make them covered. That is a real remaining criterion, not a formality — each one
is a branch that has never executed under test.

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

**MEASURED**: 64 `await import(...)` call sites across 29 files in
`app/ components/ context/ hooks/ services/ modules/ utils/`. Roughly 24 sit
inside a `try`/`catch` (crude heuristic: a `try {` within the 20 lines above), so
those are the ones that fail silently. The remainder throw, which at least fails
loudly — but only if a test actually walks them.

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

Consolidated to one implementation, with an identity guard in `babel.harness.js`,
verified by inspecting the emitted code under both `test` and `development`
rather than by running tests that would have swallowed the fault.

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

**Measured safe**: the full suite was 999 passing across 107 files before the
change and 999 of the same tests after it, with no test changing result. So
nothing was silently depending on the old broken behaviour.

## What still needs doing

- [ ] **Audit the other 63 call sites.** Each one is a path that has never been
      exercised in a test, and some now become reachable for the first time.
      Turning the transform on does not add coverage by itself — it only makes
      coverage *possible*. The most likely finds are in `services/` (10 files)
      and `components/` (8 files).
- [ ] Check whether any existing test was passing *because* of the old error
      branch, in the same shape as the control arm above. The full suite going
      green after the change is evidence there is no crash, **not** evidence that
      every test still asserts what it claims to.
- [ ] Consider a lint rule or a test that fails if `babel.config.js` loses the
      test-env plugin. Silent reintroduction would restore the blind spot with no
      symptom.

## Verification

- [x] A probe test doing `await import('../modules/quorum-crypto/src')` threw
      before the fix and resolves to the jest mock after it
- [x] Full suite unchanged: 107 suites / 999 tests green before and after
- [ ] The audit above

---

*Last updated: 2026-08-17*
