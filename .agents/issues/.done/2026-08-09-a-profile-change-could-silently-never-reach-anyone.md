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

The per-destination dedupe is unaffected: an unchanged payload still logs
`[ProfileSync] gate SKIPPED` per space, confirmed in the same run, so this did
not become "always send".

## Desktop

Not affected. `src/components/context/MessageDB.tsx` clears and re-sets its
profile timers on every socket event with no fingerprint guard in front, so it
always reschedules. Different structure, no lost work. No port needed.

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

---
*Last updated: 2026-08-09*
