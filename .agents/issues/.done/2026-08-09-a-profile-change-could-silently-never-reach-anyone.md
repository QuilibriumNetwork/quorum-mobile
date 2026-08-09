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

## What still isn't protected

**Nothing would catch a regression of this.** The "710 tests pass either way"
above is not a figure of speech: no test executes this effect. Of the three
suites that name `WebSocketContext`, two (`dmSelfEchoGuards`, `receiptWiring`)
read the file as *source text* and assert on unrelated regions, and the third
(`groupDeletionGuard`) mocks the module outright. Move the claim back above the
`setTimeout` and the suite stays green.

`primaryNameBroadcastSignature.test.ts` does **not** cover this. It guards the
sibling defect from the same branch — `primaryUsername` missing from the
*signature* — which is a different failure with the same symptom. Having it
green is easy to misread as this race being covered.

The cheap fix follows a convention the repo already uses. `receiptWiring.test.ts`
slices the source between two anchors and asserts ordering directly:

```ts
expect(body.indexOf('isReadAckTimestampValid')).toBeLessThan(body.indexOf('setQueryData'));
```

The same shape would pin this one: assert `lastProfileRebroadcastSigRef.current = sig`
appears **after** `setTimeout(` within the effect. That is the whole invariant,
and it is one assertion. Not done here — flagged rather than actioned, since the
issue was already closed.

## Where the fix currently lives

Commit `bec2980`, on branch `feat/verify-a-claimed-q-name-before-rendering-it`.
**Not on `master` as of this review** — anyone grepping `master` for the fix will
find the broken ordering and reasonably conclude the bug is still open. It lands
when that branch ships.

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
