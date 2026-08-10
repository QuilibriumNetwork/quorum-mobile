---
type: bug
title: "A profile change could silently never reach anyone, depending on a re-render race"
status: done
priority: high
created: 2026-08-09
updated: 2026-08-09
area: profile sync / identity broadcast
repos: quorum-mobile (desktop checked — not affected)
source: found 2026-08-09 while device-testing whether electing a primary .q name broadcasts; the primary-name case was the symptom, not the bug
---

# The broadcast marked itself done before doing anything

## Status

**Fixed and verified on device**, in the same branch as the `.q` verification
work. Desktop was checked and does not share the defect.

## What was wrong

The connect-time profile rebroadcast in `context/WebSocketContext.tsx` computed
a fingerprint of the broadcast-relevant fields, recorded it, and then set a 4
second timer to do the actual sending:

```
if (lastProfileRebroadcastSigRef.current === sig) return;
lastProfileRebroadcastSigRef.current = sig;   // ← claimed here
const t = setTimeout(async () => { …broadcast… }, 4000);
return () => clearTimeout(t);                 // ← cancelled on any re-run
```

Any re-render inside those 4 seconds ran the cleanup, cancelling the pending
broadcast. The effect then re-ran, found the fingerprint already recorded, and
returned early — so **nothing rescheduled the work**. The change was lost, with
no error and nothing to retry.

The effect re-runs every few seconds in ordinary use, so the window usually did
not survive.

## Why it went unnoticed for so long

**It presents as a coin flip, and the obvious test wins it.** On a fresh launch
the ref starts empty, and if no re-render happens to land in the window, the
broadcast fires normally. So "restart the app and check" passes. Only a change
made while the app is already running reliably loses.

Measured on device, electing a primary name in-session:

```
17:18:38.196  sigChanged=true    fingerprint recorded, timer set
17:18:39.500  sigChanged=false   re-render 1.3s later; timer cleared, early
                                 return, work silently lost
```

And after the fix, the same action:

```
17:22:30.606  sigChanged=true    elected
17:22:34.309  sigChanged=true    re-render — still true, so it RESCHEDULES
17:22:39.642  [ProfileSync] broadcast sent x4
17:22:43.478  [DMProfileSync] broadcast to 4/4 partner(s)
```

## Scope — this was never only about `.q` names

The fingerprint covers `displayName`, `userIcon`, the Farcaster pair and (since
this branch) `primaryUsername`. So **a rename or an avatar change could equally
fail to reach spacemates**, leaving them rendering the old identity
indefinitely. That is the same class of complaint as "my new name did not show
up for other people", so any past report of that shape is plausibly explained by
this rather than by whatever it was attributed to at the time. Worth keeping in
mind before re-investigating one from scratch.

## The fix

Claim the fingerprint **inside** the timer callback rather than before it. A
cancelled attempt then leaves no trace, so the next run still sees a changed
fingerprint and schedules again. Churn defers the broadcast instead of
destroying it — which is what the stagger was for.

Located in `context/WebSocketContext.tsx`: the guard reads at `:6570`, the claim
now happens at `:6593` inside the `setTimeout` body, and the cleanup that made
this matter is the `clearTimeout` at `:6694`. The failure path at `:6690` also
resets the fingerprint to `null`, so a thrown import/lookup retries on the next
dep change instead of recording a failed attempt as canonical.

The per-destination dedupe is unaffected: an unchanged payload still logs
`[ProfileSync] gate SKIPPED` per space, confirmed in the same run, so this did
not become "always send".

## Desktop

Not affected, and the reason is worth stating precisely because the first
reading of it was wrong in an instructive way.

It is **not** that desktop has no signature gate. It has one:
`dmProfileSignature` / `shouldSendDmProfile` / `claimDmProfileSend` /
`recordDmProfileSend` in `src/utils/dmProfileGate.ts:121-155`, called from
`src/services/MessageService.ts:714-728`. What differs is **where it is
claimed**.
Desktop claims it *inside the deferred send*, only once the timer has actually
fired — which is exactly the shape this fix moved mobile to.

The scheduling site (`MessageDB.tsx:625-638`, on `ws.onopen` reconnect rather
than on every socket event) is an unconditional `clearTimeout(prev)` immediately
followed by `setTimeout(next)` in the same synchronous block. There is no tick
where a clear happens without an accompanying reschedule, and a cancelled timer
never reaches the gate, so it leaves no "already sent" marker to short-circuit
the next attempt. No lost work, no port needed.

So desktop is not a different-and-luckier structure; it is the correct structure,
and mobile was the deviation.

## The generalisable mistake

**Do not record "this work is done" before the work is cancellable-and-pending.**
A guard that suppresses reruns must be claimed at the point the work actually
commits, or a cancellation turns the guard into a permanent block. The tell is a
`useEffect` whose cleanup cancels the very work its own guard prevents
rescheduling.

## How it was found, which matters for the next one

Neither reading nor the test suite caught it — 710 tests pass either way. It
took an instrument: a filtered `adb logcat` capture started BEFORE the action,
plus a temporary three-way diagnostic log distinguishing "effect never ran" from
"fingerprint missed the change" from "timer was cancelled". See
`.agents/scripts/qlog.sh`; Metro's own output is unreadable by eye and the
device log buffer holds roughly forty seconds of this app's output, so both
casual routes lose the evidence before anyone looks.

## How this is protected now

It was unprotected when this file was first written: "710 tests pass either way"
was literal, because no test executed the effect. Of the three suites naming
`WebSocketContext`, two (`dmSelfEchoGuards`, `receiptWiring`) read the file as
*source text* and assert on unrelated regions, and the third
(`groupDeletionGuard`) mocks the module outright.

`__tests__/profileRebroadcastClaimOrdering.test.ts` now pins it, following the
source-slicing convention `receiptWiring.test.ts` already uses. Five assertions:
the claim sits **after** `setTimeout(`; the early return on an unchanged
fingerprint still exists **before** it (so the fix cannot be "achieved" by
deleting the dedupe and always sending); the failure path still resets the
fingerprint to `null`; and `primaryUsername` remains in both the fingerprint and
the dep array.

**It was verified by reverting.** Moving the claim back above the `setTimeout`
turns the ordering assertion red — and only that one, the other four stay green,
so it is sensitive to this specific ordering rather than to something incidental.
That check is the point; an assertion that passes either way would have been
worse than nothing here, given this bug shipped past a green suite once already.

Note `primaryNameBroadcastSignature.test.ts` does **not** cover this race. It
guards the sibling defect from the same branch — `primaryUsername` missing from
the *signature* — a different failure with the same symptom. Its greenness is
easy to misread as coverage for this.

**Known limitation:** a source-text test pins the shipped *shape*, not the
runtime behaviour. Refactoring the effect (extracting it into a hook, renaming
the ref) will break it for reasons that are not regressions. When that happens
the anchors need updating, not the test deleting — the invariant it encodes is
still real.

## Where the fix lives

Shipped to `master` in `e93cd26` (PR #245), squashed from `bec2980` on
`feat/verify-a-claimed-q-name-before-rendering-it`. The original hash will not
appear on `master` because the merge was a squash.

---
*Last updated: 2026-08-09*

## Review Log
**2026-08-09 - claude-opus-5**: First review pass. Verified the fix against the code rather than the prose: claim-inside-timer is genuinely present, 710 tests pass, no type errors in the touched files. Left status done and the file in .done/. Corrected one wrong technical claim, added anchors, and recorded a coverage gap the write-up implied but did not state.
- Desktop reasoning was wrong in substance though right in verdict: the write-up said MessageDB.tsx has 'no fingerprint guard'. It does have one (shouldSendDmProfile/claimDmProfileSend/recordDmProfileSend, src/utils/dmProfileGate.ts:121-155, called from src/services/MessageService.ts:714-728) — it is simply claimed INSIDE the deferred send, which is the same shape mobile moved to. Rewrote the section: desktop is the correct structure, not a luckier one. Also corrected 'on every socket event' to ws.onopen reconnect.
- Verified the 'tests pass either way' claim by construction rather than assuming it: no test executes the effect. dmSelfEchoGuards and receiptWiring read WebSocketContext.tsx as source text and assert on unrelated regions; groupDeletionGuard mocks the module. Reverting the fix would leave the suite green.
- primaryNameBroadcastSignature.test.ts covers the SIBLING bug (primaryUsername absent from the signature), not this race. Its greenness is easy to misread as coverage. Said so explicitly in a new 'What still isn't protected' section.
- Proposed a concrete regression test using a convention already in the repo — receiptWiring.test.ts line 58 does an indexOf ordering assertion; the same shape pins claim-after-setTimeout in one assertion. Flagged, not actioned, since the issue was already closed.
- Added file:line anchors for the fix (WebSocketContext.tsx guard :6570, claim :6593, cleanup :6694, failure-path reset :6690).
- Recorded that the fix is only on branch feat/verify-a-claimed-q-name-before-rendering-it (commit bec2980), NOT on master — a reader grepping master finds the broken ordering and would think the bug is open.
- Did not touch: frontmatter (type/status/folder already agree), the What was wrong account, or the on-device measurements.

**2026-08-10 - claude-opus-5**: Second pass: actioned the regression-test gap the first pass only flagged. Status stays done; the fix itself was already shipped in e93cd26.
- Added __tests__/profileRebroadcastClaimOrdering.test.ts — 5 assertions pinning the claim-after-setTimeout ordering, the surviving early-return dedupe, the failure-path reset, and primaryUsername in both fingerprint and dep array. Follows the source-slicing convention from receiptWiring.test.ts.
- VERIFIED BY REVERTING, not by reading: moved the claim back above the setTimeout and the ordering assertion went red (claim index 1348 vs timer 1409), while the other four stayed green. Restored the file via git checkout and re-confirmed the claim is back at :6593. Suite is 715 passed / 56 suites, up from 710 / 55. Lint clean on the new file.
- Rewrote the 'What still isn't protected' section, which my own first pass had left factually stale the moment the test landed. It now records what protects this, that it was red/green verified, and the honest limitation: a source-text test pins the shipped shape, so a legitimate refactor breaks it and the anchors should be updated rather than the test deleted.
- Corrected the branch note from the first pass: the fix IS on master, as squash commit e93cd26 (PR #245). The first pass reported it as unmerged, which was true at the time but read as a standing fact.
- Did not touch the What was wrong account, the on-device measurements, or the frontmatter.
